// cron/scheduler.js

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const prisma = new PrismaClient();

// Cada minuto: cierra apuestas y lockea P2P cuando inicia el partido
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const justStarted = await prisma.match.findMany({
      where: { status: 'UPCOMING', startsAt: { lte: now } },
    });

    for (const match of justStarted) {
      await prisma.match.update({
        where: { id: match.id },
        data:  { status: 'LIVE' },
      });

      await prisma.privateBet.updateMany({
        where: { matchId: match.id, status: 'OPEN' },
        data:  { status: 'LOCKED', lockedAt: now },
      });

      const lockedBets = await prisma.privateBet.findMany({
        where:   { matchId: match.id, status: 'LOCKED' },
        include: { participants: { select: { userId: true } } },
      });

      for (const lb of lockedBets) {
        for (const p of lb.participants) {
          await prisma.notification.create({
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
    const schedules = await prisma.coinSchedule.findMany({
      where: { isActive: true, nextRun: { lte: now } },
    });

    for (const schedule of schedules) {
      const users = schedule.targetType === 'ALL_USERS'
        ? await prisma.user.findMany({
            where:  { isBanned: false, role: 'USER' },
            select: { id: true },
          })
        : [{ id: schedule.targetUserId }];

      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await prisma.$transaction(async (tx) => {
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

      await prisma.coinSchedule.update({
        where: { id: schedule.id },
        data:  { lastRun: now },
      });
    }
  } catch (err) {
    console.error('[CRON] Error en recargas:', err.message);
  }
});

console.log('[CRON] Scheduler VirtualBet iniciado');