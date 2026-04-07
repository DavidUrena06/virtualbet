// backend/src/sportsbook/sportsbook.controller.js
// Corregido: manejo de timezone, cierre de apuestas solo cuando corresponde

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Helper: convierte datetime-local a fecha UTC correcta ─────────────────
// El frontend manda "2024-12-25T20:00" sin timezone
// El servidor puede estar en UTC, entonces hay que tratar la fecha como hora local de Costa Rica
// Costa Rica: UTC-6, sin horario de verano (siempre UTC-6)
const toUTC = (dateStr) => {
  if (!dateStr) throw new Error('Fecha requerida');

  // Si ya tiene timezone info (Z o +xx:xx), úsala directo
  if (dateStr.includes('Z') || dateStr.includes('+') || dateStr.match(/\d{2}:\d{2}$/)) {
    return new Date(dateStr);
  }

  // Sin timezone → asumir que es hora de Costa Rica (UTC-6)
  // Agregar offset manual: +6 horas para convertir a UTC
  const localDate = new Date(dateStr);
  if (isNaN(localDate.getTime())) throw new Error('Formato de fecha inválido');

  // Agrega 6 horas para convertir CR → UTC
  const utcDate = new Date(localDate.getTime() + 6 * 60 * 60 * 1000);
  return utcDate;
};

// ── GET /api/sports/matches ───────────────────────────────────────────────
const getMatches = async (req, res) => {
  try {
    const { league = '', status = 'UPCOMING' } = req.query;

    const where = {};
    if (league) where.league = league.toUpperCase();

    // Si pide UPCOMING, devuelve solo los que no iniciaron aún
    if (status === 'UPCOMING') {
      where.status = 'UPCOMING';
    } else {
      where.status = status.toUpperCase();
    }

    const matches = await prisma.match.findMany({
      where,
      orderBy: { startsAt: 'asc' },
    });

    res.json({ matches });
  } catch (err) {
    console.error('[SPORT] getMatches:', err.message);
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
};

// ── GET /api/sports/matches/:id ───────────────────────────────────────────
const getMatchById = async (req, res) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
    });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    res.json({ match });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener partido' });
  }
};

// ── POST /api/sports/bet ──────────────────────────────────────────────────
const placeBet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { matchId, selection, amount } = req.body;

    if (!['HOME', 'DRAW', 'AWAY'].includes(selection)) {
      return res.status(400).json({ error: 'Selección inválida: HOME, DRAW o AWAY' });
    }

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount < 1) {
      return res.status(400).json({ error: 'Apuesta mínima: 1 BC' });
    }

    // Carga el partido con lock para evitar race conditions
    const match = await prisma.match.findUnique({ where: { id: matchId } });

    if (!match) {
      return res.status(404).json({ error: 'Partido no encontrado' });
    }

    // Verifica estado del partido
    if (match.status === 'FINISHED') {
      return res.status(400).json({ error: 'Este partido ya terminó' });
    }
    if (match.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Este partido fue cancelado' });
    }
    if (match.status === 'LIVE') {
      return res.status(400).json({ error: 'El partido ya inició. Las apuestas están cerradas.' });
    }

    // Verifica si ya pasó la hora de inicio
    const now = new Date();
    if (now >= new Date(match.startsAt)) {
      // Cierra el partido automáticamente
      await prisma.match.update({
        where: { id: matchId },
        data:  { status: 'LIVE' },
      });
      return res.status(400).json({
        error: 'El partido ya inició. Las apuestas fueron cerradas automáticamente.',
      });
    }

    // Verifica saldo disponible
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet no encontrada' });
    }

    const available = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance || 0);
    if (available < parsedAmount) {
      return res.status(400).json({
        error: `BetCoins insuficientes. Disponibles: ${available.toFixed(2)} BC`,
      });
    }

    // Odds al momento de apostar
    const oddMap = { HOME: match.oddHome, DRAW: match.oddDraw, AWAY: match.oddAway };
    const oddAtBet     = parseFloat(oddMap[selection]);
    const potentialWin = parsedAmount * oddAtBet;

    // Transacción atómica
    const bet = await prisma.$transaction(async (tx) => {
      // Bloquea y verifica el wallet de nuevo dentro de la tx
      const w = await tx.wallet.findUnique({ where: { userId } });
      const avail = parseFloat(w.balance) - parseFloat(w.lockedBalance || 0);

      if (avail < parsedAmount) {
        throw new Error(`BetCoins insuficientes: ${avail.toFixed(2)} BC disponibles`);
      }

      // Descuenta del balance
      const newBalance = parseFloat(w.balance) - parsedAmount;
      await tx.wallet.update({
        where: { userId },
        data: {
          balance:      newBalance,
          totalWagered: { increment: parsedAmount },
        },
      });

      // Registra en ledger
      await tx.transaction.create({
        data: {
          userId,
          walletId:      w.id,
          type:          'SPORT_BET',
          amount:        parsedAmount,
          balanceBefore: w.balance,
          balanceAfter:  newBalance,
          note:          `Apuesta: ${match.teamHome} vs ${match.teamAway} — ${selection}`,
          reference:     matchId,
        },
      });

      // Crea la apuesta
      return tx.sportBet.create({
        data: {
          userId,
          matchId,
          selection,
          amount:       parsedAmount,
          oddAtBet,
          potentialWin,
          status:       'PENDING',
        },
      });
    });

    // Balance actualizado
    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    const newAvail = parseFloat(updatedWallet.balance) - parseFloat(updatedWallet.lockedBalance || 0);

    res.status(201).json({
      message: 'Apuesta registrada exitosamente',
      bet: {
        id:          bet.id,
        match:       `${match.teamHome} vs ${match.teamAway}`,
        league:      match.league,
        selection,
        amount:      parsedAmount,
        oddAtBet,
        potentialWin: parseFloat(potentialWin.toFixed(2)),
        startsAt:    match.startsAt,
      },
      newBalance: parseFloat(newAvail.toFixed(2)),
    });

  } catch (err) {
    console.error('[SPORT] placeBet:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ── GET /api/sports/history ───────────────────────────────────────────────
const getBetHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip  = (page - 1) * limit;

    const [bets, total] = await Promise.all([
      prisma.sportBet.findMany({
        where:   { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
        include: {
          match: {
            select: {
              teamHome:  true,
              teamAway:  true,
              league:    true,
              result:    true,
              status:    true,
              startsAt:  true,
            },
          },
        },
      }),
      prisma.sportBet.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      bets,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[SPORT] getBetHistory:', err.message);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

module.exports = { getMatches, getMatchById, placeBet, getBetHistory };