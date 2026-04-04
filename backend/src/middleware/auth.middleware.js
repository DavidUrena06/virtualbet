// middleware/auth.middleware.js
// Verifica JWT en cada request protegido

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Verifica que el usuario esté autenticado ─────────────────────────────────
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verifica que el usuario siga existiendo y no esté baneado
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isBanned: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    if (user.isBanned) {
      return res.status(403).json({ error: 'Tu cuenta está suspendida' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Iniciá sesión de nuevo.' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// ─── Verifica que el usuario sea admin ───────────────────────────────────────
const requireAdmin = async (req, res, next) => {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Acceso denegado. Se requiere rol admin.' });
    }
    next();
  });
};

module.exports = { requireAuth, requireAdmin };
