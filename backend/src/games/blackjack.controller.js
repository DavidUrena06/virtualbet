// games/blackjack.controller.js
// Motor de Blackjack — toda la lógica crítica vive en el backend.
// El estado de la mano se persiste en GameHistory.gameData (JSON), nunca en
// memoria global, para sobrevivir reinicios del servidor.
//
// Reglas:
//   - Mazo estándar de 52 cartas, reshuffle en cada mano (deal).
//   - Jugador y casa reciben 2 cartas; una de la casa queda oculta.
//   - 2-10 valor nominal, J/Q/K = 10, A = 11 (o 1 si pasa de 21).
//   - Blackjack natural (21 con 2 cartas) paga 1.5x.
//   - Ganar normal paga 1x (devuelve apuesta + gana lo mismo).
//   - Empate (push) devuelve la apuesta.
//   - La casa pide carta hasta llegar a 17 o más.
//   - Con reglas estándar (dealer planta en 17, BJ 3:2) el house edge es ~0.5%.

const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();
const crypto = require('crypto');

// ─── RNG seguro (no manipulable desde frontend) ───────────────────────────────
const secureRandom = () => {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
};

// ─── Mazo ─────────────────────────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const buildDeck = () => {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
};

// Fisher-Yates con RNG seguro
const shuffle = (deck) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandom() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

const cardValue = (rank) => {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
};

// Suma una mano contando ases como 11 y reduciéndolos a 1 si hay bust.
const handTotal = (cards) => {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
};

const isBlackjack = (cards) => cards.length === 2 && handTotal(cards) === 21;
const isBust = (cards) => handTotal(cards) > 21;

// ─── Validación de apuesta (mismo criterio que games.controller) ──────────────
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

// ─── Carga y validación de una mano activa desde GameHistory ──────────────────
const loadActiveHand = async (handId, userId) => {
  if (!handId) throw new Error('handId requerido');
  const hand = await prisma.gameHistory.findUnique({ where: { id: handId } });
  if (!hand || hand.gameType !== 'BLACKJACK') throw new Error('Mano no encontrada');
  if (hand.userId !== userId) throw new Error('Esta mano no te pertenece');
  if (hand.gameData?.status !== 'active') throw new Error('La mano ya terminó');
  return hand;
};

// ─── Resolución de la mano: la casa juega y se calcula el pago ─────────────────
// Devuelve el detalle final (cartas, totales, resultado, multiplicador, payout).
// payout = monto acreditado a la wallet (apuesta incluida).
const resolveHand = (state) => {
  const { playerCards, betAmount } = state;
  let { dealerCards, deck } = state;

  const playerTotal = handTotal(playerCards);
  const playerBJ = isBlackjack(playerCards);
  const dealerBJ = isBlackjack(dealerCards);

  let result, multiplier, payout;

  if (isBust(playerCards)) {
    // El jugador ya se pasó: pierde sin que la casa juegue.
    result = 'LOSS';
    multiplier = 0;
    payout = 0;
  } else {
    // La casa pide hasta 17 o más (planta en 17, incluido soft 17).
    while (handTotal(dealerCards) < 17) {
      dealerCards = [...dealerCards, deck.shift()];
    }
    const dealerTotal = handTotal(dealerCards);

    if (playerBJ && !dealerBJ) {
      result = 'WIN';
      multiplier = 2.5;            // gana 1.5x + devolución de apuesta
      payout = betAmount * 2.5;
    } else if (playerBJ && dealerBJ) {
      result = 'REFUND';           // ambos blackjack → push
      multiplier = 1;
      payout = betAmount;
    } else if (isBust(dealerCards)) {
      result = 'WIN';
      multiplier = 2;
      payout = betAmount * 2;
    } else if (playerTotal > dealerTotal) {
      result = 'WIN';
      multiplier = 2;
      payout = betAmount * 2;
    } else if (playerTotal === dealerTotal) {
      result = 'REFUND';
      multiplier = 1;
      payout = betAmount;
    } else {
      result = 'LOSS';
      multiplier = 0;
      payout = 0;
    }
  }

  return {
    dealerCards,
    deck,
    playerTotal,
    dealerTotal: handTotal(dealerCards),
    result,
    multiplier,
    payout: parseFloat(payout.toFixed(2)),
  };
};

