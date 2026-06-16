// security/rateLimiters.js
// Rate limiters específicos por endpoint sensible. Usa express-rate-limit.
// Cada limiter es independiente — un user puede ser bloqueado en chat sin
// afectar su capacidad de hacer otras operaciones.

const rateLimit = require('express-rate-limit');

// Helper para keyear por user-id cuando esté autenticado, sino por IP
const userOrIpKey = (req) => req.user?.id || req.ip;

// LOGIN / REGISTER — el global authLimiter ya cubre, este es backup
const authStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// BETTING — máx 30 apuestas en 5 min (anti-bot)
const betLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max:      30,
  message:  { error: 'Demasiadas apuestas. Esperá unos minutos.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders:   false,
});

// CHAT — máx 60 mensajes en 5 min (rate limit en controller también es 3s entre msgs)
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max:      60,
  message:  { error: 'Demasiados mensajes. Esperá unos minutos.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders:   false,
});

// PUSH SUBSCRIBE — máx 10 cambios de suscripción por hora
const pushLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      10,
  message:  { error: 'Demasiados cambios de suscripción.' },
  keyGenerator: userOrIpKey,
});

// PROMO CLAIMS — máx 5 reclamos por hora (es 1/día por diseño, esto es defensa)
const promoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  message:  { error: 'Demasiados intentos de reclamo. Esperá una hora.' },
  keyGenerator: userOrIpKey,
});

// P2P — máx 20 acciones de P2P en 10 min (crear/join/cancel/invite)
const p2pLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max:      20,
  message:  { error: 'Demasiadas acciones P2P. Esperá unos minutos.' },
  keyGenerator: userOrIpKey,
});

// GAMES — máx 200 jugadas en 5 min (juegos rápidos como dice/coinflip)
const gameLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max:      200,
  message:  { error: 'Demasiadas jugadas. Esperá unos minutos.' },
  keyGenerator: userOrIpKey,
});

// ADMIN — máx 60 acciones admin en 5 min (deja margen para gestión normal)
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max:      60,
  message:  { error: 'Demasiadas acciones admin. Esperá unos minutos.' },
  keyGenerator: userOrIpKey,
});

module.exports = {
  authStrictLimiter,
  betLimiter,
  chatLimiter,
  pushLimiter,
  promoLimiter,
  p2pLimiter,
  gameLimiter,
  adminLimiter,
};
