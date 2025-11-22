const { onRequest } = require("firebase-functions/v2/https");
const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();
const app = express();

// Configuración global
setGlobalOptions({ region: "europe-west6" });

// Configuración de Stripe
const stripeSecret = process.env.STRIPE_SECRET || ""; // ⚠️ Agrega tu clave secreta aquí
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_"; // ⚠️ Agrega tu webhook secret
const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });

// ==================== FUNCIÓN CALLABLE PARA EL FRONTEND ====================
// ✅ ESTA ES LA QUE NECESITA TU FRONTEND
exports.crearSesionCheckout = onCall({ region: "europe-west6" }, async (request) => {
  try {
    // Verificar autenticación
    if (!request.auth) {
      throw new Error('Usuario no autenticado');
    }

    const { priceId, testId, testNombre } = request.data;
    
    if (!priceId || !testId || !testNombre) {
      throw new Error('Faltan datos requeridos: priceId, testId, testNombre');
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;

    console.log('🚀 Creando sesión de checkout para:', { userId, userEmail, priceId, testId, testNombre });

    // Crear la sesión de Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription', // Para suscripciones recurrentes
      success_url: `https://multitest-gobcan.web.app/success.html?session_id={CHECKOUT_SESSION_ID}&test_id=${testId}`,
      cancel_url: `https://multitest-gobcan.web.app/cancel.html?test_id=${testId}`,
      customer_email: userEmail,
      metadata: {
        userId: userId,
        testId: testId,
        testNombre: testNombre
      },
      subscription_data: {
        metadata: {
          userId: userId,
          testId: testId,
          testNombre: testNombre
        }
      }
    });

    console.log('✅ Sesión de Stripe creada:', session.id);

    // Guardar información de la sesión en Firestore
    await db.collection('checkout_sessions').doc(session.id).set({
      userId: userId,
      userEmail: userEmail,
      testId: testId,
      testNombre: testNombre,
      priceId: priceId,
      sessionId: session.id,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      sessionId: session.id,
      success: true
    };

  } catch (error) {
    console.error('❌ Error creando sesión de checkout:', error);
    throw new Error(`Error interno: ${error.message}`);
  }
});

// ==================== API REST (TU CÓDIGO ORIGINAL MEJORADO) ====================

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

// ✅ CREATE PAYMENT INTENT (TU CÓDIGO ORIGINAL)
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || "eur", // Cambiado a EUR para España
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

// ✅ WEBHOOK ENDPOINT MEJORADO
app.post("/webhook", express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  
  try {
    // Verificar el webhook
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    
    console.log("✅ Webhook recibido:", event.type);
    
    // Manejar diferentes tipos de eventos
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
        
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object;
        console.log("💰 Pago exitoso:", paymentIntent.id);
        break;
        
      case "payment_intent.payment_failed":
        const failedPayment = event.data.object;
        console.log("❌ Pago fallido:", failedPayment.id);
        break;
        
      default:
        console.log("🔔 Evento:", event.type);
    }
    
    res.json({ received: true });
    
  } catch (error) {
    console.log("❌ Error en webhook:", error.message);
    res.status(400).send("Webhook Error: " + error.message);
  }
});

// ==================== FUNCIONES AUXILIARES PARA WEBHOOKS ====================

// Manejar checkout completado (suscripciones)
async function handleCheckoutCompleted(session) {
  try {
    console.log('✅ Checkout completado para sesión:', session.id);

    const sessionDoc = await db.collection('checkout_sessions').doc(session.id).get();
    
    if (!sessionDoc.exists) {
      console.error('❌ No se encontró información de la sesión:', session.id);
      return;
    }

    const sessionData = sessionDoc.data();
    const { userId, testId, testNombre } = sessionData;

    // Determinar el plan basado en el precio
    let plan = 'mensual'; // default
    if (session.amount_total === 2499) plan = 'trimestral'; // 24.99€
    else if (session.amount_total === 7999) plan = 'anual'; // 79.99€

    // Actualizar suscripción del usuario
    await db.collection('suscripciones').doc(userId).set({
      email: session.customer_email,
      [testId]: {
        plan: plan,
        tandasUsadas: 0,
        fechaActivacion: Date.now(),
        nombre: testNombre,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: 'active'
      }
    }, { merge: true });

    // Actualizar estado de la sesión
    await db.collection('checkout_sessions').doc(session.id).update({
      status: 'completed',
      
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription
    });

    console.log(`🎉 Suscripción ${plan} activada para usuario ${userId} en test ${testId}`);

  } catch (error) {
    console.error('❌ Error manejando checkout completado:', error);
  }
}

// Manejar pago exitoso (renovaciones)
async function handlePaymentSucceeded(invoice) {
  try {
    console.log('💳 Pago exitoso para factura:', invoice.id);
    
    // Aquí puedes manejar renovaciones de suscripción si es necesario
    // Por ahora solo loggeamos
    
  } catch (error) {
    console.error('❌ Error manejando pago exitoso:', error);
  }
}

// Manejar suscripción cancelada
async function handleSubscriptionDeleted(subscription) {
  try {
    console.log('❌ Suscripción cancelada:', subscription.id);
    
    // Buscar el usuario por la suscripción
    const sessionsQuery = await db.collection('checkout_sessions')
      .where('stripeSubscriptionId', '==', subscription.id)
      .limit(1)
      .get();

    if (!sessionsQuery.empty) {
      const sessionData = sessionsQuery.docs[0].data();
      const { userId, testId } = sessionData;

      // Actualizar el estado de la suscripción
      await db.collection('suscripciones').doc(userId).set({
        [testId]: {
          status: 'cancelled',
          plan: 'none',
          cancelledAt: Date.now()
        }
      }, { merge: true });

      console.log(`🚫 Suscripción cancelada para usuario ${userId} en test ${testId}`);
    }

  } catch (error) {
    console.error('❌ Error manejando cancelación de suscripción:', error);
  }
}

// ✅ EXPORTAR FUNCIONES
exports.api = onRequest({ region: "europe-west6" }, app);
