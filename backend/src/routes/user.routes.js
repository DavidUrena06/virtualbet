// backend/src/routes/user.routes.js
// Corregido: groupBy reemplazado por queries simples que funcionan en cualquier versión de Prisma

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
            sportBets: true,
            privateBetParticipations: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const balance     = parseFloat(user.wallet?.balance || 0);
    const locked      = parseFloat(user.wallet?.lockedBalance || 0);
    const wagered     = parseFloat(user.wallet?.totalWagered || 0);
    const won         = parseFloat(user.wallet?.totalWon || 0);

    res.json({
      user: {
        ...user,
        wallet: {
          ...user.wallet,
          available:  parseFloat((balance - locked).toFixed(2)),
          netResult:  parseFloat((won - wagered).toFixed(2)),
        },
      },
    });
  } catch (err) {
    console.error('[USER] /profile error:', err.message);
    res.status(500).json({ error: 'Error al obtener perfil: ' + err.message });
  }
});

// GET /api/user/stats
// Reemplaza groupBy con queries separadas para evitar incompatibilidades
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      totalGames, wonGames,
      totalSportBets, wonSportBets, pendingSportBets,
      totalWageredSport, totalWonSport,
      totalP2P, wonP2P,
      recentGames,
    ] = await Promise.all([
      prisma.gameHistory.count({ where: { userId } }),
      prisma.gameHistory.count({ where: { userId, result: 'WIN' } }),
      prisma.sportBet.count({ where: { userId } }),
      prisma.sportBet.count({ where: { userId, status: 'WON' } }),
      prisma.sportBet.count({ where: { userId, status: 'PENDING' } }),
      prisma.sportBet.aggregate({ where: { userId }, _sum: { amount: true } }),
      prisma.sportBet.aggregate({ where: { userId, status: 'WON' }, _sum: { potentialWin: true } }),
      prisma.privateBetParticipant.count({ where: { userId } }),
      prisma.privateBetParticipant.count({ where: { userId, status: 'WON' } }),
      prisma.gameHistory.findMany({
        where:   { userId },
        orderBy: { playedAt: 'desc' },
        take:    5,
        select:  { gameType: true, betAmount: true, payout: true, result: true, multiplier: true, playedAt: true },
      }),
    ]);

    const lostGames     = totalGames - wonGames;
    const lostSportBets = totalSportBets - wonSportBets - pendingSportBets;
    const winRateCasino = totalGames > 0 ? ((wonGames / totalGames) * 100).toFixed(1) : '0';
    const winRateSport  = (wonSportBets + lostSportBets) > 0
      ? ((wonSportBets / (wonSportBets + lostSportBets)) * 100).toFixed(1)
      : '0';

    res.json({
      casino: {
        total: totalGames,
        won:   wonGames,
        lost:  lostGames,
        winRate: winRateCasino + '%',
      },
      sports: {
        total:   totalSportBets,
        won:     wonSportBets,
        lost:    lostSportBets,
        pending: pendingSportBets,
        winRate: winRateSport + '%',
        totalWagered: parseFloat(totalWageredSport._sum.amount || 0).toFixed(2),
        totalWon:     parseFloat(totalWonSport._sum.potentialWin || 0).toFixed(2),
      },
      p2p: {
        total: totalP2P,
        won:   wonP2P,
        lost:  totalP2P - wonP2P,
      },
      recentGames,
    });
  } catch (err) {
    console.error('[USER] /stats error:', err.message);
    res.status(500).json({ error: 'Error al obtener stats: ' + err.message });
  }
});

module.exports = router;
