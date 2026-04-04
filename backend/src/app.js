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
app.set('trust proxy', 1); // Si estás detrás de un proxy (como Heroku), esto es necesario para rate limiting y CORS
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

// ─── Seguridad base (helmet) ──────────────────────────────────────────────────
// Configura headers HTTP seguros automáticamente
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
// Solo permite requests desde el frontend autorizado
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log("FRONTEND_URL:", process.env.FRONTEND_URL);
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3001',
];

app.use(cors({
  origin: (origin, callback) => {
    // Permite requests sin origin en desarrollo (Postman, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate limiting global ─────────────────────────────────────────────────────
// Limita requests totales por IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
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
app.use(express.json({ limit: '10kb' })); // Limita tamaño del body
app.use(express.urlencoded({ extended: false }));

// ─── Health check (para UptimeRobot, mantiene el servidor despierto) ──────────
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

  // Error de CORS
  if (err.message === 'Bloqueado por CORS') {
    return res.status(403).json({ error: 'Origen no permitido' });
  }

  // Error de Prisma (BD)
  if (err.code?.startsWith('P')) {
    return res.status(400).json({ error: 'Error en la base de datos' });
  }

  // Error genérico
  const status = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Error interno del servidor'
    : err.message;

  res.status(status).json({ error: message });
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
async function start() {
  try {
    // Verifica conexión con la base de datos
    await prisma.$connect();
    console.log('✅ Conectado a PostgreSQL (Supabase)');

    // Inicia los cron jobs de recargas automáticas
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

// Cierra conexión de BD limpiamente al detener el proceso
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = { app, prisma };
