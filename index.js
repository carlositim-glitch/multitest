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
const stripeSecret = process.env.STRIPE_SECRET || ""; // ⚠️ Agrega tu clave
const webhookSecret = ""; // ⚠️ Usa el secret que te dio Stripe CLI
const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });

// ✅ MIDDLEWARE PARA RUTAS NORMALES (EXCEPTO WEBHOOK)
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    next(); // Skip JSON parsing for webhook
  } else {
    express.json()(req, res, next);
  }
});

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

// ✅ WEBHOOK ENDPOINT CON RAW BODY
app.post("/webhook", express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  
  try {
    // Verificar el webhook ✅ AHORA req.body ES RAW
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    
    console.log("✅ Webhook recibido:", event.type);
    
    // Manejar diferentes tipos de eventos
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object;
        console.log("💰 Pago exitoso:", paymentIntent.id);
        break;
        
      case "payment_intent.payment_failed":
        const failedPayment = event.data.object;
        console.log("❌ Pago fallido:", failedPayment.id);
        break;
        
      default:
        console.log(`🔔 Evento: ${event.type}`);
    }
    
    res.json({ received: true });
    
  } catch (error) {
    console.log(`❌ Error en webhook: ${error.message}`);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// ✅ EXPORTAR FUNCIONES
exports.api = onRequest(app);
