// admin/admin.controller.js
// Panel de administrador - solo accesible con rol ADMIN

const { PrismaClient } = require('@prisma/client');
const { transferCoins } = require('../wallet/wallet.controller');
const prisma = new PrismaClient();

// ─── Helper: registra acción del admin ───────────────────────────────────────
const logAdminAction = async (adminId, action, targetUserId = null, payload = {}, req) => {
  await prisma.adminLog.create({
    data: {
      adminId,
      action,
      targetUserId,
      payload,
      ipAddress: req.ip,
    },
  });
};

// ─── Ver todos los usuarios ───────────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const search = req.query.search || '';
    const skip   = (page - 1) * limit;

    const where = search
      ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { email:    { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isBanned: true,
          createdAt: true,
          wallet: {
            select: { balance: true, totalWagered: true, totalWon: true },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('[ADMIN] getAllUsers:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
};

// ─── Dar monedas a un usuario específico ─────────────────────────────────────
const giveCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });

    await prisma.$transaction(async (tx) => {
      await transferCoins(
        tx, userId, parsedAmount, 'ADMIN_DEPOSIT',
        note || `Admin deposit por ${req.user.username}`, null
      );
    });

    await logAdminAction(req.user.id, 'GIVE_COINS', userId, { amount: parsedAmount, note }, req);

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.json({
      message: `Se dieron ${parsedAmount} monedas a ${targetUser.username}`,
      newBalance: parseFloat(updatedWallet.balance),
    });
  } catch (error) {
    console.error('[ADMIN] giveCoins:', error);
    res.status(400).json({ error: error.message });
  }
};

// ─── Dar monedas a TODOS los usuarios ────────────────────────────────────────
const giveCoinsAll = async (req, res) => {
  try {
    const { amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const users = await prisma.user.findMany({
      where: { isBanned: false, role: 'USER' },
      select: { id: true },
    });

    // Procesa en lotes de 50 para no sobrecargar la BD
    const batchSize = 50;
    let processed = 0;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      await prisma.$transaction(async (tx) => {
        for (const user of batch) {
          await transferCoins(
            tx, user.id, parsedAmount, 'ADMIN_DEPOSIT',
            note || `Recarga masiva por ${req.user.username}`, null
          );
        }
      });

      processed += batch.length;
    }

    await logAdminAction(req.user.id, 'GIVE_COINS_ALL', null,
      { amount: parsedAmount, usersAffected: processed, note }, req);

    res.json({
      message: `Se dieron ${parsedAmount} monedas a ${processed} usuarios`,
      usersAffected: processed,
    });
  } catch (error) {
    console.error('[ADMIN] giveCoinsAll:', error);
    res.status(500).json({ error: error.message });
  }
};

// ─── Quitar monedas ───────────────────────────────────────────────────────────
const removeCoins = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const parsedAmount = parseFloat(amount);

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });

    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (parseFloat(targetUser.wallet.balance) < parsedAmount) {
      return res.status(400).json({ error: 'El usuario no tiene suficiente saldo' });
    }

    await prisma.$transaction(async (tx) => {
      await transferCoins(tx, userId, -parsedAmount, 'ADMIN_WITHDRAW',
        note || `Admin retiro por ${req.user.username}`, null);
    });

    await logAdminAction(req.user.id, 'REMOVE_COINS', userId, { amount: parsedAmount, note }, req);

    res.json({ message: `Se quitaron ${parsedAmount} monedas a ${targetUser.username}` });
  } catch (error) {
    console.error('[ADMIN] removeCoins:', error);
    res.status(400).json({ error: error.message });
  }
};

// ─── Banear usuario ───────────────────────────────────────────────────────────
const banUser = async (req, res) => {
  try {
    const { userId, reason } = req.body;

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'No podés banearte a vos mismo' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isBanned: true, banReason: reason || 'Violación de términos' },
    });

    await logAdminAction(req.user.id, 'BAN_USER', userId, { reason }, req);

    res.json({ message: `Usuario ${user.username} baneado` });
  } catch (error) {
    console.error('[ADMIN] banUser:', error);
    res.status(400).json({ error: 'Error al banear usuario' });
  }
};

// ─── Desbanear usuario ────────────────────────────────────────────────────────
const unbanUser = async (req, res) => {
  try {
    const { userId } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, banReason: null },
    });

    await logAdminAction(req.user.id, 'UNBAN_USER', userId, {}, req);

    res.json({ message: `Usuario ${user.username} desbaneado` });
  } catch (error) {
    res.status(400).json({ error: 'Error al desbanear usuario' });
  }
};

