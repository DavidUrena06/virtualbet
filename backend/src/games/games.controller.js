// games/games.controller.js
// Motor de juegos - toda la lógica crítica en backend
// Nunca confiar en valores del frontend para calcular resultados

const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();

// ─── RNG seguro (no manipulable desde frontend) ───────────────────────────────
const crypto = require('crypto');

const secureRandom = () => {
  // Genera número aleatorio entre 0 y 1 usando crypto (más seguro que Math.random)
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
};

const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE) || 0.03;

// ─── Validación de apuesta ────────────────────────────────────────────────────
const validateBet = async (userId, betAmount) => {
  if (!betAmount || betAmount <= 0) {
    throw new Error('Monto de apuesta inválido');
  }

  if (betAmount < 1) {
    throw new Error('Apuesta mínima: 1 moneda');
  }

  if (betAmount > 10000) {
    throw new Error('Apuesta máxima: 10,000 monedas');
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId } });

  if (!wallet || parseFloat(wallet.balance) < betAmount) {
    throw new Error('Saldo insuficiente');
  }

  return wallet;
};

// ─── JUEGO: DICE ──────────────────────────────────────────────────────────────
// El jugador elige un número target y si ganará OVER o UNDER ese número
// El dado lanza 0-100. House edge = 3%
const playDice = async (req, res) => {
  try {
    const userId   = req.user.id;
    const { betAmount, target, direction } = req.body;

    // Validaciones
    if (!target || target < 2 || target > 98) {
      return res.status(400).json({ error: 'Target debe estar entre 2 y 98' });
    }

    if (!['OVER', 'UNDER'].includes(direction)) {
      return res.status(400).json({ error: 'Dirección inválida. Usá OVER o UNDER' });
    }

    const parsedBet = parseFloat(betAmount);
    await validateBet(userId, parsedBet);

    // Calcula multiplicador con house edge
    const winChance = direction === 'OVER'
      ? (100 - target) / 100
      : target / 100;

    // Multiplicador = (1 / winChance) * (1 - houseEdge)
    const multiplier = (1 / winChance) * (1 - HOUSE_EDGE);

    // Lanza el dado
    const roll = Math.floor(secureRandom() * 100) + 1; // 1-100

    const won = direction === 'OVER' ? roll > target : roll < target;
    const payout = won ? parsedBet * multiplier : 0;
    const netChange = won ? payout - parsedBet : -parsedBet;

    // Registra en BD con transacción atómica
    await prisma.$transaction(async (tx) => {
      // Cobra la apuesta
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Dice: apuesta ${direction} ${target}`, null);

      // Si ganó, paga
      if (won) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Dice: ganaste x${multiplier.toFixed(4)}`, null);
      }

      // Historial
      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'DICE',
          betAmount: parsedBet,
          multiplier: won ? multiplier : 0,
          payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { roll, target, direction, multiplier },
        },
      });
    });

    // Obtiene balance actualizado
    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result: won ? 'WIN' : 'LOSS',
      roll,
      target,
      direction,
      multiplier: parseFloat(multiplier.toFixed(4)),
      betAmount: parsedBet,
      payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[DICE] Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── JUEGO: COINFLIP ──────────────────────────────────────────────────────────
// El jugador elige HEADS o TAILS. Paga 1.96x (house edge 2%)
const playCoinflip = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, choice } = req.body;

    if (!['HEADS', 'TAILS'].includes(choice)) {
      return res.status(400).json({ error: 'Elegí HEADS o TAILS' });
    }

    const parsedBet = parseFloat(betAmount);
    await validateBet(userId, parsedBet);

    const result = secureRandom() < 0.5 ? 'HEADS' : 'TAILS';
    const won = result === choice;
    const multiplier = 1.96; // house edge 2%
    const payout = won ? parsedBet * multiplier : 0;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Coinflip: apostaste ${choice}`, null);

      if (won) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Coinflip: ganaste x${multiplier}`, null);
      }

      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'COINFLIP',
          betAmount: parsedBet,
          multiplier: won ? multiplier : 0,
          payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { choice, result, multiplier },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result: won ? 'WIN' : 'LOSS',
      yourChoice: choice,
      coinResult: result,
      multiplier,
      betAmount: parsedBet,
      payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[COINFLIP] Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── JUEGO: CRASH ─────────────────────────────────────────────────────────────
