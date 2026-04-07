// backend/src/admin/admin.controller.js — versión completa y corregida

const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const prisma = new PrismaClient();

const logAdminAction = async (adminId, action, targetUserId = null, payload = {}, req) => {
  await prisma.adminLog.create({
    data: { adminId, action, targetUserId, payload, ipAddress: req?.ip || 'unknown' },
  });
};

// ══ CREAR PARTIDO ═══════════════════════════════════════════════════════
// El frontend manda startsAt como ISO string completo (toISOString())
// sin ambigüedad de timezone. El backend simplemente parsea.
const createMatch = async (req, res) => {
  try {
    const { league, teamHome, teamAway, oddHome, oddDraw, oddAway, startsAt } = req.body;

    if (!league || !teamHome || !teamAway || !startsAt) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    const oh = parseFloat(oddHome);
    const od = parseFloat(oddDraw);
    const oa = parseFloat(oddAway);

    if ([oh, od, oa].some(n => isNaN(n) || n < 1.01)) {
      return res.status(400).json({ error: 'Todos los odds deben ser >= 1.01' });
    }

    const startsAtDate = new Date(startsAt);
    if (isNaN(startsAtDate.getTime())) {
      return res.status(400).json({ error: 'Formato de fecha invalido' });
    }

    if (startsAtDate <= new Date(Date.now() + 5 * 60 * 1000)) {
      return res.status(400).json({ error: 'El partido debe iniciar al menos 5 minutos en el futuro' });
    }

    const match = await prisma.match.create({
      data: {
        league:   league.toUpperCase(),
        teamHome: teamHome.trim(),
        teamAway: teamAway.trim(),
        oddHome:  oh, oddDraw: od, oddAway: oa,
        startsAt: startsAtDate,
        status:   'UPCOMING',
      },
    });

    await logAdminAction(req.user.id, 'CREATE_MATCH', null, {
      matchId: match.id, match: `${teamHome} vs ${teamAway}`,
    }, req);

    res.status(201).json({ message: 'Partido creado', match });
  } catch (err) {
    console.error('[ADMIN] createMatch:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ══ RESOLVER PARTIDO ═══════════════════════════════════════════════════
const resolveMatch = async (req, res) => {
  try {
    const { matchId, result, scoreHome, scoreAway } = req.body;

    if (!['HOME', 'DRAW', 'AWAY'].includes(result)) {
      return res.status(400).json({ error: 'Resultado: HOME, DRAW o AWAY' });
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId }, include: { sportBets: true },
    });

    if (!match)                      return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status === 'FINISHED') return res.status(400).json({ error: 'Partido ya resuelto' });
    if (match.status === 'CANCELLED')return res.status(400).json({ error: 'Partido cancelado' });

    let paidSportBets = 0;

    await prisma.$transaction(async (tx) => {
      await tx.match.update({
        where: { id: matchId },
        data: { status: 'FINISHED', result, scoreHome: parseInt(scoreHome)||0, scoreAway: parseInt(scoreAway)||0, resolvedAt: new Date() },
      });

      for (const bet of match.sportBets) {
        if (bet.status !== 'PENDING') continue;
        const won = bet.selection === result;
        await tx.sportBet.update({ where: { id: bet.id }, data: { status: won ? 'WON' : 'LOST', resolvedAt: new Date() } });

        if (won) {
          const payout = parseFloat(bet.potentialWin);
          const wallet = await tx.wallet.findUnique({ where: { userId: bet.userId } });
          const newBal = parseFloat(wallet.balance) + payout;
          await tx.wallet.update({ where: { userId: bet.userId }, data: { balance: newBal, totalWon: { increment: payout } } });
          await tx.transaction.create({
            data: { userId: bet.userId, walletId: wallet.id, type: 'SPORT_WIN', amount: payout,
                    balanceBefore: wallet.balance, balanceAfter: newBal,
                    note: `Ganaste: ${match.teamHome} vs ${match.teamAway}`, reference: bet.id },
          });
          await tx.notification.create({
            data: { userId: bet.userId, type: 'SPORT_BET_RESOLVED', title: 'Apuesta ganada',
                    message: `Ganaste ${payout.toFixed(2)} BC en ${match.teamHome} vs ${match.teamAway}`,
                    data: { betId: bet.id, payout } },
          }).catch(() => {});
          paidSportBets++;
        }
      }
    });

    const p2pToResolve = await prisma.privateBet.findMany({
      where: { matchId, status: { in: ['LOCKED', 'OPEN'] } },
    });
    let resolvedP2P = 0;
    for (const pb of p2pToResolve) {
      if (pb.status === 'OPEN') await prisma.privateBet.update({ where: { id: pb.id }, data: { status: 'LOCKED' } });
      await resolvePrivateBet(pb.id, result);
      resolvedP2P++;
    }

    await logAdminAction(req.user.id, 'RESOLVE_MATCH', null, { matchId, result, paidSportBets, resolvedP2P }, req);
    res.json({ message: `Resuelto: ${match.teamHome} vs ${match.teamAway} — ${result}`, paidSportBets, resolvedP2P });
  } catch (err) {
    console.error('[ADMIN] resolveMatch:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ══ USUARIOS ════════════════════════════════════════════════════════════
const getAllUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const search = req.query.search?.trim() || '';
    const skip = (page - 1) * limit;
    const where = search ? { OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { email:    { contains: search, mode: 'insensitive' } },
    ]} : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' },
        select: { id: true, username: true, email: true, role: true, isBanned: true, avatarEmoji: true, createdAt: true,
          wallet: { select: { balance: true, lockedBalance: true, totalWagered: true, totalWon: true } },
          _count: { select: { gameHistory: true, sportBets: true, privateBetParticipations: true } } },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { res.status(500).json({ error: 'Error al obtener usuarios' }); }
};

// ══ BETCOINS ════════════════════════════════════════════════════════════
const giveBetCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findUnique({ where: { userId } });
      const newBal = parseFloat(w.balance) + parsedAmount;
      await tx.wallet.update({ where: { userId }, data: { balance: newBal, totalDeposited: { increment: parsedAmount } } });
      await tx.transaction.create({ data: { userId, walletId: w.id, type: 'ADMIN_DEPOSIT', amount: parsedAmount, balanceBefore: w.balance, balanceAfter: newBal, note: note || 'Admin deposit' } });
    });
    await logAdminAction(req.user.id, 'GIVE_BETCOINS', userId, { amount: parsedAmount }, req);
    const updated = await prisma.wallet.findUnique({ where: { userId } });
    res.json({ message: `${parsedAmount} BC enviados a ${target.username}`, newBalance: updated.balance });
  } catch (err) { res.status(400).json({ error: err.message }); }
};

