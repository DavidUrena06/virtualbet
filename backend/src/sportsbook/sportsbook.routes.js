// ══════════════════════════════════════════════════════════
// sportsbook/sportsbook.routes.js
// ══════════════════════════════════════════════════════════
const express = require('express');
const { body } = require('express-validator');
const { getMatches, placeBet, getBetHistory, getMatchById } = require('./sportsbook.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/matches',      getMatches);        // ?league=LDA&status=UPCOMING
router.get('/matches/:id',  getMatchById);
router.post('/bet', [
  body('matchId').notEmpty(),
  body('selection').isIn(['HOME','DRAW','AWAY']),
  body('amount').isFloat({ min: 1, max: 100000 }),
], placeBet);
router.get('/history',      getBetHistory);

module.exports = router;


// ══════════════════════════════════════════════════════════
// routes/notifications.routes.js
// ══════════════════════════════════════════════════════════
const expressN = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth: reqAuth } = require('../middleware/auth.middleware');
const prismaNotif = new PrismaClient();
const routerN = expressN.Router();
routerN.use(reqAuth);

// GET /api/notifications — todas las del usuario
routerN.get('/', async (req, res) => {
  try {
    const notifs = await prismaNotif.notification.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    30,
    });
    const unread = notifs.filter(n => !n.isRead).length;
    res.json({ notifications: notifs, unread });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// POST /api/notifications/read-all
routerN.post('/read-all', async (req, res) => {
  try {
    await prismaNotif.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data:  { isRead: true },
    });
    res.json({ message: 'Notificaciones marcadas como leídas' });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

module.exports = { sportsbookRoutes: router, notificationsRoutes: routerN };


// ══════════════════════════════════════════════════════════
// cron/scheduler.js — ACTUALIZADO
// Incluye: cerrar apuestas, lockear P2P, resolver P2P junto con partidos
// ══════════════════════════════════════════════════════════
const cron = require('node-cron');
const { PrismaClient: PrismaCron } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const prismaCron = new PrismaCron();

// Cada minuto: cierra apuestas deportivas y lockea P2P cuando inicia el partido
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    // 1. Pasa partidos de UPCOMING a LIVE
    const justStarted = await prismaCron.match.findMany({
      where: { status: 'UPCOMING', startsAt: { lte: now } },
    });

    for (const match of justStarted) {
      await prismaCron.match.update({
        where: { id: match.id },
        data:  { status: 'LIVE' },
      });

      // 2. Lockea apuestas P2P de ese partido
      await prismaCron.privateBet.updateMany({
        where: { matchId: match.id, status: 'OPEN' },
        data:  { status: 'LOCKED', lockedAt: now },
      });

      // Notifica a participantes de P2P que fue lockeada
      const lockedBets = await prismaCron.privateBet.findMany({
        where:   { matchId: match.id, status: 'LOCKED' },
        include: { participants: { select: { userId: true } } },
      });

      for (const lb of lockedBets) {
        for (const p of lb.participants) {
          await prismaCron.notification.create({
            data: {
              userId:  p.userId,
              type:    'P2P_LOCKED',
              title:   'Apuesta P2P bloqueada',
              message: `"${lb.title}" fue bloqueada. El partido inició.`,
              data:    { privateBetId: lb.id },
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[CRON] Error en cierre de partidos:', err.message);
  }
});

// Cada minuto: ejecuta recargas programadas de BetCoins
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const schedules = await prismaCron.coinSchedule.findMany({
      where: { isActive: true, nextRun: { lte: now } },
    });

    for (const schedule of schedules) {
      const users = schedule.targetType === 'ALL_USERS'
        ? await prismaCron.user.findMany({
            where:  { isBanned: false, role: 'USER' },
            select: { id: true },
          })
        : [{ id: schedule.targetUserId }];

      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await prismaCron.$transaction(async (tx) => {
          for (const u of batch) {
            const wallet = await tx.wallet.findUnique({ where: { userId: u.id } });
            if (!wallet) continue;
            const amount = parseFloat(schedule.amount);
            await tx.wallet.update({
              where: { userId: u.id },
              data:  { balance: { increment: amount }, totalDeposited: { increment: amount } },
            });
            await tx.transaction.create({
              data: {
                userId:        u.id,
                walletId:      wallet.id,
                type:          'SCHEDULED_BONUS',
                amount,
                balanceBefore: wallet.balance,
                balanceAfter:  parseFloat(wallet.balance) + amount,
                note:          `Recarga automática: ${schedule.name}`,
                reference:     schedule.id,
              },
            });
          }
        });
      }

      await prismaCron.coinSchedule.update({
        where: { id: schedule.id },
        data:  { lastRun: now },
      });
    }
  } catch (err) {
    console.error('[CRON] Error en recargas:', err.message);
  }
});

console.log('[CRON] Scheduler VirtualBet iniciado');
