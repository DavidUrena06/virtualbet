// games/blackjack.controller.js
// Blackjack clásico — mazo de 52 cartas, reshufflea cada mano.
// Dealer planta en 17. Blackjack natural paga 1.5x. Empate devuelve apuesta.
//
// Persistencia: el estado de la mano se guarda en GameHistory.gameData (JSON).
// El gameId expuesto al cliente == GameHistory.id (UUID).
// gameData.status: 'ACTIVE' mientras el jugador puede actuar, 'RESOLVED' cuando termina.

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();

// ─── RNG seguro ──────────────────────────────────────────────────────────────
const secureRandom = () => {
  const buf = crypto.randomBytes(4);
  return buf.readUInt32BE(0) / 0xFFFFFFFF;
};

// ─── Mazo y cartas ───────────────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createShuffledDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  // Fisher-Yates con RNG seguro
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandom() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  if (card.rank === 'A') return 11;
  if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
  return parseInt(card.rank, 10);
}

function handTotal(cards) {
  let total = cards.reduce((s, c) => s + cardValue(c), 0);
  let aces  = cards.filter(c => c.rank === 'A').length;
  // Si el total > 21 y hay ases, contarlos como 1 (-10 cada uno)
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

const isBlackjack = (cards) => cards.length === 2 && handTotal(cards) === 21;

// ─── Carga la mano activa por gameId ─────────────────────────────────────────
async function loadActiveHand(gameId, userId) {
  if (!gameId) throw new Error('gameId requerido');

  const hand = await prisma.gameHistory.findUnique({ where: { id: gameId } });
  if (!hand)                              throw new Error('Mano no encontrada');
  if (hand.userId !== userId)             throw new Error('Esta mano no te pertenece');
  if (hand.gameType !== 'BLACKJACK')      throw new Error('Tipo de juego incorrecto');
  if (!hand.gameData || hand.gameData.status !== 'ACTIVE') {
    throw new Error('Esta mano ya fue resuelta');
  }
  return hand;
}

// ─── Helper: dealer juega hasta 17 y devuelve resultado de la ronda ──────────
async function dealerPlayAndResolve(hand, userId, effectiveBet) {
  const data = hand.gameData;
  const deck = [...data.deck];
  const dealerCards = [...data.dealerCards];

  while (handTotal(dealerCards) < 17) {
    dealerCards.push(deck.shift());
  }

  const playerTotal = handTotal(data.playerCards);
  const dealerTotal = handTotal(dealerCards);

  let outcome;  // 'WIN' | 'LOSS' | 'PUSH'
  let payout;   // moneda a acreditar (stake + ganancia, o stake en push)
  let multiplier;
  let label;

  if (dealerTotal > 21 || playerTotal > dealerTotal) {
    outcome    = 'WIN';
    payout     = effectiveBet * 2;   // stake devuelto + 1x ganancia
    multiplier = 2;
    label      = dealerTotal > 21 ? 'Casa se pasó' : 'Ganaste';
  } else if (playerTotal < dealerTotal) {
    outcome    = 'LOSS';
    payout     = 0;
    multiplier = 0;
    label      = 'Perdiste';
  } else {
    outcome    = 'PUSH';
    payout     = effectiveBet;       // devuelve el stake
    multiplier = 1;
    label      = 'Empate';
  }

  await prisma.$transaction(async (tx) => {
    if (payout > 0) {
      await transferCoins(tx, userId, payout, 'GAME_WIN', `Blackjack: ${label}`, null);
    }
    await tx.gameHistory.update({
      where: { id: hand.id },
      data: {
        result:     outcome === 'WIN' ? 'WIN' : outcome === 'PUSH' ? 'REFUND' : 'LOSS',
        payout,
        multiplier,
        gameData: {
          ...data,
          status:      'RESOLVED',
          dealerCards,
          deck,
          dealerTotal,
          playerTotal,
          outcome,
        },
      },
    });
  });

  return { dealerCards, dealerTotal, playerTotal, outcome, payout, multiplier };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/games/blackjack/deal
// ═══════════════════════════════════════════════════════════════════════════
const deal = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;
    const bet = parseFloat(amount);

    if (!bet || bet < 1)     return res.status(400).json({ error: 'Apuesta mínima: 1 BC' });
    if (bet > 10000)         return res.status(400).json({ error: 'Apuesta máxima: 10,000 BC' });

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < bet) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const deck = createShuffledDeck();
    const playerCards = [deck.shift(), deck.shift()];
    const dealerCards = [deck.shift(), deck.shift()];
    const playerBJ = isBlackjack(playerCards);
    const dealerBJ = isBlackjack(dealerCards);

    // Estado inicial
    let status     = 'ACTIVE';
    let outcome    = null;
    let payout     = 0;
    let multiplier = 0;
    let result     = 'LOSS'; // placeholder mientras está ACTIVE

    if (playerBJ && dealerBJ) {
      status = 'RESOLVED'; outcome = 'PUSH';
      payout = bet; multiplier = 1; result = 'REFUND';
    } else if (playerBJ) {
      status = 'RESOLVED'; outcome = 'PLAYER_BLACKJACK';
      payout = bet * 2.5; multiplier = 2.5; result = 'WIN';
    } else if (dealerBJ) {
      status = 'RESOLVED'; outcome = 'DEALER_BLACKJACK';
      payout = 0; multiplier = 0; result = 'LOSS';
    }

    const hand = await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -bet, 'GAME_BET', 'Blackjack: apuesta', null);
      if (payout > 0) {
        const note = outcome === 'PUSH' ? 'Blackjack: empate (ambos BJ)' : 'Blackjack: ¡Blackjack natural!';
        await transferCoins(tx, userId, payout, 'GAME_WIN', note, null);
      }
      return tx.gameHistory.create({
        data: {
          userId,
          gameType:  'BLACKJACK',
          betAmount: bet,
          multiplier,
          payout,
          result,
          gameData: {
            status,
            playerCards,
            dealerCards,
            deck,
            bet,
            doubled:   false,
            outcome,
          },
        },
      });
    });

    const updated = await prisma.wallet.findUnique({ where: { userId } });

    // Cuando hay blackjack natural, mostramos las dos cartas de la casa.
    // Si no, ocultamos la segunda (sólo visible la primera).
    const dealerForClient = status === 'RESOLVED'
      ? dealerCards
      : [dealerCards[0], { hidden: true }];

    const dealerTotalForClient = status === 'RESOLVED'
      ? handTotal(dealerCards)
      : cardValue(dealerCards[0]);

    const stateName =
      status === 'ACTIVE'              ? 'PLAYER_TURN' :
      outcome === 'PUSH'               ? 'PUSH' :
      outcome === 'PLAYER_BLACKJACK'   ? 'PLAYER_BLACKJACK' :
      outcome === 'DEALER_BLACKJACK'   ? 'DEALER_BLACKJACK' : 'PLAYER_TURN';

    res.json({
      gameId:        hand.id,
      playerCards,
      playerTotal:   handTotal(playerCards),
      dealerCards:   dealerForClient,
      dealerTotal:   dealerTotalForClient,
      state:         stateName,
      bet,
      payout,
      newBalance:    parseFloat(updated.balance),
    });
  } catch (err) {
    console.error('[BLACKJACK] deal:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/games/blackjack/hit
// ═══════════════════════════════════════════════════════════════════════════
const hit = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId } = req.body;
    const hand = await loadActiveHand(gameId, userId);
    const data = hand.gameData;

    const deck = [...data.deck];
    const playerCards = [...data.playerCards, deck.shift()];
    const total = handTotal(playerCards);

    if (total > 21) {
      // Bust → pierde, mano resuelta
      const effectiveBet = parseFloat(hand.betAmount);
      await prisma.gameHistory.update({
        where: { id: hand.id },
        data: {
          result:     'LOSS',
          payout:     0,
          multiplier: 0,
          gameData: {
            ...data,
            status:      'RESOLVED',
            playerCards,
            deck,
            playerTotal: total,
            dealerTotal: handTotal(data.dealerCards),
            outcome:     'PLAYER_BUST',
          },
        },
      });
      const w = await prisma.wallet.findUnique({ where: { userId } });
      return res.json({
        gameId,
        playerCards,
        playerTotal: total,
        dealerCards: data.dealerCards,
        dealerTotal: handTotal(data.dealerCards),
        state:       'PLAYER_BUST',
        payout:      0,
        bet:         effectiveBet,
        newBalance:  parseFloat(w.balance),
      });
    }

    // Continúa la mano
    await prisma.gameHistory.update({
      where: { id: hand.id },
      data: { gameData: { ...data, playerCards, deck } },
    });

    res.json({
      gameId,
      playerCards,
      playerTotal: total,
      state:       'PLAYER_TURN',
    });
  } catch (err) {
    console.error('[BLACKJACK] hit:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/games/blackjack/stand
// ═══════════════════════════════════════════════════════════════════════════
const stand = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId } = req.body;
    const hand = await loadActiveHand(gameId, userId);
    const effectiveBet = parseFloat(hand.betAmount);

    const resolved = await dealerPlayAndResolve(hand, userId, effectiveBet);
    const w = await prisma.wallet.findUnique({ where: { userId } });

    const stateName =
      resolved.outcome === 'WIN'  ? 'PLAYER_WIN'  :
      resolved.outcome === 'LOSS' ? 'DEALER_WIN'  : 'PUSH';

    res.json({
      gameId,
      playerCards: hand.gameData.playerCards,
      playerTotal: resolved.playerTotal,
      dealerCards: resolved.dealerCards,
      dealerTotal: resolved.dealerTotal,
      state:       stateName,
      payout:      resolved.payout,
      bet:         effectiveBet,
      newBalance:  parseFloat(w.balance),
    });
  } catch (err) {
    console.error('[BLACKJACK] stand:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/games/blackjack/double
// ═══════════════════════════════════════════════════════════════════════════
const double = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId } = req.body;
    const hand = await loadActiveHand(gameId, userId);
    const data = hand.gameData;

    if (data.playerCards.length !== 2) {
      return res.status(400).json({ error: 'Solo podés doblar con tus 2 cartas iniciales' });
    }
    if (data.doubled) {
      return res.status(400).json({ error: 'Ya doblaste esta mano' });
    }

    const originalBet = parseFloat(hand.betAmount);
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < originalBet) {
      return res.status(400).json({ error: 'Saldo insuficiente para doblar' });
    }

    // Debita lo adicional y reparte exactamente 1 carta
    const deck = [...data.deck];
    const playerCards = [...data.playerCards, deck.shift()];
    const playerTotal = handTotal(playerCards);
    const totalBet = originalBet * 2;

    // Primero el débito de la apuesta extra (siempre)
    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -originalBet, 'GAME_BET', 'Blackjack: doblar', null);
      await tx.gameHistory.update({
        where: { id: hand.id },
        data: {
          betAmount: totalBet,
          gameData: { ...data, playerCards, deck, doubled: true },
        },
      });
    });

    // Si bust con la carta del doble → pierde el total
    if (playerTotal > 21) {
      await prisma.gameHistory.update({
        where: { id: hand.id },
        data: {
          result:     'LOSS',
          payout:     0,
          multiplier: 0,
          gameData: {
            ...data,
            status:      'RESOLVED',
            playerCards,
            deck,
            doubled:     true,
            playerTotal,
            dealerTotal: handTotal(data.dealerCards),
            outcome:     'PLAYER_BUST',
          },
        },
      });
      const w = await prisma.wallet.findUnique({ where: { userId } });
      return res.json({
        gameId,
        playerCards,
        playerTotal,
        dealerCards: data.dealerCards,
        dealerTotal: handTotal(data.dealerCards),
        state:       'PLAYER_BUST',
        payout:      0,
        bet:         totalBet,
        newBalance:  parseFloat(w.balance),
      });
    }

    // No bust → la casa juega y resolvemos con totalBet como apuesta efectiva
    const refreshedHand = await prisma.gameHistory.findUnique({ where: { id: hand.id } });
    const resolved = await dealerPlayAndResolve(refreshedHand, userId, totalBet);

    const w = await prisma.wallet.findUnique({ where: { userId } });
    const stateName =
      resolved.outcome === 'WIN'  ? 'PLAYER_WIN' :
      resolved.outcome === 'LOSS' ? 'DEALER_WIN' : 'PUSH';

    res.json({
      gameId,
      playerCards,
      playerTotal,
      dealerCards: resolved.dealerCards,
      dealerTotal: resolved.dealerTotal,
      state:       stateName,
      payout:      resolved.payout,
      bet:         totalBet,
      newBalance:  parseFloat(w.balance),
    });
  } catch (err) {
    console.error('[BLACKJACK] double:', err.message);
    res.status(400).json({ error: err.message });
  }
};

module.exports = { deal, hit, stand, double };
