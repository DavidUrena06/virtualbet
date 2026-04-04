// routes/user.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth.middleware');
const prisma = new PrismaClient();

const router = express.Router();
router.use(requireAuth);

// GET /api/user/profile - perfil completo con estadísticas
router.get('/profile', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
        wallet: {
          select: {
            balance: true,
            totalWagered: true,
            totalWon: true,
            totalDeposited: true,
          },
        },
        _count: {
          select: { gameHistory: true, bets: true },
        },
      },
    });

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

module.exports = router;
