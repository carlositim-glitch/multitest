const {onRequest} = require("firebase-functions/v2/https");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Configuración global
setGlobalOptions({region: "europe-west6"});

// ⚠️ CAMBIA ESTO POR TU CLAVE REAL
const stripeSecret = "sk_live_51SVCbM....";
const webhookSecret = "whsec_TICnJjVXFYJNiJeVz5Rcc3W6dr8e6fbD";
const stripe = new Stripe(stripeSecret, {apiVersion: "2023-10-16"});

// ============================================================
// FUNCIÓN PRINCIPAL: CREAR CHECKOUT SESSION
// ============================================================
exports.crearCheckoutSession = onCall({region: "europe-west6"}, async (request) => {
  console.log("🔍 INICIO - Request completo:", JSON.stringify(request.data));
  
  try {
    if (!request.auth) {
      console.error("❌ No hay auth");
      throw new Error("Usuario no autenticado");
    }
    
    console.log("✅ Usuario autenticado:", request.auth.uid);
    
    const {priceId, testId, testNombre} = request.data;
    
    if (!priceId || !testId || !testNombre) {
      console.error("❌ Faltan datos:", {priceId, testId, testNombre});
      throw new Error("Faltan datos requeridos");
    }
    
    console.log("✅ Datos validados");
    
    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;
    
    console.log("🚀 Intentando crear sesión Stripe...");
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{price: priceId, quantity: 1}],
      mode: "subscription",
      success_url: `https://multitest-gobcan.web.app/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://multitest-gobcan.web.app/?payment=cancelled`,
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {
        userId, 
        testId, 
        testNombre
      },
      subscription_data: {
        metadata: {
          userId, 
          testId, 
          testNombre
        },
      },
    });
    
    console.log("✅ Sesión creada:", session.id);
// GUARDAR EN FIRESTORE
await db.collection('checkoutSessions').doc(session.id).set({
  userId,
  testId,
  testNombre,
  priceId,
  createdAt: admin.firestore.FieldValue.serverTimestamp()
});
    return {sessionId: session.id};
    
  } catch (error) {
    console.error("❌ ERROR COMPLETO:", error);
    console.error("❌ Error message:", error.message);
    console.error("❌ Error stack:", error.stack);
throw new HttpsError('internal', error.message);
  }
});
// ============================================================
// FUNCIÓN: VERIFICAR PAGO (LLAMADA DESDE FRONTEND)
// ============================================================
exports.verificarPago = onCall({region: "europe-west6"}, async (request) => {
  try {
    if (!request.auth) {
      throw new Error("Usuario no autenticado");
    }

    const {sessionId} = request.data;
    if (!sessionId) {
      throw new Error("Session ID requerido");
    }

    console.log("🔍 Verificando pago:", sessionId);

    // Recuperar sesión de Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Verificar que el pago fue completado
    if (session.payment_status !== "paid") {
      throw new Error("Pago no completado");
    }

    // Verificar que la sesión pertenece al usuario
    if (session.client_reference_id !== request.auth.uid) {
      throw new Error("Sesión no válida para este usuario");
    }

    // Obtener datos de la sesión guardada
    const sessionDoc = await db.collection("checkoutSessions").doc(sessionId).get();
    if (!sessionDoc.exists) {
      throw new Error("Sesión no encontrada en BD");
    }

    const sessionData = sessionDoc.data();
    const {userId, testId, testNombre} = sessionData;

    // Determinar plan según monto
    let plan = "mensual";
    const amount = session.amount_total / 100; // Stripe usa centavos
    if (amount === 24.99) plan = "trimestral";
    else if (amount === 79.99) plan = "anual";

    // Activar suscripción en Firestore
    await db.collection("suscripciones").doc(userId).set({
      email: session.customer_email,
      [testId]: {
        plan: plan,
        tandasUsadas: 0,
        fechaActivacion: Date.now(),
        nombre: testNombre,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        stripeSessionId: sessionId,
        status: "active",
      },
    }, {merge: true});

    // Actualizar estado de la sesión
    await db.collection("checkoutSessions").doc(sessionId).update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Suscripción activada: ${plan} para ${userId} en ${testId}`);

    return {
      success: true,
      plan: plan,
      categoria: testNombre,
    };

  } catch (error) {
    console.error("❌ Error verificando pago:", error);
    throw new Error(`Error verificando pago: ${error.message}`);
  }
});

// ============================================================
// WEBHOOK (OPCIONAL - BACKUP)
// ============================================================
exports.stripeWebhook = onRequest({region: "europe-west6"}, async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    
    console.log("📥 Webhook recibido:", event.type);
    
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      
      // Buscar datos de la sesión
console.log('🔍 Buscando sesión:', session.id);
const sessionDoc = await db.collection("checkoutSessions").doc(session.id).get();
if (!sessionDoc.exists) {
  console.error("❌ Sesión no encontrada:", session.id);
  return res.status(200).json({received: true});
}
console.log('✅ Sesión encontrada');
      const sessionData = sessionDoc.data();
      const {userId, testId, testNombre} = sessionData;

      let plan = "mensual";
      const amount = session.amount_total / 100;
      if (amount === 24.99) plan = "trimestral";
      else if (amount === 79.99) plan = "anual";

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

      console.log(`🎉 Webhook: Plan ${plan} activado para ${userId}`);
    }
    
    res.status(200).json({received: true});
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.status(400).send(error.message);
  }
});
