// cron/scheduler.js
// Recargas automáticas de monedas programadas por el admin

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Carga y ejecuta los schedules activos ────────────────────────────────────
const runSchedule = async (schedule) => {
  try {
    console.log(`[CRON] Ejecutando schedule: ${schedule.name}`);

    const users = schedule.targetType === 'ALL_USERS'
      ? await prisma.user.findMany({
          where: { isBanned: false, role: 'USER' },
          select: { id: true },
        })
      : [{ id: schedule.targetUserId }];

    const batchSize = 50;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      await prisma.$transaction(async (tx) => {
        for (const user of batch) {
          const wallet = await tx.wallet.findUnique({ where: { userId: user.id } });
          if (!wallet) continue;

          const amount = parseFloat(schedule.amount);
          const newBalance = parseFloat(wallet.balance) + amount;

          await tx.wallet.update({
            where: { userId: user.id },
            data: { balance: newBalance, totalDeposited: { increment: amount } },
          });

          await tx.transaction.create({
            data: {
              userId: user.id,
              walletId: wallet.id,
              type: 'SCHEDULED_BONUS',
              amount,
              balanceBefore: wallet.balance,
              balanceAfter: newBalance,
              note: `Recarga automática: ${schedule.name}`,
              reference: schedule.id,
            },
          });
        }
      });
    }

    // Actualiza lastRun
    await prisma.coinSchedule.update({
      where: { id: schedule.id },
      data: { lastRun: new Date() },
    });

    console.log(`[CRON] Schedule "${schedule.name}" ejecutado para ${users.length} usuarios`);
  } catch (error) {
    console.error(`[CRON] Error en schedule ${schedule.name}:`, error);
  }
};

// ─── Job que revisa schedules cada minuto ─────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const schedules = await prisma.coinSchedule.findMany({
      where: {
        isActive: true,
        nextRun: { lte: now },
      },
    });

    for (const schedule of schedules) {
      await runSchedule(schedule);
    }
  } catch (error) {
    console.error('[CRON] Error en scheduler principal:', error);
  }
});

// ─── Job que cierra apuestas cuando inicia el partido ────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    await prisma.match.updateMany({
      where: {
        status: 'UPCOMING',
        startsAt: { lte: new Date() },
      },
      data: { status: 'LIVE' },
    });
  } catch (error) {
    console.error('[CRON] Error cerrando apuestas:', error);
  }
});

console.log('[CRON] Scheduler iniciado');
