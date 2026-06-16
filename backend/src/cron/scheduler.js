// cron/scheduler.js
// Tareas programadas de VirtualBet:
// 1. Cada minuto: lockea P2P al inicio del partido + expira invitaciones + recargas
// 2. Cada 2 min: updateLiveScores() — ESPN scoreboard → lookupevent → fallback tiempo
// 3. Cada 6 hs: importMatchesToDB() — trae partidos nuevos + calcula odds dinámicas
// 4. Cada 6 hs (offset 30m): recomputeUpcomingOdds() — refresca odds por forma reciente
// 5. Diario 3am UTC: cleanupOldMatches(7) — elimina partidos FINISHED > 7 días

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const { importMatchesToDB, updateLiveScores, cleanupOldMatches, recomputeUpcomingOdds } = require('../sports/importer');
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

// ══════════════════════════════════════════════════════════════
// SPORTSBOOK AUTOMÁTICO
// ══════════════════════════════════════════════════════════════

// Cada 2 minutos — scores en vivo + auto-resolución de partidos terminados
cron.schedule('*/2 * * * *', async () => {
  try {
    await updateLiveScores();
  } catch (err) {
    console.error('[CRON] updateLiveScores:', err.message);
  }
});

// Cada 6 horas — importa nuevos partidos por liga
cron.schedule('0 */6 * * *', async () => {
  try {
    await importMatchesToDB();
  } catch (err) {
    console.error('[CRON] importMatchesToDB:', err.message);
  }
});

// Cada día a las 3am UTC — elimina partidos FINISHED con más de 7 días
cron.schedule('0 3 * * *', async () => {
  try {
    const { deleted } = await cleanupOldMatches(7);
    if (deleted > 0) console.log(`[CRON] Limpieza: ${deleted} partidos eliminados`);
  } catch (err) {
    console.error('[CRON] cleanupOldMatches:', err.message);
  }
});

// Cada 6 horas (offset 30 min para no chocar con importMatchesToDB) — recalcula
// odds de partidos UPCOMING en base a la forma reciente de los equipos
cron.schedule('30 */6 * * *', async () => {
  try {
    await recomputeUpcomingOdds();
  } catch (err) {
    console.error('[CRON] recomputeUpcomingOdds:', err.message);
  }
});

// Una importación inicial al arrancar (delay 30s para no chocar con boot)
setTimeout(() => {
  importMatchesToDB().catch(err =>
    console.error('[CRON] import inicial:', err.message));
}, 30000);

console.log('[CRON] Scheduler VirtualBet iniciado');