// ══════════════════════════════════════════════════════════
// p2p/p2p.routes.js
// ══════════════════════════════════════════════════════════
const express = require('express');
const { body } = require('express-validator');
const {
  createPrivateBet, joinPrivateBet,
  getPrivateBet, getMyPrivateBets, cancelPrivateBet,
} = require('../p2p/p2p.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.post('/create', [
  body('matchId').notEmpty(),
  body('title').isLength({ min: 3, max: 80 }),
  body('minAmount').isFloat({ min: 1 }),
  body('creatorSelection').isIn(['HOME','DRAW','AWAY']),
  body('creatorAmount').isFloat({ min: 1 }),
], createPrivateBet);

router.post('/join', [
  body('privateBetId').notEmpty(),
  body('selection').isIn(['HOME','DRAW','AWAY']),
  body('amount').isFloat({ min: 1 }),
], joinPrivateBet);

router.post('/cancel', [body('privateBetId').notEmpty()], cancelPrivateBet);

router.get('/my',     getMyPrivateBets);  // ?status=OPEN|LOCKED|RESOLVED
router.get('/:id',    getPrivateBet);

module.exports = router;


// ══════════════════════════════════════════════════════════
// sportsbook/sportsbook.controller.js
// Apuestas deportivas clásicas vs la casa con BetCoins
// ══════════════════════════════════════════════════════════
// (Pega este contenido en sportsbook/sportsbook.controller.js)

const { PrismaClient } = require('@prisma/client');
const prismaInstance = new PrismaClient();

const getMatches = async (req, res) => {
  try {
    const { league, status = 'UPCOMING' } = req.query;

    const matches = await prismaInstance.match.findMany({
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

    if (!['HOME','DRAW','AWAY'].includes(selection)) {
      return res.status(400).json({ error: 'Selección: HOME, DRAW o AWAY' });
    }

    const parsedAmount = parseFloat(amount);

    const match = await prismaInstance.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Este partido ya no acepta apuestas' });
    }
    if (new Date() >= match.startsAt) {
      await prismaInstance.match.update({ where: { id: matchId }, data: { status: 'LIVE' } });
      return res.status(400).json({ error: 'El partido ya inició. Apuestas cerradas.' });
    }

    const oddMap = { HOME: match.oddHome, DRAW: match.oddDraw, AWAY: match.oddAway };
    const oddAtBet     = parseFloat(oddMap[selection]);
    const potentialWin = parsedAmount * oddAtBet;

    const wallet = await prismaInstance.wallet.findUnique({ where: { userId } });
    const available = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance);

    if (available < parsedAmount) {
      return res.status(400).json({
        error: `BetCoins insuficientes. Disponibles: ${available.toFixed(2)} BC`,
      });
    }

    const bet = await prismaInstance.$transaction(async (tx) => {
      // Descuenta del balance real
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

    const updated = await prismaInstance.wallet.findUnique({ where: { userId } });

    res.status(201).json({
      message: 'Apuesta registrada',
      bet: {
        id:          bet.id,
        match:       `${match.teamHome} vs ${match.teamAway}`,
        selection,
        amount:      parsedAmount,
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
      prismaInstance.sportBet.findMany({
        where:   { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
        include: {
          match: { select: { teamHome: true, teamAway: true, league: true, result: true, status: true } },
        },
      }),
      prismaInstance.sportBet.count({ where: { userId: req.user.id } }),
    ]);

    res.json({ bets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

const getMatchById = async (req, res) => {
  try {
    const match = await prismaInstance.match.findUnique({
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
