const {onRequest} = require("firebase-functions/v2/https");
const {onCall} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Configuración global
setGlobalOptions({region: "europe-west6"});

// Configuración de Stripe
const stripeSecret = "sk_test_51SVCbvRsnNtATP9UsIsmPE1DGDf07o9s5AxiAmPHvDEBqIambTGgGSQ2WZBFiQOfRmdEOYjjEQBM2eGjrqk2p9oi00ceZ230ME";
const webhookSecret = "whsec_BDwYH4sRdQEDeoTIQ1KvVrT9PNeje87i";
const stripe = new Stripe(stripeSecret, {apiVersion: "2022-11-15"});

// ✅ CREAR APP EXPRESS
const app = express();

// ✅ WEBHOOK RAW BODY - PROMISE PARA GARANTIZAR TIMING
app.use('/webhook', (req, res, next) => {
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  } else {
    next();
  }
});

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  try {
    console.log("🔄 Webhook iniciando...");
    
    if (!req.rawBody) {
      console.error("❌ No hay rawBody disponible");
      return res.status(400).send("No raw body");
    }
    
    // Usar req.rawBody que contiene el buffer raw
    const event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    console.log("✅ Webhook recibido:", event.type);

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "invoice.payment_succeeded":
        await handlePaymentSucceeded(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log("🔔 Evento no manejado:", event.type);
    }

    console.log("✅ Webhook procesado exitosamente");
    res.status(200).json({received: true});
    
  } catch (error) {
    console.error("❌ Error en webhook:", error.message);
    res.status(400).send("Webhook Error: " + error.message);
  }
});

// ✅ MIDDLEWARE JSON PARA OTRAS RUTAS
app.use(express.json());

// ✅ OTRAS RUTAS
app.get("/", (req, res) => {
  res.json({message: "✅ API funcionando con v2!"});
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    const {amount, currency} = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || "eur",
      automatic_payment_methods: {enabled: true},
    });
    res.json({
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id,
    });
  } catch (error) {
    res.status(400).json({error: error.message});
  }
});

// ==================== FUNCIONES AUXILIARES ====================
async function handleCheckoutCompleted(session) {
  try {
    console.log("✅ Checkout completado para sesión:", session.id);

    const sessionDoc = await db.collection("checkout_sessions").doc(session.id).get();
    if (!sessionDoc.exists) {
      console.error("❌ No se encontró información de la sesión:", session.id);
      return;
    }

    const sessionData = sessionDoc.data();
    const {userId, testId, testNombre} = sessionData;

    let plan = "mensual";
    if (session.amount_total === 2499) plan = "trimestral";
    else if (session.amount_total === 7999) plan = "anual";

    await db.collection("suscripciones").doc(userId).set({
      email: session.customer_email,
      [testId]: {
        plan: plan,
        tandasUsadas: 0,
        fechaActivacion: Date.now(),
        nombre: testNombre,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: "active",
      },
    }, {merge: true});

    await db.collection("checkout_sessions").doc(session.id).update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
    });

    console.log(`🎉 Suscripción ${plan} activada para usuario ${userId} en test ${testId}`);
  } catch (error) {
    console.error("❌ Error manejando checkout completado:", error);
    throw error; // Re-throw para que Stripe sepa que falló
  }
}

async function handlePaymentSucceeded(invoice) {
  try {
    console.log("💳 Pago exitoso para factura:", invoice.id);
    // Aquí podrías renovar la suscripción si es necesario
  } catch (error) {
    console.error("❌ Error manejando pago exitoso:", error);
    throw error;
  }
}

async function handleSubscriptionDeleted(subscription) {
  try {
    console.log("❌ Suscripción cancelada:", subscription.id);
    const sessionsQuery = await db.collection("checkout_sessions")
        .where("stripeSubscriptionId", "==", subscription.id)
        .limit(1)
        .get();

    if (!sessionsQuery.empty) {
      const sessionData = sessionsQuery.docs[0].data();
      const {userId, testId} = sessionData;

      await db.collection("suscripciones").doc(userId).set({
        [testId]: {
          status: "cancelled",
          plan: "none",
          cancelledAt: Date.now(),
        },
      }, {merge: true});

      console.log(`🚫 Suscripción cancelada para usuario ${userId} en test ${testId}`);
    }
  } catch (error) {
    console.error("❌ Error manejando cancelación de suscripción:", error);
    throw error;
  }
}

// ==================== FUNCIÓN CALLABLE ====================
exports.crearCheckoutSession = onCall({region: "europe-west6"}, async (request) => {
  try {
    if (!request.auth) {
      throw new Error("Usuario no autenticado");
    }

    const {priceId, testId, testNombre} = request.data;
    if (!priceId || !testId || !testNombre) {
      throw new Error("Faltan datos requeridos: priceId, testId, testNombre");
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;

    console.log("🚀 Creando sesión de checkout para:", {userId, userEmail, priceId, testId, testNombre});

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{price: priceId, quantity: 1}],
      mode: "subscription",
      success_url: `https://multitest-gobcan.web.app/success.html?session_id={CHECKOUT_SESSION_ID}&test_id=${testId}`,
      cancel_url: `https://multitest-gobcan.web.app/cancel.html?test_id=${testId}`,
      customer_email: userEmail,
      metadata: {userId: userId, testId: testId, testNombre: testNombre},
      subscription_data: {
        metadata: {userId: userId, testId: testId, testNombre: testNombre},
      },
    });

    console.log("✅ Sesión de Stripe creada:", session.id);

    await db.collection("checkout_sessions").doc(session.id).set({
      userId: userId,
      userEmail: userEmail,
      testId: testId,
      testNombre: testNombre,
      priceId: priceId,
      sessionId: session.id,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {sessionId: session.id, success: true};
  } catch (error) {
    console.error("❌ Error creando sesión de checkout:", error);
    throw new Error(`Error interno: ${error.message}`);
  }
});

exports.api = onRequest({region: "europe-west6"}, app);
