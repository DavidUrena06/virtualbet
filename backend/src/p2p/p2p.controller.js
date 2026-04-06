// p2p/p2p.controller.js
// Apuestas entre amigos con BetCoins
// TODA la lógica crítica aquí — nunca en el frontend

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const HOUSE_COMMISSION = parseFloat(process.env.P2P_COMMISSION) || 0.05; // 5%

// ── Helper: bloquea BetCoins (los quita del balance disponible) ───────────
const lockBetCoins = async (tx, userId, amount, privateBetId) => {
  const wallet = await tx.wallet.findUnique({ where: { userId } });

  if (!wallet) throw new Error('Wallet no encontrada');

  const available = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance);

  if (available < amount) {
    throw new Error(`BetCoins insuficientes. Disponibles: ${available.toFixed(2)} BC`);
  }

  // Incrementa el balance bloqueado (no toca el balance total todavía)
  await tx.wallet.update({
    where: { userId },
    data: { lockedBalance: { increment: amount } },
  });

  // Registra en el ledger como movimiento de bloqueo
  await tx.transaction.create({
    data: {
      userId,
      walletId:      wallet.id,
      type:          'P2P_BET_LOCK',
      amount,
      balanceBefore: wallet.balance,
      balanceAfter:  wallet.balance, // balance total no cambia aún, solo el bloqueado
      reference:     privateBetId,
      note:          `BetCoins bloqueados en apuesta P2P`,
    },
  });
};

// ── Helper: descuenta BetCoins bloqueados del balance real ────────────────
const deductLockedCoins = async (tx, userId, amount, walletId) => {
  await tx.wallet.update({
    where: { userId },
    data: {
      balance:       { decrement: amount },
      lockedBalance: { decrement: amount },
      totalWagered:  { increment: amount },
    },
  });
};

// ── Helper: paga BetCoins ganados ─────────────────────────────────────────
const payBetCoins = async (tx, userId, amount, privateBetId, note) => {
  const wallet = await tx.wallet.findUnique({ where: { userId } });

  const newBalance = parseFloat(wallet.balance) + amount;

  await tx.wallet.update({
    where: { userId },
    data: { balance: newBalance, totalWon: { increment: amount } },
  });

  await tx.transaction.create({
    data: {
      userId,
      walletId:      wallet.id,
      type:          'P2P_BET_WIN',
      amount,
      balanceBefore: wallet.balance,
      balanceAfter:  newBalance,
      reference:     privateBetId,
      note,
    },
  });
};

// ══════════════════════════════════════════════════════════════
// CREAR APUESTA P2P
// ══════════════════════════════════════════════════════════════

