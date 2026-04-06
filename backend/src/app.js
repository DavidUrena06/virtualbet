// VirtualBet — app.js v2
// Moneda: BetCoins (BC)
// Nuevos módulos: Sportsbook, Sistema social, Apuestas P2P

require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet());

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

app.use('/api/auth',          authLimiter, authRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/games',         gamesRoutes);
app.use('/api/friends',       friendsRoutes);
app.use('/api/sports',        sportRoutes);
app.use('/api/p2p',           p2pRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/user',          userRoutes);
app.use('/api/notifications', notifRouter);

// ── Error handling ────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (err.message === 'CORS bloqueado') return res.status(403).json({ error: 'Origen no permitido' });
  const status = err.statusCode || 500;
  const msg    = process.env.NODE_ENV === 'production' ? 'Error interno' : err.message;
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