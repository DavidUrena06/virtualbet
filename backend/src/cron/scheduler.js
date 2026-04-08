// cron/scheduler.js
// Tareas programadas de VirtualBet:
// 1. Lockea apuestas P2P cuando inicia el partido (cada minuto)
// 2. Expira invitaciones P2P pendientes al lockear (mismo ciclo)
// 3. Ejecuta recargas automáticas de BetCoins (cada minuto)

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const prisma = new PrismaClient();

// ══════════════════════════════════════════════════════════════
// CADA MINUTO: cierra partidos, lockea P2P, expira invitaciones
// ══════════════════════════════════════════════════════════════

cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    // Busca partidos UPCOMING que ya debieron iniciar
    const justStarted = await prisma.match.findMany({
      where: { status: 'UPCOMING', startsAt: { lte: now } },
    });

    for (const match of justStarted) {
      // 1. Marca el partido como LIVE
      await prisma.match.update({
        where: { id: match.id },
        data:  { status: 'LIVE' },
      });

      // 2. Lockea todas las apuestas P2P abiertas de este partido
      await prisma.privateBet.updateMany({
        where: { matchId: match.id, status: 'OPEN' },
        data:  { status: 'LOCKED', lockedAt: now },
      });

      // 3. Expira todas las invitaciones PENDING de apuestas de este partido
      // Se hace en dos pasos: primero obtiene los IDs de apuestas lockeadas,
      // luego expira sus invitaciones
      const apuestasLockeadas = await prisma.privateBet.findMany({
        where:  { matchId: match.id, status: 'LOCKED' },
        select: { id: true, title: true, participants: { select: { userId: true } } },
      });

      for (const apuesta of apuestasLockeadas) {
        // Expira invitaciones pendientes
        await prisma.p2PInvitation.updateMany({
          where: { privateBetId: apuesta.id, status: 'PENDING' },
          data:  { status: 'EXPIRED', respondedAt: now },
        });

        // Notifica a los participantes que la apuesta quedó bloqueada
        for (const p of apuesta.participants) {
          await prisma.notification.create({
            data: {
              userId:  p.userId,
              type:    'P2P_LOCKED',
              title:   'Apuesta P2P bloqueada',
              message: `"${apuesta.title}" fue bloqueada. El partido inició.`,
              data:    { privateBetId: apuesta.id },
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[CRON] Error en cierre de partidos:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════
// CADA MINUTO: ejecuta recargas programadas de BetCoins
// ══════════════════════════════════════════════════════════════

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

      // Procesa en lotes de 50 para no saturar Supabase free tier
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