// El multiplicador sube hasta que "crashea". El jugador debe hacer cash-out antes.
// La semilla del crash se genera en backend y no se revela hasta que el juego termina.
const startCrash = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount } = req.body;

    const parsedBet = parseFloat(betAmount);
    await validateBet(userId, parsedBet);

    // Genera el punto de crash (house edge 3%)
    // Fórmula: crash = 0.99 / random  — garantiza house edge del ~3%
    const random = secureRandom();
    const crashPoint = random < 0.01
      ? 1.00 // 1% de chance de crashear inmediatamente en 1x
      : Math.max(1.00, (0.99 / random));

    // Genera ID único para esta ronda
    const roundId = require('crypto').randomBytes(8).toString('hex');

    // Guarda el crash en memoria temporal (en producción usar Redis)
    // Por ahora lo guardamos en un Map en memoria
    if (!global.crashRounds) global.crashRounds = new Map();
    global.crashRounds.set(roundId, {
      crashPoint: parseFloat(crashPoint.toFixed(2)),
      betAmount: parsedBet,
      userId,
      startedAt: Date.now(),
    });

    // Cobra la apuesta inmediatamente
    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Crash: apuesta ronda ${roundId}`, roundId);
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    // Solo devuelve el roundId, NO el crashPoint (el frontend no lo sabe)
    res.json({
      roundId,
      betAmount: parsedBet,
      newBalance: parseFloat(updatedWallet.balance),
      message: 'Ronda iniciada. Hacé cashout antes del crash.',
    });
  } catch (error) {
    console.error('[CRASH] Error al iniciar:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// Cash-out del Crash: el jugador decide en qué multiplicador retirarse
const cashoutCrash = async (req, res) => {
  try {
    const userId = req.user.id;
    const { roundId, cashoutAt } = req.body;

    if (!global.crashRounds?.has(roundId)) {
      return res.status(400).json({ error: 'Ronda no encontrada o ya terminada' });
    }

    const round = global.crashRounds.get(roundId);

    if (round.userId !== userId) {
      return res.status(403).json({ error: 'Esta ronda no te pertenece' });
    }

    const parsedCashout = parseFloat(cashoutAt);

    if (parsedCashout < 1.01) {
      return res.status(400).json({ error: 'Cashout mínimo: 1.01x' });
    }

    // Verifica si el jugador hizo cashout antes del crash
    const won = parsedCashout <= round.crashPoint;
    const payout = won ? round.betAmount * parsedCashout : 0;

    global.crashRounds.delete(roundId);

    await prisma.$transaction(async (tx) => {
      if (won) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Crash: cashout en ${parsedCashout}x`, roundId);
      }

      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'CRASH',
          betAmount: round.betAmount,
          multiplier: won ? parsedCashout : 0,
          payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: {
            cashoutAt: parsedCashout,
            crashPoint: round.crashPoint,
            won,
          },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result: won ? 'WIN' : 'LOSS',
      cashoutAt: parsedCashout,
      crashPoint: round.crashPoint,
      betAmount: round.betAmount,
      payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[CRASH] Error en cashout:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── Historial de juegos del usuario ─────────────────────────────────────────
const getGameHistory = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;
    const gameType = req.query.gameType; // filtro opcional

    const where = { userId: req.user.id };
    if (gameType) where.gameType = gameType.toUpperCase();

    const [history, total] = await Promise.all([
      prisma.gameHistory.findMany({
        where,
        orderBy: { playedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.gameHistory.count({ where }),
    ]);

    res.json({
      history,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[GAMES] Error en historial:', error.message);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

module.exports = {
  playDice,
  playCoinflip,
  startCrash,
  cashoutCrash,
  getGameHistory,
};
