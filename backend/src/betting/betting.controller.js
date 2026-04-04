// betting/betting.controller.js
// Sistema de apuestas deportivas

const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();

// ─── Ver partidos disponibles ─────────────────────────────────────────────────
const getMatches = async (req, res) => {
  try {
    const { league, status } = req.query;

    const where = {};
    if (league) where.league = league.toUpperCase();
    if (status) where.status = status.toUpperCase();
    else where.status = { in: ['UPCOMING', 'LIVE'] }; // Por defecto muestra activos

    const matches = await prisma.match.findMany({
      where,
      orderBy: { startsAt: 'asc' },
    });

    res.json({ matches });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
};

// ─── Apostar en un partido ────────────────────────────────────────────────────
const placeBet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { matchId, selection, amount } = req.body;

    if (!['HOME', 'DRAW', 'AWAY'].includes(selection)) {
      return res.status(400).json({ error: 'Selección inválida' });
    }

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount < 1) {
      return res.status(400).json({ error: 'Apuesta mínima: 1 moneda' });
    }

    const match = await prisma.match.findUnique({ where: { id: matchId } });

    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Este partido ya no acepta apuestas' });
    }

    // Verifica si el partido ya empezó (cierre automático)
    if (new Date() >= match.startsAt) {
      await prisma.match.update({ where: { id: matchId }, data: { status: 'LIVE' } });
      return res.status(400).json({ error: 'El partido ya empezó. Apuestas cerradas.' });
    }

    // Obtiene la cuota al momento de apostar
    const oddMap = { HOME: match.oddHome, DRAW: match.oddDraw, AWAY: match.oddAway };
    const oddAtBet = parseFloat(oddMap[selection]);
    const potentialWin = parsedAmount * oddAtBet;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (parseFloat(wallet.balance) < parsedAmount) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const bet = await prisma.$transaction(async (tx) => {
      // Cobra la apuesta
      await transferCoins(tx, userId, -parsedAmount, 'SPORT_BET',
        `Apuesta: ${match.teamHome} vs ${match.teamAway} — ${selection}`, matchId);

      // Crea la apuesta
      return tx.bet.create({
        data: {
          userId,
          matchId,
          selection,
          amount: parsedAmount,
          oddAtBet,
          potentialWin,
          status: 'PENDING',
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.status(201).json({
      message: 'Apuesta registrada',
      bet: {
        id: bet.id,
        match: `${match.teamHome} vs ${match.teamAway}`,
        selection,
        amount: parsedAmount,
        oddAtBet,
        potentialWin: parseFloat(potentialWin.toFixed(2)),
      },
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[BETTING] placeBet:', error);
    res.status(400).json({ error: error.message });
  }
};

// ─── Historial de apuestas del usuario ───────────────────────────────────────
const getBetHistory = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [bets, total] = await Promise.all([
      prisma.bet.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          match: {
            select: { teamHome: true, teamAway: true, league: true, result: true },
          },
        },
      }),
      prisma.bet.count({ where: { userId: req.user.id } }),
    ]);

    res.json({ bets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener historial de apuestas' });
  }
};

module.exports = { getMatches, placeBet, getBetHistory };