const giveBetCoinsAll = async (req, res) => {
  try {
    const { amount, note } = req.body;
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const users = await prisma.user.findMany({ where: { isBanned: false, role: 'USER' }, select: { id: true } });
    let processed = 0;
    for (let i = 0; i < users.length; i += 50) {
      const batch = users.slice(i, i + 50);
      await prisma.$transaction(async (tx) => {
        for (const u of batch) {
          const w = await tx.wallet.findUnique({ where: { userId: u.id } });
          if (!w) continue;
          const newBal = parseFloat(w.balance) + parsedAmount;
          await tx.wallet.update({ where: { userId: u.id }, data: { balance: newBal, totalDeposited: { increment: parsedAmount } } });
          await tx.transaction.create({ data: { userId: u.id, walletId: w.id, type: 'ADMIN_DEPOSIT', amount: parsedAmount, balanceBefore: w.balance, balanceAfter: newBal, note: note || 'Recarga masiva' } });
        }
      });
      processed += batch.length;
    }
    await logAdminAction(req.user.id, 'GIVE_BETCOINS_ALL', null, { amount: parsedAmount, users: processed }, req);
    res.json({ message: `${parsedAmount} BC enviados a ${processed} usuarios` });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const removeBetCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);
    const target = await prisma.user.findUnique({ where: { id: userId }, include: { wallet: true } });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    const available = parseFloat(target.wallet.balance) - parseFloat(target.wallet.lockedBalance || 0);
    if (available < parsedAmount) return res.status(400).json({ error: `Solo ${available.toFixed(2)} BC disponibles` });
    await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findUnique({ where: { userId } });
      const newBal = parseFloat(w.balance) - parsedAmount;
      await tx.wallet.update({ where: { userId }, data: { balance: newBal } });
      await tx.transaction.create({ data: { userId, walletId: w.id, type: 'ADMIN_WITHDRAW', amount: parsedAmount, balanceBefore: w.balance, balanceAfter: newBal, note: note || 'Admin retiro' } });
    });
    await logAdminAction(req.user.id, 'REMOVE_BETCOINS', userId, { amount: parsedAmount }, req);
    res.json({ message: `${parsedAmount} BC retirados de ${target.username}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
};

const banUser = async (req, res) => {
  try {
    const { userId, reason } = req.body;
    if (userId === req.user.id) return res.status(400).json({ error: 'No podes banearte a vos mismo' });
    const user = await prisma.user.update({ where: { id: userId }, data: { isBanned: true, banReason: reason || 'Violacion' } });
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
    const v = parseFloat(won._sum.totalWon) || 0;
    res.json({ stats: { totalUsers, totalGames: games, totalSportBets: sportBets, totalP2PBets: p2pBets,
      totalWageredBC: w, totalWonBC: v, houseProfit: w - v,
      houseEdgeReal: w > 0 ? ((w - v) / w * 100).toFixed(2) + '%' : '0%' } });
  } catch (err) { res.status(500).json({ error: 'Error al obtener stats' }); }
};

const getAdminLogs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page-1)*limit, take: limit,
        include: { admin: { select: { username: true } }, targetUser: { select: { username: true } } } }),
      prisma.adminLog.count(),
    ]);
    res.json({ logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { res.status(500).json({ error: 'Error al obtener logs' }); }
};

module.exports = {
  getAllUsers, giveBetCoins, giveBetCoinsAll, removeBetCoins,
  banUser, unbanUser, createMatch, resolveMatch, getStats, getAdminLogs,
};