// ─── Crear partido deportivo ──────────────────────────────────────────────────
const createMatch = async (req, res) => {
  try {
    const { league, teamHome, teamAway, oddHome, oddDraw, oddAway, startsAt } = req.body;

    const match = await prisma.match.create({
      data: {
        league,
        teamHome,
        teamAway,
        oddHome: parseFloat(oddHome),
        oddDraw: parseFloat(oddDraw),
        oddAway: parseFloat(oddAway),
        startsAt: new Date(startsAt),
      },
    });

    await logAdminAction(req.user.id, 'CREATE_MATCH', null, {
      matchId: match.id, league, teamHome, teamAway,
    }, req);

    res.status(201).json({ message: 'Partido creado', match });
  } catch (error) {
    console.error('[ADMIN] createMatch:', error);
    res.status(400).json({ error: 'Error al crear partido' });
  }
};

// ─── Resolver partido y pagar apuestas ───────────────────────────────────────
const resolveMatch = async (req, res) => {
  try {
    const { matchId, result, scoreHome, scoreAway } = req.body;

    if (!['HOME', 'DRAW', 'AWAY'].includes(result)) {
      return res.status(400).json({ error: 'Resultado inválido' });
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { bets: true },
    });

    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status === 'FINISHED') return res.status(400).json({ error: 'Partido ya resuelto' });

    let paidBets = 0;
    let refundedBets = 0;

    await prisma.$transaction(async (tx) => {
      // Actualiza el partido
      await tx.match.update({
        where: { id: matchId },
        data: {
          status: 'FINISHED',
          result,
          scoreHome: parseInt(scoreHome),
          scoreAway: parseInt(scoreAway),
          resolvedAt: new Date(),
        },
      });

      // Procesa cada apuesta pendiente
      for (const bet of match.bets) {
        if (bet.status !== 'PENDING') continue;

        const won = bet.selection === result;

        await tx.bet.update({
          where: { id: bet.id },
          data: {
            status: won ? 'WON' : 'LOST',
            resolvedAt: new Date(),
          },
        });

        if (won) {
          await transferCoins(
            tx, bet.userId, parseFloat(bet.potentialWin),
            'SPORT_WIN',
            `Ganaste apuesta: ${match.teamHome} vs ${match.teamAway}`,
            bet.id
          );
          paidBets++;
        }
      }
    });

    await logAdminAction(req.user.id, 'RESOLVE_MATCH', null,
      { matchId, result, paidBets }, req);

    res.json({
      message: `Partido resuelto. Resultado: ${result}`,
      paidBets,
      refundedBets,
    });
  } catch (error) {
    console.error('[ADMIN] resolveMatch:', error);
    res.status(500).json({ error: 'Error al resolver partido' });
  }
};

// ─── Estadísticas generales ───────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [
      totalUsers,
      totalWagered,
      totalWon,
      totalGames,
      totalBets,
      recentGames,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.wallet.aggregate({ _sum: { totalWagered: true } }),
      prisma.wallet.aggregate({ _sum: { totalWon: true } }),
      prisma.gameHistory.count(),
      prisma.bet.count(),
      prisma.gameHistory.findMany({
        take: 10,
        orderBy: { playedAt: 'desc' },
        select: {
          gameType: true,
          betAmount: true,
          payout: true,
          result: true,
          playedAt: true,
          user: { select: { username: true } },
        },
      }),
    ]);

    const wagered = parseFloat(totalWagered._sum.totalWagered) || 0;
    const won     = parseFloat(totalWon._sum.totalWon)         || 0;
    const houseProfit = wagered - won;

    res.json({
      stats: {
        totalUsers,
        totalGames,
        totalBets,
        totalWagered: wagered,
        totalWon: won,
        houseProfit,
        houseEdgeReal: wagered > 0 ? ((houseProfit / wagered) * 100).toFixed(2) + '%' : '0%',
      },
      recentGames,
    });
  } catch (error) {
    console.error('[ADMIN] getStats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
};

// ─── Ver logs del admin ───────────────────────────────────────────────────────
const getAdminLogs = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          action: true,
          payload: true,
          ipAddress: true,
          createdAt: true,
          admin: { select: { username: true } },
          targetUser: { select: { username: true } },
        },
      }),
      prisma.adminLog.count(),
    ]);

    res.json({ logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener logs' });
  }
};

module.exports = {
  getAllUsers,
  giveCoins,
  giveCoinsAll,
  removeCoins,
  banUser,
  unbanUser,
  createMatch,
  resolveMatch,
  getStats,
  getAdminLogs,
};