// Aplica el pago (si corresponde) y cierra el registro de la mano.
const finalizeHand = async (hand, finalState, resolution) => {
  const { userId } = hand;
  const { result, multiplier, payout } = resolution;

  await prisma.$transaction(async (tx) => {
    if (payout > 0) {
      const note = result === 'REFUND'
        ? 'Blackjack: empate (push)'
        : `Blackjack: ganaste x${multiplier}`;
      await transferCoins(tx, userId, payout, 'GAME_WIN', note, hand.id);
    }
    await tx.gameHistory.update({
      where: { id: hand.id },
      data: {
        multiplier,
        payout,
        result,
        gameData: { ...finalState, status: 'finished', result },
      },
    });
  });
};

// ─── POST /api/games/blackjack/deal ───────────────────────────────────────────
const deal = async (req, res) => {
  try {
    const userId = req.user.id;
    const parsedBet = parseFloat(req.body.amount);
    await validateBet(userId, parsedBet);

    const deck = shuffle(buildDeck());
    const playerCards = [deck.shift(), deck.shift()];
    const dealerCards = [deck.shift(), deck.shift()];

    // Debita la apuesta y crea el registro de la mano (estado activo).
    const hand = await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedBet, 'GAME_BET', 'Blackjack: apuesta', null);
      return tx.gameHistory.create({
        data: {
          userId,
          gameType: 'BLACKJACK',
          betAmount: parsedBet,
          multiplier: 0,
          payout: 0,
          result: 'LOSS', // placeholder mientras la mano está activa
          gameData: {
            status: 'active',
            betAmount: parsedBet,
            deck,
            playerCards,
            dealerCards,
            doubled: false,
          },
        },
      });
    });

    const playerTotal = handTotal(playerCards);
    const playerBJ = isBlackjack(playerCards);

    // Si el jugador saca blackjack natural, la mano se resuelve de inmediato.
    if (playerBJ) {
      const resolution = resolveHand({ playerCards, dealerCards, deck, betAmount: parsedBet });
      const finalState = {
        betAmount: parsedBet,
        deck: resolution.deck,
        playerCards,
        dealerCards: resolution.dealerCards,
        doubled: false,
      };
      await finalizeHand(hand, finalState, resolution);
      const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
      return res.json({
        handId: hand.id,
        status: 'finished',
        playerCards,
        playerTotal,
        dealerCards: resolution.dealerCards, // ambas cartas visibles al resolver
        dealerTotal: resolution.dealerTotal,
        result: resolution.result,
        multiplier: resolution.multiplier,
        payout: resolution.payout,
        betAmount: parsedBet,
        newBalance: parseFloat(updatedWallet.balance),
      });
    }

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      handId: hand.id,
      status: 'active',
      playerCards,
      playerTotal,
      dealerCards: [dealerCards[0], { hidden: true }], // una carta oculta
      dealerVisibleTotal: cardValue(dealerCards[0].rank),
      betAmount: parsedBet,
      canDouble: parseFloat(updatedWallet.balance) >= parsedBet,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[BLACKJACK] deal:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── POST /api/games/blackjack/hit ────────────────────────────────────────────
