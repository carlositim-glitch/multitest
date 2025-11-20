const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const Stripe = require("stripe");

admin.initializeApp();
const app = express();

// Configuración global
setGlobalOptions({ region: "europe-west6" });

// Configuración de Stripe
const stripeSecret = process.env.STRIPE_SECRET || "";
const webhookSecret = process.env.STRIPE_WEBHOOK || "";
const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });

app.use(express.json());

// ✅ RUTA DE PRUEBA
app.get("/", (req, res) => {
  res.json({ message: "✅ API funcionando con v2!" });
});

// ✅ CREATE PAYMENT INTENT
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || "usd",
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({ 
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ✅ WEBHOOK ENDPOINT
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  
  try {
    // Verificar el webhook
    const event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    
    console.log("✅ Webhook recibido:", event.type);
    
    // Manejar diferentes tipos de eventos
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object;
        console.log("💰 Pago exitoso:", paymentIntent.id);
        // Aquí actualizas tu base de datos
        break;
        
      case "payment_intent.payment_failed":
        const failedPayment = event.data.object;
        console.log("❌ Pago fallido:", failedPayment.id);
        break;
        
      default:
        console.log(`🔔 Evento no manejado: ${event.type}`);
    }
    
    res.json({ received: true });
    
  } catch (error) {
    console.log(`❌ Error en webhook: ${error.message}`);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// ✅ IMPORTANTE: Para webhooks necesitamos raw body
app.use("/webhook", express.raw({ type: "application/json" }));

// ✅ EXPORTAR FUNCIONES
exports.api = onRequest(app);
