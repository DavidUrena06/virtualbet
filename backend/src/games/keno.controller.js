// games/keno.controller.js
// Keno — el jugador elige entre 1 y 10 números de un universo 1-40.
// La casa sortea 10 números aleatorios. El pago depende de picks + matches.

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();

const secureRandom = () => {
  const buf = crypto.randomBytes(4);
  return buf.readUInt32BE(0) / 0xFFFFFFFF;
};

const UNIVERSE_MAX  = 40;
const DRAW_COUNT    = 10;
const MIN_PICKS     = 1;
const MAX_PICKS     = 10;

// Tabla de pagos: PAYTABLE[picks][matches] = multiplicador (0 = pierde)
// Mínimo de matches para ganar implícito (cualquier 0x es perder).
const PAYTABLE = {
  1:  { 1: 2.5 },
  2:  { 2: 5 },
  3:  { 2: 1.5,  3: 12 },
  4:  { 2: 1,    3: 4,    4: 20 },
  5:  { 3: 1.5,  4: 8,    5: 50 },
  6:  { 3: 1,    4: 4,    5: 20,  6: 100 },
  7:  { 4: 2,    5: 10,   6: 50,  7: 200 },
  8:  { 4: 1.5,  5: 6,    6: 25,  7: 100, 8: 500 },
  9:  { 4: 1,    5: 4,    6: 15,  7: 50,  8: 200,  9: 1000 },
  10: { 4: 1,    5: 3,    6: 10,  7: 30,  8: 100,  9: 500,  10: 2000 },
};

function drawNumbers() {
  // Sortea DRAW_COUNT números distintos del universo 1..UNIVERSE_MAX
  const pool = [];
  for (let i = 1; i <= UNIVERSE_MAX; i++) pool.push(i);
  // Fisher-Yates parcial — basta con barajar los primeros DRAW_COUNT
  for (let i = 0; i < DRAW_COUNT; i++) {
    const j = i + Math.floor(secureRandom() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, DRAW_COUNT).sort((a, b) => a - b);
}

function multiplierFor(picks, matches) {
  const row = PAYTABLE[picks];
  if (!row) return 0;
  return row[matches] || 0;
}

// POST /api/games/keno/play
const play = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, picks } = req.body;
    const bet = parseFloat(amount);

    if (!bet || bet < 1) return res.status(400).json({ error: 'Apuesta mínima: 1 BC' });
    if (bet > 10000)     return res.status(400).json({ error: 'Apuesta máxima: 10,000 BC' });

    if (!Array.isArray(picks) || picks.length < MIN_PICKS || picks.length > MAX_PICKS) {
      return res.status(400).json({ error: `Tenés que elegir entre ${MIN_PICKS} y ${MAX_PICKS} números` });
    }

    // Sanitiza y valida los picks
    const sanitized = [...new Set(picks.map(n => parseInt(n, 10)))]
      .filter(n => Number.isInteger(n) && n >= 1 && n <= UNIVERSE_MAX);

    if (sanitized.length !== picks.length) {
      return res.status(400).json({ error: `Números inválidos (deben ser únicos entre 1 y ${UNIVERSE_MAX})` });
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < bet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const drawn = drawNumbers();
    const drawnSet = new Set(drawn);
    const hits = sanitized.filter(n => drawnSet.has(n));
    const matches = hits.length;
    const multiplier = multiplierFor(sanitized.length, matches);
    const payout = parseFloat((bet * multiplier).toFixed(2));
    const won = multiplier > 0;

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -bet, 'GAME_BET',
        `Keno: ${sanitized.length} picks`, null);
      if (payout > 0) {
        await transferCoins(tx, userId, payout, 'GAME_WIN',
          `Keno: ${matches}/${sanitized.length} x${multiplier}`, null);
      }
      await tx.gameHistory.create({
        data: {
          userId,
          gameType:   'KENO',
          betAmount:  bet,
          multiplier: won ? multiplier : 0,
          payout:     won ? payout : 0,
          result:     won ? 'WIN' : 'LOSS',
          gameData: {
            picks:   sanitized,
            drawn,
            hits,
            matches,
            picksCount: sanitized.length,
          },
        },
      });
    });

    const updated = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      result:      won ? 'WIN' : 'LOSS',
      picks:       sanitized,
      drawn,
      hits,
      matches,
      multiplier:  won ? multiplier : 0,
      payout,
      bet,
      newBalance:  parseFloat(updated.balance),
    });
  } catch (err) {
    console.error('[KENO] play:', err.message);
    res.status(400).json({ error: err.message });
  }
};

module.exports = { play };