const hit = async (req, res) => {
  try {
    const userId = req.user.id;
    const hand = await loadActiveHand(req.body.handId, userId);

    const state = hand.gameData;
    const deck = state.deck;
    const newCard = deck.shift();
    const playerCards = [...state.playerCards, newCard];
    const playerTotal = handTotal(playerCards);

    const baseState = {
      betAmount: state.betAmount,
      deck,
      playerCards,
      dealerCards: state.dealerCards,
      doubled: state.doubled,
    };

    // Si el jugador se pasa, la mano termina al instante (pierde).
    if (isBust(playerCards)) {
      const resolution = {
        dealerCards: state.dealerCards,
        playerTotal,
        dealerTotal: handTotal(state.dealerCards),
        result: 'LOSS',
        multiplier: 0,
        payout: 0,
      };
      await finalizeHand(hand, baseState, resolution);
      const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
      return res.json({
        handId: hand.id,
        status: 'finished',
        card: newCard,
        playerCards,
        playerTotal,
        dealerCards: state.dealerCards,
        dealerTotal: handTotal(state.dealerCards),
        result: 'LOSS',
        payout: 0,
        newBalance: parseFloat(updatedWallet.balance),
      });
    }

    // Sigue activa: guardamos el nuevo estado.
    await prisma.gameHistory.update({
      where: { id: hand.id },
      data: { gameData: { ...baseState, status: 'active', betAmount: state.betAmount } },
    });

    res.json({
      handId: hand.id,
      status: 'active',
      card: newCard,
      playerCards,
      playerTotal,
      canDouble: false, // ya hay más de 2 cartas
    });
  } catch (error) {
    console.error('[BLACKJACK] hit:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── POST /api/games/blackjack/stand ──────────────────────────────────────────
const stand = async (req, res) => {
  try {
    const userId = req.user.id;
    const hand = await loadActiveHand(req.body.handId, userId);

    const state = hand.gameData;
    const resolution = resolveHand({
      playerCards: state.playerCards,
      dealerCards: state.dealerCards,
      deck: state.deck,
      betAmount: state.betAmount,
    });

    const finalState = {
      betAmount: state.betAmount,
      deck: resolution.deck,
      playerCards: state.playerCards,
      dealerCards: resolution.dealerCards,
      doubled: state.doubled,
    };
    await finalizeHand(hand, finalState, resolution);

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      handId: hand.id,
      status: 'finished',
      playerCards: state.playerCards,
      playerTotal: resolution.playerTotal,
      dealerCards: resolution.dealerCards,
      dealerTotal: resolution.dealerTotal,
      result: resolution.result,
      multiplier: resolution.multiplier,
      payout: resolution.payout,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[BLACKJACK] stand:', error.message);
    res.status(400).json({ error: error.message });
  }
};

// ─── POST /api/games/blackjack/double ─────────────────────────────────────────
const double = async (req, res) => {
  try {
    const userId = req.user.id;
    const hand = await loadActiveHand(req.body.handId, userId);

    const state = hand.gameData;
    if (state.playerCards.length !== 2) {
      return res.status(400).json({ error: 'Solo podés doblar con 2 cartas' });
    }

    const extraBet = state.betAmount;
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balance) < extraBet) {
      return res.status(400).json({ error: 'Saldo insuficiente para doblar' });
    }

    const deck = state.deck;
    const newCard = deck.shift();
    const playerCards = [...state.playerCards, newCard];
    const totalBet = state.betAmount * 2;

    // Debita la apuesta extra antes de resolver.
    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -extraBet, 'GAME_BET', 'Blackjack: doblar apuesta', hand.id);
    });

    let resolution;
    if (isBust(playerCards)) {
      resolution = {
        dealerCards: state.dealerCards,
        playerTotal: handTotal(playerCards),
        dealerTotal: handTotal(state.dealerCards),
        result: 'LOSS',
        multiplier: 0,
        payout: 0,
      };
    } else {
      // Recibió su carta y planta: la casa juega.
      resolution = resolveHand({
        playerCards,
        dealerCards: state.dealerCards,
        deck,
        betAmount: totalBet,
      });
    }

    const finalState = {
      betAmount: totalBet,
      deck: resolution.deck || deck,
      playerCards,
      dealerCards: resolution.dealerCards,
      doubled: true,
    };
    // El betAmount registrado pasa a ser el total apostado.
    await prisma.$transaction(async (tx) => {
      if (resolution.payout > 0) {
        const note = resolution.result === 'REFUND'
          ? 'Blackjack: empate (push)'
          : `Blackjack: ganaste x${resolution.multiplier}`;
        await transferCoins(tx, userId, resolution.payout, 'GAME_WIN', note, hand.id);
      }
      await tx.gameHistory.update({
        where: { id: hand.id },
        data: {
          betAmount: totalBet,
          multiplier: resolution.multiplier,
          payout: resolution.payout,
          result: resolution.result,
          gameData: { ...finalState, status: 'finished', result: resolution.result },
        },
      });
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    res.json({
      handId: hand.id,
      status: 'finished',
      card: newCard,
      playerCards,
      playerTotal: resolution.playerTotal,
      dealerCards: resolution.dealerCards,
      dealerTotal: resolution.dealerTotal,
      result: resolution.result,
      multiplier: resolution.multiplier,
      payout: resolution.payout,
      betAmount: totalBet,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[BLACKJACK] double:', error.message);
    res.status(400).json({ error: error.message });
  }
};

module.exports = { deal, hit, stand, double };