const createPrivateBet = async (req, res) => {
  try {
    const creatorId = req.user.id;
    const { matchId, title, description, minAmount, maxParticipants, creatorSelection, creatorAmount } = req.body;

    const parsedMin    = parseFloat(minAmount);
    const parsedAmount = parseFloat(creatorAmount);

    if (parsedMin < 1)     return res.status(400).json({ error: 'Mínimo: 1 BC' });
    if (parsedAmount < parsedMin) {
      return res.status(400).json({ error: `Tu apuesta debe ser al menos ${parsedMin} BC` });
    }
    if (!['HOME','DRAW','AWAY'].includes(creatorSelection)) {
      return res.status(400).json({ error: 'Selección: HOME, DRAW o AWAY' });
    }

    // Verifica partido
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Solo se pueden crear apuestas en partidos UPCOMING' });
    }

    // Todo en una transacción atómica
    const privateBet = await prisma.$transaction(async (tx) => {
      // 1. Crea la apuesta
      const bet = await tx.privateBet.create({
        data: {
          creatorId,
          matchId,
          title,
          description,
          minAmount:       parsedMin,
          maxParticipants: parseInt(maxParticipants) || 10,
          houseCommission: HOUSE_COMMISSION,
          totalPool:       parsedAmount,
          status:          'OPEN',
        },
      });

      // 2. Agrega al creador como primer participante
      await tx.privateBetParticipant.create({
        data: {
          privateBetId: bet.id,
          userId:       creatorId,
          selection:    creatorSelection,
          amount:       parsedAmount,
          status:       'ACTIVE',
        },
      });

      // 3. Bloquea los BetCoins del creador
      await lockBetCoins(tx, creatorId, parsedAmount, bet.id);

      return bet;
    });

    res.status(201).json({
      message: 'Apuesta P2P creada. Invitá a tus amigos.',
      privateBet: {
        id:         privateBet.id,
        title:      privateBet.title,
        match:      `${match.teamHome} vs ${match.teamAway}`,
        minAmount:  parsedMin,
        totalPool:  parsedAmount,
        status:     'OPEN',
      },
    });
  } catch (err) {
    console.error('[P2P] createPrivateBet:', err);
    res.status(400).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// UNIRSE A APUESTA P2P
// ══════════════════════════════════════════════════════════════

const joinPrivateBet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { privateBetId, selection, amount } = req.body;

    if (!['HOME','DRAW','AWAY'].includes(selection)) {
      return res.status(400).json({ error: 'Selección: HOME, DRAW o AWAY' });
    }

    const parsedAmount = parseFloat(amount);

    const result = await prisma.$transaction(async (tx) => {
      // Lock de la fila para evitar race conditions
      const bet = await tx.privateBet.findUnique({
        where:   { id: privateBetId },
        include: { participants: true, match: true },
      });

      if (!bet) throw new Error('Apuesta no encontrada');
      if (bet.status !== 'OPEN') throw new Error('Esta apuesta ya no acepta participantes');
      if (new Date() >= bet.match.startsAt) throw new Error('El partido ya inició');

      // Verifica que no participa ya
      const alreadyIn = bet.participants.find(p => p.userId === userId);
      if (alreadyIn) throw new Error('Ya estás participando en esta apuesta');

      // Verifica límite de participantes
      if (bet.participants.length >= bet.maxParticipants) {
        throw new Error('La apuesta ya está llena');
      }

      // Verifica monto mínimo
      if (parsedAmount < parseFloat(bet.minAmount)) {
        throw new Error(`Mínimo ${bet.minAmount} BC`);
      }

      // 1. Agrega participante
      await tx.privateBetParticipant.create({
        data: {
          privateBetId,
          userId,
          selection,
          amount: parsedAmount,
          status: 'ACTIVE',
        },
      });

      // 2. Actualiza pool total
      await tx.privateBet.update({
        where: { id: privateBetId },
        data:  { totalPool: { increment: parsedAmount } },
      });

      // 3. Bloquea BetCoins del participante
      await lockBetCoins(tx, userId, parsedAmount, privateBetId);

      // 4. Notifica al creador
      await tx.notification.create({
        data: {
          userId:  bet.creatorId,
          type:    'P2P_NEW_PARTICIPANT',
          title:   'Nuevo participante',
          message: `${req.user.username} se unió a "${bet.title}" con ${parsedAmount} BC`,
          data:    { privateBetId, username: req.user.username },
        },
      });

      return bet;
    });

    // Obtiene la apuesta actualizada
    const updated = await prisma.privateBet.findUnique({
      where:   { id: privateBetId },
      include: { participants: { select: { selection: true, amount: true } } },
    });

    res.json({
      message: `Te uniste con ${parsedAmount} BC. Suerte!`,
      totalPool:    updated.totalPool,
      participants: updated.participants.length,
    });
  } catch (err) {
    console.error('[P2P] joinPrivateBet:', err);
    res.status(400).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// RESOLVER APUESTA P2P (lo llama el cron al resolver el partido)
// ══════════════════════════════════════════════════════════════

const resolvePrivateBet = async (privateBetId, matchResult) => {
  try {
    const bet = await prisma.privateBet.findUnique({
      where:   { id: privateBetId },
      include: { participants: true },
    });

    if (!bet || bet.status !== 'LOCKED') return;

    const totalPool = parseFloat(bet.totalPool);
    const commission = totalPool * parseFloat(bet.houseCommission);
    const distributable = totalPool - commission;

    // Identifica ganadores
    const winners = bet.participants.filter(p => p.selection === matchResult);
    const losers  = bet.participants.filter(p => p.selection !== matchResult);

    await prisma.$transaction(async (tx) => {
      if (winners.length === 0) {
        // Nadie acertó → reembolso a todos (sin comisión)
        for (const p of bet.participants) {
          const amount = parseFloat(p.amount);
          const wallet = await tx.wallet.findUnique({ where: { userId: p.userId } });

          // Devuelve el dinero y desbloquea
          await tx.wallet.update({
            where: { userId: p.userId },
            data:  { lockedBalance: { decrement: amount } },
          });

          await tx.transaction.create({
            data: {
              userId:        p.userId,
              walletId:      wallet.id,
              type:          'P2P_BET_REFUND',
              amount,
              balanceBefore: wallet.balance,
              balanceAfter:  wallet.balance,
              reference:     privateBetId,
              note:          'Reembolso: ningún participante acertó',
            },
          });

          await tx.privateBetParticipant.update({
            where: { id: p.id },
            data:  { status: 'REFUNDED', payout: amount, resolvedAt: new Date() },
          });

          await tx.notification.create({
            data: {
              userId:  p.userId,
              type:    'P2P_RESOLVED',
              title:   'Apuesta P2P resuelta',
              message: `Nadie acertó en "${bet.title}". Reembolso de ${amount} BC procesado.`,
              data:    { privateBetId, payout: amount },
            },
          });
        }
      } else {
        // Hay ganadores → distribución proporcional del pool distribuible
        const totalWinnerStake = winners.reduce((s, w) => s + parseFloat(w.amount), 0);

        // Paga a ganadores
        for (const w of winners) {
          const share = (parseFloat(w.amount) / totalWinnerStake) * distributable;
          const wallet = await tx.wallet.findUnique({ where: { userId: w.userId } });

          // 1. Descuenta el monto bloqueado del balance total
          await deductLockedCoins(tx, w.userId, parseFloat(w.amount), wallet.id);

          // 2. Paga la ganancia
          await payBetCoins(tx, w.userId, share, privateBetId,
            `Ganaste apuesta P2P "${bet.title}" x${(share / parseFloat(w.amount)).toFixed(4)}`);

          await tx.privateBetParticipant.update({
            where: { id: w.id },
            data:  { status: 'WON', payout: share, resolvedAt: new Date() },
          });

          await tx.notification.create({
            data: {
              userId:  w.userId,
              type:    'P2P_RESOLVED',
              title:   '¡Ganaste la apuesta P2P!',
              message: `Ganaste ${share.toFixed(2)} BC en "${bet.title}"`,
              data:    { privateBetId, payout: share },
            },
          });
        }

        // Descuenta BetCoins de perdedores (del balance real)
        for (const l of losers) {
          const wallet = await tx.wallet.findUnique({ where: { userId: l.userId } });
          await deductLockedCoins(tx, l.userId, parseFloat(l.amount), wallet.id);

          await tx.privateBetParticipant.update({
            where: { id: l.id },
            data:  { status: 'LOST', payout: 0, resolvedAt: new Date() },
          });

          await tx.notification.create({
            data: {
              userId:  l.userId,
              type:    'P2P_RESOLVED',
              title:   'Apuesta P2P resuelta',
              message: `Perdiste ${l.amount} BC en "${bet.title}"`,
              data:    { privateBetId, payout: 0 },
            },
          });
        }

        // Registra comisión de la casa
        await tx.privateBet.update({
          where: { id: privateBetId },
          data:  { commissionTaken: commission },
        });
      }

      // Marca apuesta como resuelta
      await tx.privateBet.update({
        where: { id: privateBetId },
        data:  { status: 'RESOLVED', resolvedAt: new Date() },
      });
    });

    console.log(`[P2P] Apuesta ${privateBetId} resuelta. Ganadores: ${winners.length}`);
  } catch (err) {
    console.error('[P2P] resolvePrivateBet:', err);
  }
};

// ══════════════════════════════════════════════════════════════
// RUTAS HTTP RESTANTES
// ══════════════════════════════════════════════════════════════

// Ver apuesta por ID
const getPrivateBet = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const bet = await prisma.privateBet.findUnique({
      where: { id },
      include: {
        match: { select: { teamHome: true, teamAway: true, league: true, startsAt: true, status: true, result: true } },
        creator: { select: { username: true, avatarEmoji: true } },
        participants: {
          select: {
            selection: true,
            amount: true,
            payout: true,
            status: true,
            user: { select: { username: true, avatarEmoji: true } },
          },
        },
      },
    });

    if (!bet) return res.status(404).json({ error: 'Apuesta no encontrada' });

    // Verifica que el usuario sea participante o el creador
    const isParticipant = bet.participants.some(p => p.user.username === req.user.username)
      || bet.creator.username === req.user.username;

    if (!isParticipant) {
      return res.status(403).json({ error: 'No tenés acceso a esta apuesta' });
    }

    const totalPool     = parseFloat(bet.totalPool);
    const distributable = totalPool * (1 - parseFloat(bet.houseCommission));

    res.json({
      bet: {
        ...bet,
        distributable: parseFloat(distributable.toFixed(2)),
        commission:    parseFloat((totalPool - distributable).toFixed(2)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener apuesta' });
  }
};

// Mis apuestas P2P (activas e historial)
const getMyPrivateBets = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    const participations = await prisma.privateBetParticipant.findMany({
      where: {
        userId,
        ...(status ? { privateBet: { status } } : {}),
      },
      orderBy: { joinedAt: 'desc' },
      include: {
        privateBet: {
          include: {
            match:   { select: { teamHome: true, teamAway: true, league: true, startsAt: true, result: true } },
            creator: { select: { username: true } },
            _count:  { select: { participants: true } },
          },
        },
      },
    });

    res.json({ participations });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener apuestas P2P' });
  }
};

// Cancelar apuesta P2P (solo el creador, solo si está OPEN)
const cancelPrivateBet = async (req, res) => {
  try {
    const { privateBetId } = req.body;
    const userId = req.user.id;

    const bet = await prisma.privateBet.findUnique({
      where: { id: privateBetId },
      include: { participants: true },
    });

    if (!bet) return res.status(404).json({ error: 'Apuesta no encontrada' });
    if (bet.creatorId !== userId) return res.status(403).json({ error: 'Solo el creador puede cancelar' });
    if (bet.status !== 'OPEN') return res.status(400).json({ error: 'Solo se puede cancelar si está OPEN' });

    // Reembolsa a todos
    await prisma.$transaction(async (tx) => {
      for (const p of bet.participants) {
        const wallet = await tx.wallet.findUnique({ where: { userId: p.userId } });
        await tx.wallet.update({
          where: { userId: p.userId },
          data:  { lockedBalance: { decrement: parseFloat(p.amount) } },
        });
        await tx.transaction.create({
          data: {
            userId:        p.userId,
            walletId:      wallet.id,
            type:          'P2P_BET_REFUND',
            amount:        parseFloat(p.amount),
            balanceBefore: wallet.balance,
            balanceAfter:  wallet.balance,
            reference:     privateBetId,
            note:          'Reembolso por cancelación del creador',
          },
        });
        await tx.privateBetParticipant.update({
          where: { id: p.id },
          data:  { status: 'REFUNDED' },
        });
      }

      await tx.privateBet.update({
        where: { id: privateBetId },
        data:  { status: 'CANCELLED' },
      });
    });

    res.json({ message: 'Apuesta cancelada. Todos los participantes fueron reembolsados.' });
  } catch (err) {
    console.error('[P2P] cancelPrivateBet:', err);
    res.status(500).json({ error: 'Error al cancelar apuesta' });
  }
};

module.exports = {
  createPrivateBet,
  joinPrivateBet,
  resolvePrivateBet,
  getPrivateBet,
  getMyPrivateBets,
  cancelPrivateBet,
};
