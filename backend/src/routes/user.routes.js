// backend/src/routes/user.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth.middleware');
const prisma = new PrismaClient();

const router = express.Router();
router.use(requireAuth);

// GET /api/user/profile
router.get('/profile', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        avatarEmoji: true,
        createdAt: true,
        wallet: {
          select: {
            balance: true,
            lockedBalance: true,
            totalWagered: true,
            totalWon: true,
            totalDeposited: true,
          },
        },
        _count: {
          select: {
            gameHistory: true,
            sportBets: true,                  // corregido: era 'bets' en v1
            privateBetParticipations: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Calcula stats adicionales
    const wallet = user.wallet;
    const available = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance || 0);
    const netResult = parseFloat(wallet.totalWon) - parseFloat(wallet.totalWagered);

    res.json({
      user: {
        ...user,
        wallet: {
          ...wallet,
          available,
          netResult,
        },
      },
    });
  } catch (err) {
    console.error('[USER] profile:', err);
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// GET /api/user/stats — estadísticas detalladas
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    const [gameStats, sportStats, p2pStats] = await Promise.all([
      // Juegos de casino
      prisma.gameHistory.groupBy({
        by: ['gameType'],
        where: { userId },
        _count: { id: true },
        _sum: { betAmount: true, payout: true },
      }),

      // Apuestas deportivas
      prisma.sportBet.groupBy({
        by: ['status'],
        where: { userId },
        _count: { id: true },
        _sum: { amount: true, potentialWin: true },
      }),

      // P2P
      prisma.privateBetParticipant.groupBy({
        by: ['status'],
        where: { userId },
        _count: { id: true },
        _sum: { amount: true, payout: true },
      }),
    ]);

    res.json({ gameStats, sportStats, p2pStats });
  } catch (err) {
    console.error('[USER] stats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

module.exports = router;