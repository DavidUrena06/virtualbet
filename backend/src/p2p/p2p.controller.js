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

// ── Helper: verifica si dos usuarios son amigos ───────────────────────────
const sonAmigos = async (userId1, userId2) => {
  const amistad = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: userId1, addresseeId: userId2 },
        { requesterId: userId2, addresseeId: userId1 },
      ],
    },
  });
  return !!amistad;
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
    const parsedMax    = parseInt(maxParticipants) || 10;

    if (parsedMin < 1)     return res.status(400).json({ error: 'Mínimo: 1 BC' });
    if (parsedMax < 2)     return res.status(400).json({ error: 'Máximo de participantes: mínimo 2' });
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
          maxParticipants: parsedMax,
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
// UNIRSE A APUESTA P2P (flujo manual — sin invitación)
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

    const updated = await prisma.privateBet.findUnique({
      where:   { id: privateBetId },
      include: { participants: { select: { selection: true, amount: true } } },
    });

    res.json({
      message: `Te uniste con ${parsedAmount} BC. ¡Suerte!`,
      totalPool:    updated.totalPool,
      participants: updated.participants.length,
    });
  } catch (err) {
    console.error('[P2P] joinPrivateBet:', err);
    res.status(400).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// INVITAR AMIGO A APUESTA P2P
// El creador solo elige a quién invitar y (opcionalmente) un monto
// sugerido. La selección la decide el invitado al aceptar.
// ══════════════════════════════════════════════════════════════

const inviteFriend = async (req, res) => {
  try {
    const inviterId  = req.user.id;
    // suggestedAmount es opcional — si no viene, se usa el mínimo de la sala
    const { privateBetId, inviteeId, suggestedAmount } = req.body;

    if (inviterId === inviteeId) {
      return res.status(400).json({ error: 'No podés invitarte a vos mismo' });
    }

    // Verifica que la apuesta exista y esté abierta
    const bet = await prisma.privateBet.findUnique({
      where:   { id: privateBetId },
      include: { participants: true, match: true },
    });

    if (!bet)                  return res.status(404).json({ error: 'Apuesta no encontrada' });
    if (bet.status !== 'OPEN') return res.status(400).json({ error: 'La apuesta ya no acepta invitaciones' });
    if (new Date() >= bet.match.startsAt) {
      return res.status(400).json({ error: 'El partido ya inició' });
    }
    if (bet.participants.length >= bet.maxParticipants) {
      return res.status(400).json({ error: 'La sala ya está llena' });
    }

    // Verifica que el invitador sea participante o el creador
    const esParticipante = bet.participants.some(p => p.userId === inviterId);
    const esCreador      = bet.creatorId === inviterId;
    if (!esParticipante && !esCreador) {
      return res.status(403).json({ error: 'Solo participantes pueden invitar' });
    }

    // Verifica amistad
    const amigoConfirmado = await sonAmigos(inviterId, inviteeId);
    if (!amigoConfirmado) {
      return res.status(403).json({ error: 'Solo podés invitar a tus amigos' });
    }

    // Verifica que el invitado no esté ya adentro
    const yaAdentro = bet.participants.some(p => p.userId === inviteeId);
    if (yaAdentro) {
      return res.status(400).json({ error: 'Ese usuario ya está participando en la apuesta' });
    }

    // El monto guardado en la invitación es solo referencial (mínimo de la sala)
    // El invitado puede cambiarlo al aceptar, respetando ese mínimo
    const montoReferencia = suggestedAmount
      ? Math.max(parseFloat(suggestedAmount), parseFloat(bet.minAmount))
      : parseFloat(bet.minAmount);

    // Verifica que el invitado exista
    const invitee = await prisma.user.findUnique({
      where:  { id: inviteeId },
      select: { id: true, username: true, isBanned: true },
    });
    if (!invitee)         return res.status(404).json({ error: 'Usuario no encontrado' });
    if (invitee.isBanned) return res.status(400).json({ error: 'No podés invitar a ese usuario' });

    // Crea la invitación — selection queda como placeholder HOME hasta que el invitado elija
    // (se sobreescribe al aceptar; el campo existe por el schema pero no tiene semántica aquí)
    try {
      await prisma.$transaction(async (tx) => {
        const invitacion = await tx.p2PInvitation.create({
          data: {
            privateBetId,
            inviterId,
            inviteeId,
            selection: 'HOME', // placeholder — el invitado elige al aceptar
            amount:    montoReferencia,
            status:    'PENDING',
          },
        });

        // Notifica al invitado
        await tx.notification.create({
          data: {
            userId:  inviteeId,
            type:    'P2P_INVITE',
            title:   '¡Invitación a apuesta P2P!',
            message: `${req.user.username} te invitó a "${bet.title}" — mínimo ${parseFloat(bet.minAmount).toFixed(0)} BC`,
            data: {
              privateBetId,
              invitationId:    invitacion.id,
              suggestedAmount: montoReferencia,
              minAmount:       parseFloat(bet.minAmount),
              inviterName:     req.user.username,
              betTitle:        bet.title,
              match:           `${bet.match.teamHome} vs ${bet.match.teamAway}`,
            },
          },
        });
      });
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(400).json({ error: 'Ya enviaste una invitación a ese usuario para esta apuesta' });
      }
      throw err;
    }

    res.json({ message: `Invitación enviada a ${invitee.username}` });
  } catch (err) {
    console.error('[P2P] inviteFriend:', err);
    res.status(400).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// RESPONDER A INVITACIÓN (aceptar o rechazar)
// Al aceptar, el invitado elige su propia selección y monto.
// ══════════════════════════════════════════════════════════════

const respondToInvitation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { invitationId, action, selection, amount } = req.body;

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida: accept o reject' });
    }

    // Al aceptar son obligatorios selection y amount
    if (action === 'accept') {
      if (!['HOME','DRAW','AWAY'].includes(selection)) {
        return res.status(400).json({ error: 'Selección inválida: HOME, DRAW o AWAY' });
      }
      if (!amount || parseFloat(amount) < 1) {
        return res.status(400).json({ error: 'Monto inválido' });
      }
    }

    // Obtiene la invitación
    const invitacion = await prisma.p2PInvitation.findUnique({
      where:   { id: invitationId },
      include: {
        privateBet: {
          include: { participants: true, match: true },
        },
      },
    });

    if (!invitacion) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }
    if (invitacion.inviteeId !== userId) {
      return res.status(403).json({ error: 'Esta invitación no es tuya' });
    }
    if (invitacion.status !== 'PENDING') {
      return res.status(400).json({ error: 'Esta invitación ya fue respondida o expiró' });
    }

    // --- RECHAZAR ---
    if (action === 'reject') {
      await prisma.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'REJECTED', respondedAt: new Date() },
      });
      return res.json({ message: 'Invitación rechazada' });
    }

    // --- ACEPTAR ---
    const bet          = invitacion.privateBet;
    const parsedAmount = parseFloat(amount);

    if (bet.status !== 'OPEN') {
      await prisma.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'EXPIRED', respondedAt: new Date() },
      });
      return res.status(400).json({ error: 'La apuesta ya no acepta participantes' });
    }

    if (new Date() >= bet.match.startsAt) {
      await prisma.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'EXPIRED', respondedAt: new Date() },
      });
      return res.status(400).json({ error: 'El partido ya inició, la invitación expiró' });
    }

    // Verifica monto mínimo de la sala
    if (parsedAmount < parseFloat(bet.minAmount)) {
      return res.status(400).json({ error: `El monto mínimo de esta sala es ${bet.minAmount} BC` });
    }

    // Verifica que no esté ya adentro
    const yaAdentro = bet.participants.some(p => p.userId === userId);
    if (yaAdentro) {
      await prisma.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'ACCEPTED', respondedAt: new Date() },
      });
      return res.status(400).json({ error: 'Ya estás participando en esta apuesta' });
    }

    // Verifica límite de participantes
    if (bet.participants.length >= bet.maxParticipants) {
      await prisma.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'EXPIRED', respondedAt: new Date() },
      });
      return res.status(400).json({ error: 'La sala ya está llena' });
    }

    // Ejecuta igual que joinPrivateBet — transacción atómica
    await prisma.$transaction(async (tx) => {
      // 1. Marca invitación como aceptada (actualiza también selection y amount reales)
      await tx.p2PInvitation.update({
        where: { id: invitationId },
        data:  { status: 'ACCEPTED', respondedAt: new Date(), selection, amount: parsedAmount },
      });

      // 2. Agrega como participante con la selección y monto que eligió el invitado
      await tx.privateBetParticipant.create({
        data: {
          privateBetId: bet.id,
          userId,
          selection,      // ← elegida por el invitado
          amount:         parsedAmount,
          status:         'ACTIVE',
        },
      });

      // 3. Actualiza pool total
      await tx.privateBet.update({
        where: { id: bet.id },
        data:  { totalPool: { increment: parsedAmount } },
      });

      // 4. Bloquea los BetCoins del invitado
      await lockBetCoins(tx, userId, parsedAmount, bet.id);

      // 5. Notifica al creador
      await tx.notification.create({
        data: {
          userId:  bet.creatorId,
          type:    'P2P_NEW_PARTICIPANT',
          title:   'Nuevo participante',
          message: `${req.user.username} aceptó tu invitación y apostó ${parsedAmount} BC en "${bet.title}"`,
          data:    { privateBetId: bet.id, username: req.user.username },
        },
      });
    });

    res.json({
      message:      `¡Aceptaste! Apostaste ${parsedAmount} BC en "${bet.title}"`,
      privateBetId: bet.id,
    });
  } catch (err) {
    console.error('[P2P] respondToInvitation:', err);
    res.status(400).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// MIS INVITACIONES PENDIENTES (recibidas)
// ══════════════════════════════════════════════════════════════

const getMyInvitations = async (req, res) => {
  try {
    const userId = req.user.id;

    const invitaciones = await prisma.p2PInvitation.findMany({
      where: {
        inviteeId: userId,
        status:    'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      include: {
        inviter: {
          select: { username: true, avatarEmoji: true },
        },
        privateBet: {
          include: {
            match: {
              select: { teamHome: true, teamAway: true, league: true, startsAt: true },
            },
            creator: {
              select: { username: true },
            },
            _count: { select: { participants: true } },
          },
        },
      },
    });

    res.json({ invitations: invitaciones });
  } catch (err) {
    console.error('[P2P] getMyInvitations:', err);
    res.status(500).json({ error: 'Error al obtener invitaciones' });
  }
};

// ══════════════════════════════════════════════════════════════
// AMIGOS DISPONIBLES PARA INVITAR (a una apuesta específica)
// ══════════════════════════════════════════════════════════════

const getFriendsToInvite = async (req, res) => {
  try {
    const userId      = req.user.id;
    const { betId }   = req.params;

    // Obtiene la apuesta con sus participantes e invitaciones pendientes
    const bet = await prisma.privateBet.findUnique({
      where:   { id: betId },
      include: {
        participants: { select: { userId: true } },
        invitations:  { where: { status: 'PENDING' }, select: { inviteeId: true } },
      },
    });

    if (!bet) return res.status(404).json({ error: 'Apuesta no encontrada' });
    if (bet.status !== 'OPEN') return res.status(400).json({ error: 'La apuesta no está abierta' });

    // IDs a excluir: participantes ya adentro + invitaciones pendientes + el mismo usuario
    const excluidos = new Set([
      userId,
      ...bet.participants.map(p => p.userId),
      ...bet.invitations.map(i => i.inviteeId),
    ]);

    // Obtiene los amigos aceptados del usuario
    const amistades = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
      include: {
        requester: { select: { id: true, username: true, avatarEmoji: true } },
        addressee: { select: { id: true, username: true, avatarEmoji: true } },
      },
    });

    // Extrae el amigo de cada amistad (no el usuario actual)
    const amigos = amistades
      .map(f => f.requesterId === userId ? f.addressee : f.requester)
      .filter(a => !excluidos.has(a.id) && !a.isBanned);

    res.json({
      friends:  amigos,
      minAmount: parseFloat(bet.minAmount),
    });
  } catch (err) {
    console.error('[P2P] getFriendsToInvite:', err);
    res.status(500).json({ error: 'Error al obtener amigos' });
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

    const totalPool    = parseFloat(bet.totalPool);
    const commission   = totalPool * parseFloat(bet.houseCommission);
    const distributable = totalPool - commission;

    // Identifica ganadores y perdedores
    const winners = bet.participants.filter(p => p.selection === matchResult);
    const losers  = bet.participants.filter(p => p.selection !== matchResult);

    await prisma.$transaction(async (tx) => {
      if (winners.length === 0) {
        // Nadie acertó → reembolso a todos (sin comisión)
        for (const p of bet.participants) {
          const amount = parseFloat(p.amount);
          const wallet = await tx.wallet.findUnique({ where: { userId: p.userId } });

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

        // Descuenta BetCoins de perdedores
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
    const userId  = req.user.id;

    const bet = await prisma.privateBet.findUnique({
      where: { id },
      include: {
        match: {
          select: { teamHome: true, teamAway: true, league: true, startsAt: true, status: true, result: true },
        },
        creator: {
          select: { username: true, avatarEmoji: true },
        },
        participants: {
          select: {
            selection: true,
            amount:    true,
            payout:    true,
            status:    true,
            user:      { select: { username: true, avatarEmoji: true } },
          },
        },
        // Invitaciones pendientes para el detalle (útil para mostrar quién fue invitado)
        invitations: {
          where:   { status: 'PENDING' },
          select:  { inviteeId: true, invitee: { select: { username: true, avatarEmoji: true } } },
        },
      },
    });

    if (!bet) return res.status(404).json({ error: 'Apuesta no encontrada' });

    // Verifica que el usuario sea participante o el creador
    const isParticipant = bet.participants.some(p => p.user?.username === req.user.username)
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
      where:   { id: privateBetId },
      include: { participants: true },
    });

    if (!bet) return res.status(404).json({ error: 'Apuesta no encontrada' });
    if (bet.creatorId !== userId) return res.status(403).json({ error: 'Solo el creador puede cancelar' });
    if (bet.status !== 'OPEN')   return res.status(400).json({ error: 'Solo se puede cancelar si está OPEN' });

    // Reembolsa a todos y cancela invitaciones pendientes
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

      // Expira todas las invitaciones pendientes al cancelar
      await tx.p2PInvitation.updateMany({
        where: { privateBetId, status: 'PENDING' },
        data:  { status: 'EXPIRED', respondedAt: new Date() },
      });

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
  inviteFriend,
  respondToInvitation,
  getMyInvitations,
  getFriendsToInvite,
  resolvePrivateBet,
  getPrivateBet,
  getMyPrivateBets,
  cancelPrivateBet,
};