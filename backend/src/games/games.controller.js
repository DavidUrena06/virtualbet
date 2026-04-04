// games/games.controller.js
// Motor de juegos - toda la lógica crítica en backend
// Nunca confiar en valores del frontend para calcular resultados

const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();
const crypto = require('crypto');

// ─── RNG seguro (no manipulable desde frontend) ───────────────────────────────
const secureRandom = () => {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
};

const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE) || 0.03;

// ─── Validación de apuesta ────────────────────────────────────────────────────
const validateBet = async (userId, betAmount) => {
  if (!betAmount || betAmount <= 0) throw new Error('Monto de apuesta inválido');
  if (betAmount < 1) throw new Error('Apuesta mínima: 1 moneda');
  if (betAmount > 10000) throw new Error('Apuesta máxima: 10,000 monedas');

  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet || parseFloat(wallet.balance) < betAmount) {
    throw new Error('Saldo insuficiente');
  }
  return wallet;
};

// ─── JUEGO: DICE ──────────────────────────────────────────────────────────────
const playDice = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, target, direction } = req.body;

    if (!target || target < 2 || target > 98) {
      return res.status(400).json({ error: 'Target debe estar entre 2 y 98' });
    }
    if (!['OVER', 'UNDER'].includes(direction)) {
      return res.status(400).json({ error: 'Dirección inválida. Usá OVER o UNDER' });
    }

    const parsedBet = parseFloat(betAmount);
    await validateBet(userId, parsedBet);

    const winChance = direction === 'OVER' ? (100 - target) / 100 : target / 100;
    const multiplier = (1 / winChance) * (1 - HOUSE_EDGE);
    const roll = Math.floor(secureRandom() * 100) + 1;
    const won = direction === 'OVER' ? roll > target : roll < target;
    const payout = won ? parsedBet * multiplier : 0;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Dice: apuesta ${direction} ${target}`, null);
      if (won) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Dice: ganaste x${multiplier.toFixed(4)}`, null);
      }
      await tx.gameHistory.create({
        data: {
          userId, gameType: 'DICE', betAmount: parsedBet,
          multiplier: won ? multiplier : 0, payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { roll, target, direction, multiplier },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      result: won ? 'WIN' : 'LOSS', roll, target, direction,
      multiplier: parseFloat(multiplier.toFixed(4)),
      betAmount: parsedBet, payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[DICE] Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── JUEGO: COINFLIP ──────────────────────────────────────────────────────────
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
    const multiplier = 1.96;
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
          userId, gameType: 'COINFLIP', betAmount: parsedBet,
          multiplier: won ? multiplier : 0, payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { choice, result, multiplier },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      result: won ? 'WIN' : 'LOSS', yourChoice: choice, coinResult: result,
      multiplier, betAmount: parsedBet, payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[COINFLIP] Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── JUEGO: CRASH ─────────────────────────────────────────────────────────────
const startCrash = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount } = req.body;

    const parsedBet = parseFloat(betAmount);
    await validateBet(userId, parsedBet);

    const random = secureRandom();
    const crashPoint = random < 0.01 ? 1.00 : Math.max(1.00, (0.99 / random));
    const roundId = crypto.randomBytes(8).toString('hex');

    if (!global.crashRounds) global.crashRounds = new Map();
    global.crashRounds.set(roundId, {
      crashPoint: parseFloat(crashPoint.toFixed(2)),
      betAmount: parsedBet, userId, startedAt: Date.now(),
    });

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Crash: apuesta ronda ${roundId}`, roundId);
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      roundId, betAmount: parsedBet,
      newBalance: parseFloat(updatedWallet.balance),
      message: 'Ronda iniciada. Hacé cashout antes del crash.',
    });
  } catch (error) {
    console.error('[CRASH] Error al iniciar:', error.message);
    res.status(400).json({ error: error.message });
  }
};

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
          userId, gameType: 'CRASH', betAmount: round.betAmount,
          multiplier: won ? parsedCashout : 0, payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { cashoutAt: parsedCashout, crashPoint: round.crashPoint, won },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      result: won ? 'WIN' : 'LOSS', cashoutAt: parsedCashout,
      crashPoint: round.crashPoint, betAmount: round.betAmount,
      payout: parseFloat(payout.toFixed(2)),
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[CRASH] Error en cashout:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── Historial de juegos ──────────────────────────────────────────────────────
const getGameHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const gameType = req.query.gameType;

    const where = { userId: req.user.id };
    if (gameType) where.gameType = gameType.toUpperCase();

    const [history, total] = await Promise.all([
      prisma.gameHistory.findMany({
        where, orderBy: { playedAt: 'desc' }, skip, take: limit,
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

// ─── JUEGO: MINES ─────────────────────────────────────────────────────────────
function minesMultiplier(totalCells, minesCount, revealed) {
  let mult = 1;
  const safe = totalCells - minesCount;
  for (let i = 0; i < revealed; i++) {
    const remaining = totalCells - i;
    const safeRemaining = safe - i;
    mult *= remaining / safeRemaining;
  }
  return mult * (1 - HOUSE_EDGE);
}

const startMines = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, minesCount } = req.body;

    const parsedBet = parseFloat(betAmount);
    const parsedMines = parseInt(minesCount);

    if (parsedMines < 1 || parsedMines > 24) {
      return res.status(400).json({ error: 'Minas: entre 1 y 24' });
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    const mines = new Set();
    while (mines.size < parsedMines) {
      mines.add(Math.floor(secureRandom() * 25));
    }

    const gameId = crypto.randomBytes(8).toString('hex');
    if (!global.minesGames) global.minesGames = new Map();
    global.minesGames.set(gameId, {
      userId, betAmount: parsedBet, minesCount: parsedMines,
      mines: [...mines], revealed: [], status: 'playing', startedAt: Date.now(),
    });

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Mines: inicio partida ${gameId}`, gameId);
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      gameId, minesCount: parsedMines, totalCells: 25,
      newBalance: parseFloat(updatedWallet.balance),
      message: 'Partida iniciada. Destapá celdas para ganar.',
    });
  } catch (err) {
    console.error('[MINES] startMines:', err.message);
    res.status(400).json({ error: err.message });
  }
};

