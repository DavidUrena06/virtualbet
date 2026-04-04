// games/games.controller.js  — SECCIÓN NUEVOS JUEGOS
// Agregar estas funciones al archivo existente games.controller.js

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();
const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE) || 0.03;

function secureRandom() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF;
}

// ════════════════════════════════════════════════════════════════════
// JUEGO: MINES
// El jugador elige cuántas minas (1-24) en un tablero 5x5 (25 celdas).
// Cada vez que destapa una celda segura, el multiplicador sube.
// Si destapa una mina, pierde todo.
// ════════════════════════════════════════════════════════════════════

// Inicia una partida de Mines: genera el tablero secreto en backend
const startMines = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, minesCount } = req.body;

    const parsedBet   = parseFloat(betAmount);
    const parsedMines = parseInt(minesCount);

    if (parsedMines < 1 || parsedMines > 24) {
      return res.status(400).json({ error: 'Minas: entre 1 y 24' });
    }

    // Valida saldo
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    // Genera posiciones de minas aleatoriamente (0-24)
    const allCells = Array.from({ length: 25 }, (_, i) => i);
    const mines = new Set();
    while (mines.size < parsedMines) {
      mines.add(Math.floor(secureRandom() * 25));
    }

    const gameId = crypto.randomBytes(8).toString('hex');

    // Guarda el estado en memoria (en producción → Redis)
    if (!global.minesGames) global.minesGames = new Map();
    global.minesGames.set(gameId, {
      userId,
      betAmount: parsedBet,
      minesCount: parsedMines,
      mines: [...mines],
      revealed: [],       // celdas reveladas
      status: 'playing',
      startedAt: Date.now(),
    });

    // Cobra la apuesta
    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Mines: inicio partida ${gameId}`, gameId);
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      gameId,
      minesCount: parsedMines,
      totalCells: 25,
      newBalance: parseFloat(updatedWallet.balance),
      message: 'Partida iniciada. Destapá celdas para ganar.',
    });
  } catch (err) {
    console.error('[MINES] startMines:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// Calcula el multiplicador de Mines según celdas reveladas
function minesMultiplier(totalCells, minesCount, revealed) {
  // Fórmula: producto de (celdas_seguras / celdas_restantes) por cada reveal
  // ajustado por house edge
  let mult = 1;
  const safe = totalCells - minesCount;
  for (let i = 0; i < revealed; i++) {
    const remaining = totalCells - i;
    const safeRemaining = safe - i;
    mult *= remaining / safeRemaining;
  }
  return mult * (1 - HOUSE_EDGE);
}

// Revela una celda
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
      // PERDIÓ — termina la partida
      game.status = 'lost';
      global.minesGames.set(gameId, game);

      await prisma.gameHistory.create({
        data: {
          userId,
          gameType: 'MINES',
          betAmount: game.betAmount,
          multiplier: 0,
          payout: 0,
          result: 'LOSS',
          gameData: {
            minesCount: game.minesCount,
            mines: game.mines,
            revealed: game.revealed,
            hitCell: cellIndex,
          },
        },
      });

      global.minesGames.delete(gameId);

      return res.json({
        result: 'MINE',
        cellIndex,
        mines: game.mines,   // Revela todas las minas al perder
        revealed: game.revealed,
        gameOver: true,
        message: '💣 ¡Encontraste una mina!',
      });
    }

    // CELDA SEGURA — suma al reveal
    game.revealed.push(cellIndex);
    global.minesGames.set(gameId, game);

    const mult = minesMultiplier(25, game.minesCount, game.revealed.length);
    const currentPayout = game.betAmount * mult;

    res.json({
      result: 'SAFE',
      cellIndex,
      revealed: game.revealed,
      multiplier: parseFloat(mult.toFixed(4)),
      currentPayout: parseFloat(currentPayout.toFixed(2)),
      gameOver: false,
    });
  } catch (err) {
    console.error('[MINES] revealCell:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// Cashout de Mines — el jugador decide cobrar antes de seguir
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

    const mult    = minesMultiplier(25, game.minesCount, game.revealed.length);
    const payout  = game.betAmount * mult;

    game.status = 'won';
    global.minesGames.delete(gameId);

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, payout, 'GAME_WIN',
        `Mines: cashout x${mult.toFixed(4)}`, gameId);

      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'MINES',
          betAmount: game.betAmount,
          multiplier: mult,
          payout,
          result: 'WIN',
          gameData: {
            minesCount: game.minesCount,
            revealed: game.revealed,
            mines: game.mines,
          },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result: 'WIN',
      multiplier: parseFloat(mult.toFixed(4)),
      payout: parseFloat(payout.toFixed(2)),
      mines: game.mines,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (err) {
    console.error('[MINES] cashoutMines:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════
// JUEGO: PLINKO
// Una bola cae por un tablero de 16 filas con pegs.
// El multiplicador depende del bucket donde cae (distribución normal).
// ════════════════════════════════════════════════════════════════════

// Tabla de multiplicadores por riesgo y posición del bucket
const PLINKO_MULTIPLIERS = {
  low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
  mid: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
  high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
};

const playPlinko = async (req, res) => {
  try {
    const userId = req.user.id;
    const { betAmount, risk } = req.body;

    if (!['low', 'mid', 'high'].includes(risk)) {
      return res.status(400).json({ error: 'Riesgo inválido: low, mid o high' });
    }

    const parsedBet = parseFloat(betAmount);
    const wallet    = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    // Simula la trayectoria de la bola por 16 filas
    // En cada peg, la bola cae izquierda (0) o derecha (1)
    const rows = 16;
    const path = [];
    let position = 0; // empieza en el centro

    for (let row = 0; row < rows; row++) {
      const goRight = secureRandom() < 0.5 ? 1 : 0;
      path.push(goRight);
      position += goRight;
    }

    // position va de 0 a 16 → mapear a 9 buckets
    const buckets = PLINKO_MULTIPLIERS[risk].length;
    const bucketIndex = Math.min(Math.floor(position / rows * buckets), buckets - 1);
    const multiplier  = PLINKO_MULTIPLIERS[risk][bucketIndex] * (1 - HOUSE_EDGE);
    const payout      = parsedBet * multiplier;
    const won         = payout > parsedBet;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Plinko ${risk}: apuesta`, null);

      if (payout > 0) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Plinko ${risk}: x${multiplier.toFixed(4)}`, null);
      }

      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'PLINKO',
          betAmount: parsedBet,
          multiplier,
          payout,
          result: won ? 'WIN' : 'LOSS',
          gameData: { risk, path, bucketIndex, multiplier },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      path,           // trayectoria para animar en el frontend
      bucketIndex,
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

// ════════════════════════════════════════════════════════════════════
// JUEGO: RULETA EUROPEA
// 37 números (0-36). El jugador apuesta a número exacto, color o docena.
// House edge 2.7% (un cero verde)
// ════════════════════════════════════════════════════════════════════

// Colores de la ruleta europea
const ROULETTE_REDS   = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const ROULETTE_BLACKS = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35];

function getRouletteColor(num) {
  if (num === 0) return 'green';
  if (ROULETTE_REDS.includes(num)) return 'red';
  return 'black';
}

// Payouts por tipo de apuesta
function calculateRoulettePayout(betType, betValue, result) {
  const num   = result.number;
  const color = result.color;

  switch (betType) {
    case 'number':   // Número exacto → paga 35:1
      return parseInt(betValue) === num ? 36 : 0;

    case 'color':    // Rojo/Negro → paga 1:1
      if (betValue === 'red'   && color === 'red')   return 2;
      if (betValue === 'black' && color === 'black') return 2;
      return 0;

    case 'parity':   // Par/Impar → paga 1:1 (el 0 pierde)
      if (num === 0) return 0;
      if (betValue === 'even' && num % 2 === 0) return 2;
      if (betValue === 'odd'  && num % 2 !== 0) return 2;
      return 0;

    case 'dozen':    // Docena → paga 2:1
      const d = parseInt(betValue); // 1, 2 o 3
      if (d === 1 && num >= 1  && num <= 12) return 3;
      if (d === 2 && num >= 13 && num <= 24) return 3;
      if (d === 3 && num >= 25 && num <= 36) return 3;
      return 0;

    case 'half':     // Mitad → paga 1:1 (1-18 o 19-36)
      if (num === 0) return 0;
      if (betValue === 'low'  && num >= 1  && num <= 18) return 2;
      if (betValue === 'high' && num >= 19 && num <= 36) return 2;
      return 0;

    default:
      return 0;
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
    const wallet    = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet || parseFloat(wallet.balance) < parsedBet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (parsedBet < 1 || parsedBet > 10000) {
      return res.status(400).json({ error: 'Apuesta: 1-10,000' });
    }

    // Gira la ruleta
    const number = Math.floor(secureRandom() * 37); // 0-36
    const color  = getRouletteColor(number);
    const result = { number, color };

    // Calcula payout (multiplicador sobre la apuesta)
    const payoutMult = calculateRoulettePayout(betType, betValue, result);
    const payout     = parsedBet * payoutMult * (1 - HOUSE_EDGE);
    const won        = payoutMult > 0;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET',
        `Ruleta: apuesta ${betType}=${betValue}`, null);

      if (won && payout > 0) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Ruleta: ganó ${number} (${color})`, null);
      }

      await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'ROULETTE',
          betAmount: parsedBet,
          multiplier: payoutMult > 0 ? payoutMult * (1 - HOUSE_EDGE) : 0,
          payout: won ? payout : 0,
          result: won ? 'WIN' : 'LOSS',
          gameData: { betType, betValue, number, color, payoutMult },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result: won ? 'WIN' : 'LOSS',
      number,
      color,
      betType,
      betValue,
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
  startMines, revealCell, cashoutMines,
  playPlinko,
  playRoulette,
};
