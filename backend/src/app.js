// VirtualBet — app.js v2
// Moneda: BetCoins (BC)
// Nuevos módulos: Sportsbook, Sistema social, Apuestas P2P

require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { validateStartup } = require('./security/startup');
const {
  authStrictLimiter, betLimiter, chatLimiter, pushLimiter,
  promoLimiter, p2pLimiter, gameLimiter, adminLimiter,
} = require('./security/rateLimiters');

// Falla rápido si la config de seguridad está mal en producción
validateStartup();

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Helmet con CSP estricta. La API solo devuelve JSON — no necesita relajar nada.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'none'"],
      baseUri:       ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  referrerPolicy:            { policy: 'no-referrer' },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }, // 2 años
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
}));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3001',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS bloqueado'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: { error: 'Demasiados requests. Esperá 15 minutos.' },
  standardHeaders: true, legacyHeaders: false,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX) || 10,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true, legacyHeaders: false,
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Health check — UptimeRobot lo pingea cada 5 min ──────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'VirtualBet API',
    currency:  'BetCoins (BC)',
    timestamp: new Date().toISOString(),
  });
});

// ── Rutas ────────────────────────────────────────────────────────────────
const authRoutes     = require('./auth/auth.routes');
const walletRoutes   = require('./wallet/wallet.routes');
const gamesRoutes    = require('./games/games.routes');
const friendsRoutes  = require('./friends/friends.routes');
const sportRoutes    = require('./sportsbook/sportsbook.routes');
const p2pRoutes      = require('./p2p/p2p.routes');
const adminRoutes    = require('./admin/admin.routes');
const userRoutes     = require('./routes/user.routes');
const promoRoutes    = require('./promo/promo.routes');
const chatRoutes     = require('./chat/chat.routes');
const pushRoutes     = require('./push/push.routes');

// Notifications inline para no crear archivo extra
const { PrismaClient: PC2 } = require('@prisma/client');
const prisma2 = new PC2();
const notifRouter = express.Router();
const { requireAuth } = require('./middleware/auth.middleware');
notifRouter.use(requireAuth);
notifRouter.get('/', async (req, res) => {
  try {
    const ns = await prisma2.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    res.json({ notifications: ns, unread: ns.filter(n => !n.isRead).length });
  } catch { res.status(500).json({ error: 'Error' }); }
});
notifRouter.post('/read-all', async (req, res) => {
  try {
    await prisma2.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data:  { isRead: true },
    });
    res.json({ message: 'Leídas' });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.use('/api/auth',          authLimiter, authStrictLimiter, authRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/games',         gameLimiter,  gamesRoutes);
app.use('/api/friends',       friendsRoutes);
app.use('/api/sports',        betLimiter,   sportRoutes);
app.use('/api/p2p',           p2pLimiter,   p2pRoutes);
app.use('/api/admin',         adminLimiter, adminRoutes);
app.use('/api/user',          userRoutes);
app.use('/api/promo',         promoLimiter, promoRoutes);
app.use('/api/chat',          chatLimiter,  chatRoutes);
app.use('/api/push',          pushLimiter,  pushRoutes);
app.use('/api/notifications', notifRouter);

// ── Error handling ────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, req, res, next) => {
  // Loguea internamente pero NO expone stack ni detalles en producción
  console.error('[ERROR]', req.method, req.path, '-', err.message);
  if (err.stack && process.env.NODE_ENV !== 'production') console.error(err.stack);

  if (err.message === 'CORS bloqueado') {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload demasiado grande' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  const status = err.statusCode || 500;
  // Sólo errores 4xx pueden mostrar mensaje real; 5xx siempre genérico en prod
  const msg = (status < 500 || process.env.NODE_ENV !== 'production')
    ? (err.message || 'Error')
    : 'Error interno del servidor';
  res.status(status).json({ error: msg });
});

// ── Start ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ PostgreSQL conectado (Supabase)');

    require('./cron/scheduler');
    console.log('✅ Cron scheduler iniciado');

    app.listen(PORT, () => {
      console.log(`✅ VirtualBet API — http://localhost:${PORT}`);
      console.log(`   Moneda: BetCoins (BC)`);
      console.log(`   Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('❌ Error al iniciar:', err);
    process.exit(1);
  }
}

start();
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });

module.exports = { app, prisma };