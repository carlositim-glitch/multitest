const {onRequest} = require("firebase-functions/v2/https");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ✅ Configuración global - NO TOCAR
setGlobalOptions({region: "europe-west6"});

// ⚠️ TODO: Mover a variables de entorno
const stripeSecret = process.env.STRIPE_SECRET_KEY || "sk_live_51SVCbM...";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_TICnJjVXFYJNiJeVz5Rcc3W6dr8e6fbD";
const stripe = new Stripe(stripeSecret, {apiVersion: "2023-10-16"});

// ✅ Mapeo centralizado de precios
const PRICE_TO_PLAN = {
  "price_1SVEbuRtyqAYsH2HaPpWMASN": "mensual",
  "price_1SWu42RsnNtATP9UPeHj3GxP": "trimestral",
  "price_1SWu4uRsnNtATP9UP3YCCjvK": "anual"
};

// ============================================================
// CREAR CHECKOUT SESSION
// ============================================================
exports.crearCheckoutSession = onCall({region: "europe-west6"}, async (request) => {
  console.log("🔍 crearCheckoutSession - Data:", JSON.stringify(request.data));
  
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Usuario no autenticado");
    }
    
    const {priceId, testId, testNombre} = request.data;
    
    if (!priceId || !testId || !testNombre) {
      throw new HttpsError("invalid-argument", "Faltan datos requeridos");
    }
    
    if (!PRICE_TO_PLAN[priceId]) {
      throw new HttpsError("invalid-argument", `PriceId no válido: ${priceId}`);
    }
    
    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;
    
    console.log(`✅ Creando sesión - Usuario: ${userId}, Plan: ${PRICE_TO_PLAN[priceId]}`);
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{price: priceId, quantity: 1}],
      mode: "subscription",
      success_url: `https://multitest-gobcan.web.app/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://multitest-gobcan.web.app/?payment=cancelled`,
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {userId, testId, testNombre, priceId},
      subscription_data: {
        metadata: {userId, testId, testNombre, priceId}
      }
    });
    
    console.log("✅ Sesión Stripe creada:", session.id);
    
    await db.collection("checkoutSessions").doc(session.id).set({
      userId,
      testId,
      testNombre,
      priceId,
      plan: PRICE_TO_PLAN[priceId],
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return {sessionId: session.id};
    
  } catch (error) {
    console.error("❌ ERROR:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message);
  }
});

// ============================================================
// VERIFICAR PAGO
// ============================================================
exports.verificarPago = onCall({region: "europe-west6"}, async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Usuario no autenticado");
    }

    const {sessionId} = request.data;
    if (!sessionId) {
      throw new HttpsError("invalid-argument", "Session ID requerido");
    }

    console.log(`🔍 Verificando: ${sessionId} - Usuario: ${request.auth.uid}`);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      throw new HttpsError("failed-precondition", "Pago no completado");
    }

    if (session.client_reference_id !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Sesión no válida");
    }

    const sessionDoc = await db.collection("checkoutSessions").doc(sessionId).get();
    if (!sessionDoc.exists) {
      throw new HttpsError("not-found", "Sesión no encontrada");
    }

    const sessionData = sessionDoc.data();
    
    if (sessionData.status === "completed") {
      console.log("ℹ️ Ya procesada");
      return {success: true, plan: sessionData.plan, categoria: sessionData.testNombre};
    }

    const {userId, testId, testNombre, plan} = sessionData;

    await db.collection("suscripciones").doc(userId).set({
      email: session.customer_email || request.auth.token.email,
      [testId]: {
        plan,
        tandasUsadas: 0,
        fechaActivacion: Date.now(),
        nombre: testNombre,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: "active",
        activatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, {merge: true});

    await db.collection("checkoutSessions").doc(sessionId).update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Activado: ${plan} para ${userId}`);

    return {success: true, plan, categoria: testNombre};

  } catch (error) {
    console.error("❌ ERROR:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message);
  }
});

// ============================================================
// WEBHOOK
// ============================================================
exports.stripeWebhook = onRequest({region: "europe-west6"}, async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    let event;
    
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      console.error("❌ Firma inválida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log("📥 Webhook:", event.type);
    
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      
      if (session.payment_status !== "paid") {
        console.warn("⚠️ Pago no completado");
        return res.status(200).json({received: true});
      }
      
      const sessionDoc = await db.collection("checkoutSessions").doc(session.id).get();
      if (!sessionDoc.exists) {
        console.error("❌ Sesión no encontrada");
        return res.status(200).json({received: true});
      }
      
      const sessionData = sessionDoc.data();
      if (sessionData.status === "completed") {
        console.log("ℹ️ Ya procesada");
        return res.status(200).json({received: true});
      }
      
      const {userId, testId, testNombre, plan} = sessionData;

      await db.collection("suscripciones").doc(userId).set({
        email: session.customer_email,
        [testId]: {
          plan,
          tandasUsadas: 0,
          fechaActivacion: Date.now(),
          nombre: testNombre,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          status: "active",
          activatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, {merge: true});

      await db.collection("checkoutSessions").doc(session.id).update({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Webhook activó: ${plan} para ${userId}`);
    }
    
    return res.status(200).json({received: true});
    
  } catch (error) {
    console.error("❌ Webhook error:", error);
    return res.status(500).json({error: error.message});
  }
});
