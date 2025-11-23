const {onRequest} = require("firebase-functions/v2/https");
const {onCall} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Configuración global
setGlobalOptions({region: "europe-west6"});

// Configuración de Stripe
const stripeSecret = "sk_test_51SVCbvRsnNtATP9UsIsmPE1DGDf07o9s5AxiAmPHvDEBqIambTGgGSQ2WZBFiQOfRmdEOYjjEQBM2eGjrqk2p9oi00ceZ230ME";
const webhookSecret = "whsec_BDwYH4sRdQEDeoTIQ1KvVrT9PNeje87i";
const stripe = new Stripe(stripeSecret, {apiVersion: "2022-11-15"});

// ✅ WEBHOOK SÚPER SIMPLE - 5 LÍNEAS ÚTILES
exports.stripeWebhook = onRequest({region: "europe-west6"}, async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    
    console.log("🎯 Webhook recibido:", event.type);
    
    if (event.type === "checkout.session.completed") {
      await procesarPago(event.data.object);
    }
    
    res.status(200).json({received: true});
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.status(400).send(error.message);
  }
});

// ✅ FUNCIÓN QUE PROCESA EL PAGO
async function procesarPago(session) {
  try {
    console.log("💰 Procesando pago para sesión:", session.id);

    const sessionDoc = await db.collection("checkout_sessions").doc(session.id).get();
    if (!sessionDoc.exists) {
      console.error("❌ No se encontró checkout_session:", session.id);
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

    console.log(`🎉 ÉXITO: Plan ${plan} activado para usuario ${userId} test ${testId}`);
  } catch (error) {
    console.error("❌ Error procesando pago:", error);
    throw error;
  }
}

// ✅ FUNCIÓN CALLABLE PARA CREAR CHECKOUT (SIN CAMBIOS)
exports.crearCheckoutSession = onCall({region: "europe-west6"}, async (request) => {
  try {
    if (!request.auth) {
      throw new Error("Usuario no autenticado");
    }

    const {priceId, testId, testNombre} = request.data;
    if (!priceId || !testId || !testNombre) {
      throw new Error("Faltan datos requeridos");
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;

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
    console.error("❌ Error creando checkout:", error);
    throw new Error(`Error: ${error.message}`);
  }
});