const revealCell = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId, cellIndex } = req.body;

    if (cellIndex < 0 || cellIndex > 24) {
      return res.status(400).json({ error: 'Celda inválida' });
    }

    const game = global.minesGames?.get(gameId);
    if (!game) return res.status(400).json({ error: 'Partida no encontrada' });
    if (game.userId !== userId) return res.status(403).json({ error: 'No es tu partida' });
    if (game.status !== 'playing') return res.status(400).json({ error: 'Partida terminada' });
    if (game.revealed.includes(cellIndex)) {
      return res.status(400).json({ error: 'Celda ya revelada' });
    }

    const isMine = game.mines.includes(cellIndex);

    if (isMine) {
      game.status = 'lost';
      global.minesGames.set(gameId, game);

      await prisma.gameHistory.create({
        data: {
          userId, gameType: 'MINES', betAmount: game.betAmount,
          multiplier: 0, payout: 0, result: 'LOSS',
          gameData: { minesCount: game.minesCount, mines: game.mines, revealed: game.revealed, hitCell: cellIndex },
        },
      });

      global.minesGames.delete(gameId);
      return res.json({
        result: 'MINE', cellIndex, mines: game.mines,
        revealed: game.revealed, gameOver: true,
        message: '💣 ¡Encontraste una mina!',
      });
    }

    game.revealed.push(cellIndex);
    global.minesGames.set(gameId, game);

    const mult = minesMultiplier(25, game.minesCount, game.revealed.length);
    const currentPayout = game.betAmount * mult;

    res.json({
      result: 'SAFE', cellIndex, revealed: game.revealed,
      multiplier: parseFloat(mult.toFixed(4)),
      currentPayout: parseFloat(currentPayout.toFixed(2)),
      gameOver: false,
    });
  } catch (err) {
    console.error('[MINES] revealCell:', err.message);
    res.status(400).json({ error: err.message });
  }
};

