// sportsbook/sportsbook.controller.js
// Apuestas deportivas vs la casa con BetCoins

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getMatches = async (req, res) => {
  try {
    const { league, status = 'UPCOMING' } = req.query;

    const matches = await prisma.match.findMany({
      where: {
        ...(league ? { league: league.toUpperCase() } : {}),
        status: status.toUpperCase(),
      },
      orderBy: { startsAt: 'asc' },
    });

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
};

const placeBet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { matchId, selection, amount } = req.body;

    if (!['HOME', 'DRAW', 'AWAY'].includes(selection)) {
      return res.status(400).json({ error: 'Selección: HOME, DRAW o AWAY' });
    }

    const parsedAmount = parseFloat(amount);

    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });

    // Solo check de status — el cron se encarga de pasar a LIVE
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Este partido ya no acepta apuestas' });
    }

    const oddMap     = { HOME: match.oddHome, DRAW: match.oddDraw, AWAY: match.oddAway };
    const oddAtBet   = parseFloat(oddMap[selection]);
    const potentialWin = parsedAmount * oddAtBet;

    const wallet    = await prisma.wallet.findUnique({ where: { userId } });
    const available = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance);

    if (available < parsedAmount) {
      return res.status(400).json({
        error: `BetCoins insuficientes. Disponibles: ${available.toFixed(2)} BC`,
      });
    }

    const bet = await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findUnique({ where: { userId } });

      await tx.wallet.update({
        where: { userId },
        data: {
          balance:      { decrement: parsedAmount },
          totalWagered: { increment: parsedAmount },
        },
      });

      await tx.transaction.create({
        data: {
          userId,
          walletId:      w.id,
          type:          'SPORT_BET',
          amount:        parsedAmount,
          balanceBefore: w.balance,
          balanceAfter:  parseFloat(w.balance) - parsedAmount,
          note:          `Apuesta: ${match.teamHome} vs ${match.teamAway} — ${selection}`,
          reference:     matchId,
        },
      });

      return tx.sportBet.create({
        data: {
          userId, matchId, selection,
          amount:       parsedAmount,
          oddAtBet,
          potentialWin,
          status:       'PENDING',
        },
      });
    });

    const updated = await prisma.wallet.findUnique({ where: { userId } });

    res.status(201).json({
      message: 'Apuesta registrada',
      bet: {
        id:           bet.id,
        match:        `${match.teamHome} vs ${match.teamAway}`,
        selection,
        amount:       parsedAmount,
        oddAtBet,
        potentialWin: parseFloat(potentialWin.toFixed(2)),
      },
      newBalance: parseFloat(updated.balance) - parseFloat(updated.lockedBalance),
    });
  } catch (err) {
    console.error('[SPORT] placeBet:', err);
    res.status(400).json({ error: err.message });
  }
};

const getBetHistory = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [bets, total] = await Promise.all([
      prisma.sportBet.findMany({
        where:   { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
        include: {
          match: { select: { teamHome: true, teamAway: true, league: true, result: true, status: true } },
        },
      }),
      prisma.sportBet.count({ where: { userId: req.user.id } }),
    ]);

    res.json({ bets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

const getMatchById = async (req, res) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { sportBets: true, privateBets: true } },
      },
    });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    res.json({ match });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener partido' });
  }
};

module.exports = { getMatches, placeBet, getBetHistory, getMatchById };