// VirtualBet - Servidor principal
// Node.js + Express con seguridad completa configurada

require('dotenv').config();
const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

// ─── Inicialización ──────────────────────────────────────────────────────────
const app    = express();
app.set('trust proxy', 1);
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

// ─── Seguridad base (helmet) ──────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3001',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Responde preflight OPTIONS explícitamente
app.options('*', cors());

// ─── Rate limiting global ─────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Demasiados requests. Intentá de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit estricto para autenticación (anti brute-force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX) || 10,
  message: { error: 'Demasiados intentos de login. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'VirtualBet API',
  });
});

// ─── Rutas de la API ──────────────────────────────────────────────────────────
const authRoutes    = require('./auth/auth.routes');
const walletRoutes  = require('./wallet/wallet.routes');
const gamesRoutes   = require('./games/games.routes');
const bettingRoutes = require('./betting/betting.routes');
const adminRoutes   = require('./admin/admin.routes');
const userRoutes    = require('./routes/user.routes');

app.use('/api/auth',    authLimiter, authRoutes);
app.use('/api/wallet',  walletRoutes);
app.use('/api/games',   gamesRoutes);
app.use('/api/betting', bettingRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/user',    userRoutes);

// ─── Manejo de rutas no encontradas ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ─── Manejo global de errores ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);

  if (err.message === 'Bloqueado por CORS') {
    return res.status(403).json({ error: 'Origen no permitido' });
  }

  if (err.code?.startsWith('P')) {
    return res.status(400).json({ error: 'Error en la base de datos' });
  }

  const status = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Error interno del servidor'
    : err.message;

  res.status(status).json({ error: message });
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Conectado a PostgreSQL (Supabase)');

    require('./cron/scheduler');
    console.log('✅ Cron jobs iniciados');

    app.listen(PORT, () => {
      console.log(`✅ VirtualBet API corriendo en http://localhost:${PORT}`);
      console.log(`   Entorno: ${process.env.NODE_ENV}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

start();

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = { app, prisma };