const cashoutMines = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId } = req.body;

    const game = global.minesGames?.get(gameId);
    if (!game) return res.status(400).json({ error: 'Partida no encontrada' });
    if (game.userId !== userId) return res.status(403).json({ error: 'No es tu partida' });
    if (game.status !== 'playing') return res.status(400).json({ error: 'Partida ya terminada' });
    if (game.revealed.length === 0) {
      return res.status(400).json({ error: 'Destapá al menos una celda antes de cobrar' });
    }

    const mult = minesMultiplier(25, game.minesCount, game.revealed.length);
    const payout = game.betAmount * mult;
    game.status = 'won';
    global.minesGames.delete(gameId);

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, payout, 'GAME_WIN',
        `Mines: cashout x${mult.toFixed(4)}`, gameId);
      await tx.gameHistory.create({
        data: {
          userId, gameType: 'MINES', betAmount: game.betAmount,
          multiplier: mult, payout, result: 'WIN',
          gameData: { minesCount: game.minesCount, revealed: game.revealed, mines: game.mines },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      result: 'WIN', multiplier: parseFloat(mult.toFixed(4)),
      payout: parseFloat(payout.toFixed(2)), mines: game.mines,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (err) {
    console.error('[MINES] cashoutMines:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── JUEGO: PLINKO ────────────────────────────────────────────────────────────
const PLINKO_MULTIPLIERS = {
  low:  [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
  mid:  [13,  3,   1.3, 0.7, 0.4, 0.7, 1.3, 3,   13],
  high: [29,  4,   1.5, 0.3, 0.2, 0.3, 1.5, 4,   29],
};

const playPlinko = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, risk } = req.body;

    if (!['low', 'mid', 'high'].includes(risk)) {
      return res.status(400).json({ error: 'Riesgo inválido: low, mid o high' });
    }

    const parsedBet = parseFloat(betAmount);
    const wallet = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    const rows = 16;
    const path = [];
    let position = 0;

    for (let row = 0; row < rows; row++) {
      const goRight = secureRandom() < 0.5 ? 1 : 0;
      path.push(goRight);
      position += goRight;
    }

    const buckets = PLINKO_MULTIPLIERS[risk].length;
    const bucketIndex = Math.min(Math.floor(position / rows * buckets), buckets - 1);
    const multiplier = PLINKO_MULTIPLIERS[risk][bucketIndex] * (1 - HOUSE_EDGE);
    const payout = parsedBet * multiplier;
    const won = payout > parsedBet;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Plinko ${risk}: apuesta`, null);
      if (payout > 0) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Plinko ${risk}: x${multiplier.toFixed(4)}`, null);
      }
      await tx.gameHistory.create({
        data: {
          userId, gameType: 'PLINKO', betAmount: parsedBet,
          multiplier, payout, result: won ? 'WIN' : 'LOSS',
          gameData: { risk, path, bucketIndex, multiplier },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      path, bucketIndex,
      multiplier: parseFloat(multiplier.toFixed(4)),
      payout: parseFloat(payout.toFixed(2)),
      result: won ? 'WIN' : 'LOSS',
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (err) {
    console.error('[PLINKO] error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── JUEGO: RULETA EUROPEA ────────────────────────────────────────────────────
const ROULETTE_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

function getRouletteColor(num) {
  if (num === 0) return 'green';
  if (ROULETTE_REDS.includes(num)) return 'red';
  return 'black';
}

function calculateRoulettePayout(betType, betValue, result) {
  const num = result.number;
  const color = result.color;

  switch (betType) {
    case 'number': return parseInt(betValue) === num ? 36 : 0;
    case 'color':
      if (betValue === 'red'   && color === 'red')   return 2;
      if (betValue === 'black' && color === 'black') return 2;
      return 0;
    case 'parity':
      if (num === 0) return 0;
      if (betValue === 'even' && num % 2 === 0) return 2;
      if (betValue === 'odd'  && num % 2 !== 0) return 2;
      return 0;
    case 'dozen': {
      const d = parseInt(betValue);
      if (d === 1 && num >= 1  && num <= 12) return 3;
      if (d === 2 && num >= 13 && num <= 24) return 3;
      if (d === 3 && num >= 25 && num <= 36) return 3;
      return 0;
    }
    case 'half':
      if (num === 0) return 0;
      if (betValue === 'low'  && num >= 1  && num <= 18) return 2;
      if (betValue === 'high' && num >= 19 && num <= 36) return 2;
      return 0;
    default: return 0;
  }
}

const playRoulette = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, betType, betValue } = req.body;

    const validTypes = ['number', 'color', 'parity', 'dozen', 'half'];
    if (!validTypes.includes(betType)) {
      return res.status(400).json({ error: 'Tipo de apuesta inválido' });
    }

    const parsedBet = parseFloat(betAmount);
    const wallet = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    const number = Math.floor(secureRandom() * 37);
    const color = getRouletteColor(number);
    const result = { number, color };

    const payoutMult = calculateRoulettePayout(betType, betValue, result);
    const payout = parsedBet * payoutMult * (1 - HOUSE_EDGE);
    const won = payoutMult > 0;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Ruleta: apuesta ${betType}=${betValue}`, null);
      if (won && payout > 0) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Ruleta: ganó ${number} (${color})`, null);
      }
      await tx.gameHistory.create({
        data: {
          userId, gameType: 'ROULETTE', betAmount: parsedBet,
          multiplier: payoutMult > 0 ? payoutMult * (1 - HOUSE_EDGE) : 0,
          payout: won ? payout : 0, result: won ? 'WIN' : 'LOSS',
          gameData: { betType, betValue, number, color, payoutMult },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      result: won ? 'WIN' : 'LOSS', number, color, betType, betValue,
      payoutMultiplier: payoutMult,
      payout: won ? parseFloat(payout.toFixed(2)) : 0,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (err) {
    console.error('[ROULETTE] error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  playDice,
  playCoinflip,
  startCrash,
  cashoutCrash,
  getGameHistory,
  startMines,
  revealCell,
  cashoutMines,
  playPlinko,
  playRoulette,
};