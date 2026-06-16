// push/push.controller.js
// Web Push notifications con VAPID. Cliente registra suscripción → guardamos
// endpoint + claves → cuando hay evento (apuesta resuelta, partido por iniciar,
// bono diario disponible) le mandamos push aunque tenga la pestaña cerrada.
//
// ENV vars requeridas (generar con: `node scripts/generate-vapid.js`):
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT  (e.g. "mailto:admin@virtualbet.com")

const webpush = require('web-push');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@virtualbet.com';

let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  pushEnabled = true;
  console.log('✅ Web Push habilitado');
} else {
  console.warn('⚠️  VAPID keys no configuradas — push notifications deshabilitadas');
}

// GET /api/push/public-key
const getPublicKey = (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push deshabilitado en este server' });
  res.json({ publicKey: VAPID_PUBLIC });
};

// POST /api/push/subscribe   body: { endpoint, keys: { p256dh, auth }, userAgent? }
const subscribe = async (req, res) => {
  try {
    if (!pushEnabled) return res.status(503).json({ error: 'Push deshabilitado' });
    const { endpoint, keys, userAgent } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Suscripción inválida' });
    }

    // Upsert por endpoint (idempotente — reusar misma suscripción del browser)
    await prisma.pushSubscription.upsert({
      where:  { endpoint },
      update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
      create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
    });

    res.json({ message: 'Suscripción registrada' });
  } catch (err) {
    console.error('[PUSH] subscribe:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/push/unsubscribe   body: { endpoint }
const unsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.user.id },
    });
    res.json({ message: 'Desuscripto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/push/test  — envía un push de prueba al usuario
const sendTest = async (req, res) => {
  try {
    const sent = await sendPushToUser(req.user.id, {
      title: '🎰 VirtualBet',
      body:  '¡Notificaciones activadas correctamente!',
      url:   '/pages/dashboard.html',
    });
    res.json({ message: 'Test enviado', sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Helpers reutilizables ───────────────────────────────────────────────────

// Envía push a TODAS las suscripciones de un usuario. Si una suscripción
// devuelve 404/410, la borramos (browser desinstaló).
async function sendPushToUser(userId, payload) {
  if (!pushEnabled) return 0;

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return 0;

  const body = JSON.stringify({
    title: payload.title || 'VirtualBet',
    body:  payload.body  || '',
    url:   payload.url   || '/',
    icon:  payload.icon  || '/favicon.ico',
    tag:   payload.tag   || undefined,
  });

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Suscripción muerta — borrar
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        console.error(`[PUSH] error a ${userId}:`, err.message);
      }
    }
  }
  return sent;
}

async function sendPushToUsers(userIds, payload) {
  let total = 0;
  for (const uid of userIds) {
    total += await sendPushToUser(uid, payload);
  }
  return total;
}

module.exports = {
  getPublicKey,
  subscribe,
  unsubscribe,
  sendTest,
  sendPushToUser,
  sendPushToUsers,
  pushEnabled: () => pushEnabled,
};
