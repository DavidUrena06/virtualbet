// admin/admin.controller.js — VERSIÓN COMPLETA con P2P y BetCoins
const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const prisma = new PrismaClient();

const logAdminAction = async (adminId, action, targetUserId = null, payload = {}, req) => {
  await prisma.adminLog.create({
    data: { adminId, action, targetUserId, payload, ipAddress: req.ip },
  });
};

// ── Ver todos los usuarios ────────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const skip   = (page - 1) * limit;

    const where = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { email:    { contains: search, mode: 'insensitive' } },
      ],
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, username: true, email: true, role: true,
          isBanned: true, avatarEmoji: true, createdAt: true,
          wallet: { select: { balance: true, lockedBalance: true, totalWagered: true, totalWon: true } },
          _count: { select: { sportBets: true, privateBetParticipations: true, gameHistory: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
};

// ── Dar BetCoins ──────────────────────────────────────────────────────────
const giveBetCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findUnique({ where: { userId } });
      const newBal = parseFloat(w.balance) + parsedAmount;
      await tx.wallet.update({
        where: { userId },
        data:  { balance: newBal, totalDeposited: { increment: parsedAmount } },
      });
      await tx.transaction.create({
        data: {
          userId, walletId: w.id,
          type:          'ADMIN_DEPOSIT',
          amount:        parsedAmount,
          balanceBefore: w.balance,
          balanceAfter:  newBal,
          note:          note || `Admin deposit por ${req.user.username}`,
        },
      });
    });

    await logAdminAction(req.user.id, 'GIVE_BETCOINS', userId, { amount: parsedAmount, note }, req);
    const updated = await prisma.wallet.findUnique({ where: { userId } });
    res.json({ message: `${parsedAmount} BC enviados a ${target.username}`, newBalance: updated.balance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ── Dar BetCoins a todos ──────────────────────────────────────────────────
const giveBetCoinsAll = async (req, res) => {
  try {
    const { amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    const users = await prisma.user.findMany({
      where:  { isBanned: false, role: 'USER' },
      select: { id: true },
    });

    const batchSize = 50;
    let processed = 0;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      await prisma.$transaction(async (tx) => {
        for (const u of batch) {
          const w = await tx.wallet.findUnique({ where: { userId: u.id } });
          if (!w) continue;
          const newBal = parseFloat(w.balance) + parsedAmount;
          await tx.wallet.update({ where: { userId: u.id }, data: { balance: newBal, totalDeposited: { increment: parsedAmount } } });
          await tx.transaction.create({
            data: { userId: u.id, walletId: w.id, type: 'ADMIN_DEPOSIT', amount: parsedAmount, balanceBefore: w.balance, balanceAfter: newBal, note: note || 'Recarga masiva' },
          });
        }
      });
      processed += batch.length;
    }

    await logAdminAction(req.user.id, 'GIVE_BETCOINS_ALL', null, { amount: parsedAmount, users: processed }, req);
    res.json({ message: `${parsedAmount} BC enviados a ${processed} usuarios` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Quitar BetCoins ───────────────────────────────────────────────────────
const removeBetCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    const target = await prisma.user.findUnique({ where: { id: userId }, include: { wallet: true } });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const available = parseFloat(target.wallet.balance) - parseFloat(target.wallet.lockedBalance);
    if (available < parsedAmount) {
      return res.status(400).json({ error: `Solo ${available.toFixed(2)} BC disponibles` });
    }

    await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findUnique({ where: { userId } });
      const newBal = parseFloat(w.balance) - parsedAmount;
      await tx.wallet.update({ where: { userId }, data: { balance: newBal } });
      await tx.transaction.create({
        data: { userId, walletId: w.id, type: 'ADMIN_WITHDRAW', amount: parsedAmount, balanceBefore: w.balance, balanceAfter: newBal, note: note || 'Admin retiro' },
      });
    });

    await logAdminAction(req.user.id, 'REMOVE_BETCOINS', userId, { amount: parsedAmount }, req);
    res.json({ message: `${parsedAmount} BC retirados de ${target.username}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ── Banear / desbanear ────────────────────────────────────────────────────
const banUser = async (req, res) => {
  try {
    const { userId, reason } = req.body;
    if (userId === req.user.id) return res.status(400).json({ error: 'No podés banearte' });
    const user = await prisma.user.update({ where: { id: userId }, data: { isBanned: true, banReason: reason || 'Violación' } });
    await logAdminAction(req.user.id, 'BAN_USER', userId, { reason }, req);
    res.json({ message: `${user.username} baneado` });
  } catch (err) { res.status(400).json({ error: 'Error al banear' }); }
};

const unbanUser = async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await prisma.user.update({ where: { id: userId }, data: { isBanned: false, banReason: null } });
    await logAdminAction(req.user.id, 'UNBAN_USER', userId, {}, req);
    res.json({ message: `${user.username} desbaneado` });
  } catch (err) { res.status(400).json({ error: 'Error al desbanear' }); }
};

// ── Crear partido ─────────────────────────────────────────────────────────
const createMatch = async (req, res) => {
  try {
    const { league, teamHome, teamAway, oddHome, oddDraw, oddAway, startsAt } = req.body;

    const match = await prisma.match.create({
      data: {
        league, teamHome, teamAway,
        oddHome: parseFloat(oddHome),
        oddDraw: parseFloat(oddDraw),
        oddAway: parseFloat(oddAway),
        startsAt: new Date(startsAt),
      },
    });

    await logAdminAction(req.user.id, 'CREATE_MATCH', null, { matchId: match.id, league, teamHome, teamAway }, req);
    res.status(201).json({ message: 'Partido creado', match });
  } catch (err) {
    res.status(400).json({ error: 'Error al crear partido' });
  }
};

// ── Resolver partido (paga sport bets + dispara P2P resolve) ─────────────
const resolveMatch = async (req, res) => {
  try {
    const { matchId, result, scoreHome, scoreAway } = req.body;

    if (!['HOME','DRAW','AWAY'].includes(result)) {
      return res.status(400).json({ error: 'Resultado: HOME, DRAW o AWAY' });
    }

    const match = await prisma.match.findUnique({
      where:   { id: matchId },
      include: { sportBets: true, privateBets: true },
    });

    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status === 'FINISHED') return res.status(400).json({ error: 'Ya resuelto' });

    let paidSportBets = 0;

    await prisma.$transaction(async (tx) => {
      await tx.match.update({
        where: { id: matchId },
        data: {
          status: 'FINISHED', result,
          scoreHome: parseInt(scoreHome),
          scoreAway: parseInt(scoreAway),
          resolvedAt: new Date(),
        },
      });

      // Resuelve apuestas deportivas individuales
      for (const bet of match.sportBets) {
        if (bet.status !== 'PENDING') continue;
        const won = bet.selection === result;

        await tx.sportBet.update({
          where: { id: bet.id },
          data:  { status: won ? 'WON' : 'LOST', resolvedAt: new Date() },
        });

        if (won) {
          const payout = parseFloat(bet.potentialWin);
          const wallet = await tx.wallet.findUnique({ where: { userId: bet.userId } });
          const newBal = parseFloat(wallet.balance) + payout;

          await tx.wallet.update({
            where: { userId: bet.userId },
            data:  { balance: newBal, totalWon: { increment: payout } },
          });

          await tx.transaction.create({
            data: {
              userId:        bet.userId,
              walletId:      wallet.id,
              type:          'SPORT_WIN',
              amount:        payout,
              balanceBefore: wallet.balance,
              balanceAfter:  newBal,
              note:          `Ganaste: ${match.teamHome} vs ${match.teamAway}`,
              reference:     bet.id,
            },
          });

          await tx.notification.create({
            data: {
              userId:  bet.userId,
              type:    'SPORT_BET_RESOLVED',
              title:   '¡Apuesta ganada!',
              message: `Ganaste ${payout.toFixed(2)} BC en ${match.teamHome} vs ${match.teamAway}`,
              data:    { betId: bet.id, payout },
            },
          });

          paidSportBets++;
        } else {
          await tx.notification.create({
            data: {
              userId:  bet.userId,
              type:    'SPORT_BET_RESOLVED',
              title:   'Apuesta resuelta',
              message: `Perdiste tu apuesta en ${match.teamHome} vs ${match.teamAway}`,
              data:    { betId: bet.id, payout: 0 },
            },
          });
        }
      }
    });

    // Resuelve apuestas P2P del partido (fuera de la transaction, tiene su propia lógica)
    const p2pBets = await prisma.privateBet.findMany({
      where: { matchId, status: 'LOCKED' },
    });

    for (const pb of p2pBets) {
      await resolvePrivateBet(pb.id, result);
    }

    await logAdminAction(req.user.id, 'RESOLVE_MATCH', null, { matchId, result, paidSportBets }, req);

    res.json({
      message:       `Partido resuelto: ${result}`,
      paidSportBets,
      resolvedP2P:   p2pBets.length,
    });
  } catch (err) {
    console.error('[ADMIN] resolveMatch:', err);
    res.status(500).json({ error: 'Error al resolver partido' });
  }
};

// ── Estadísticas globales ─────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [totalUsers, wagered, won, games, sportBets, p2pBets] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.wallet.aggregate({ _sum: { totalWagered: true } }),
      prisma.wallet.aggregate({ _sum: { totalWon: true } }),
      prisma.gameHistory.count(),
      prisma.sportBet.count(),
      prisma.privateBet.count(),
    ]);

    const w = parseFloat(wagered._sum.totalWagered) || 0;
    const v = parseFloat(won._sum.totalWon)         || 0;

    res.json({
      stats: {
        totalUsers, totalGames: games, totalSportBets: sportBets, totalP2PBets: p2pBets,
        totalWageredBC: w, totalWonBC: v,
        houseProfit:    w - v,
        houseEdgeReal:  w > 0 ? ((w - v) / w * 100).toFixed(2) + '%' : '0%',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener stats' });
  }
};

const getAdminLogs = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 30;
    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        include: {
          admin:      { select: { username: true } },
          targetUser: { select: { username: true } },
        },
      }),
      prisma.adminLog.count(),
    ]);
    res.json({ logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener logs' });
  }
};

module.exports = { getAllUsers, giveBetCoins, giveBetCoinsAll, removeBetCoins, banUser, unbanUser, createMatch, resolveMatch, getStats, getAdminLogs };
