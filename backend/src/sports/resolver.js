// sports/resolver.js
// Lógica compartida de resolución de partidos.
// Originalmente vivía inline en admin.controller.resolveMatch; ahora se reutiliza
// también desde el importer.autoResolveMatch cuando un partido termina vía API externa.

const { PrismaClient } = require('@prisma/client');
const { resolvePrivateBet } = require('../p2p/p2p.controller');
const { sendPushToUser } = require('../push/push.controller');
const prisma = new PrismaClient();

/**
 * Resuelve un partido: paga apuestas SportBet ganadoras y resuelve apuestas P2P
 * asociadas. Idempotente cuando se llama sobre un partido ya FINISHED.
 *
 * @param {string} matchId
 * @param {'HOME'|'DRAW'|'AWAY'} result
 * @param {object} opts
 * @param {number} [opts.scoreHome]
 * @param {number} [opts.scoreAway]
 * @returns {{ paidSportBets: number, resolvedP2P: number }}
 */
async function resolveMatch(matchId, result, opts = {}) {
  if (!['HOME', 'DRAW', 'AWAY'].includes(result)) {
    throw new Error(`Resultado inválido: ${result}`);
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { sportBets: true },
  });

  if (!match)                       throw new Error('Partido no encontrado');
  if (match.status === 'FINISHED')  return { paidSportBets: 0, resolvedP2P: 0, alreadyResolved: true };
  if (match.status === 'CANCELLED') throw new Error('Partido cancelado');

  let paidSportBets = 0;
  const winners = []; // { userId, payout, matchTitle } — push tras commit

  await prisma.$transaction(async (tx) => {
    await tx.match.update({
      where: { id: matchId },
      data: {
        status:     'FINISHED',
        result,
        scoreHome:  opts.scoreHome != null ? parseInt(opts.scoreHome, 10) : match.scoreHome,
        scoreAway:  opts.scoreAway != null ? parseInt(opts.scoreAway, 10) : match.scoreAway,
        resolvedAt: new Date(),
      },
    });

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
            title:   'Apuesta ganada',
            message: `Ganaste ${payout.toFixed(2)} BC en ${match.teamHome} vs ${match.teamAway}`,
            data:    { betId: bet.id, payout },
          },
        }).catch(() => {});
        winners.push({
          userId: bet.userId,
          payout,
          matchTitle: `${match.teamHome} vs ${match.teamAway}`,
        });
        paidSportBets++;
      }
    }
  });

  // Push notifications a ganadores (post-commit, no bloquea la respuesta)
  for (const w of winners) {
    sendPushToUser(w.userId, {
      title: '🎉 ¡Ganaste!',
      body:  `+${w.payout.toFixed(2)} BC en ${w.matchTitle}`,
      url:   '/pages/sports.html',
      tag:   `sport-win-${w.userId}`,
    }).catch(err => console.error('[RESOLVER] push:', err.message));
  }

  // Resuelve apuestas P2P asociadas al partido
  const p2pToResolve = await prisma.privateBet.findMany({
    where: { matchId, status: { in: ['LOCKED', 'OPEN'] } },
  });
  let resolvedP2P = 0;
  for (const pb of p2pToResolve) {
    if (pb.status === 'OPEN') {
      await prisma.privateBet.update({ where: { id: pb.id }, data: { status: 'LOCKED' } });
    }
    await resolvePrivateBet(pb.id, result);
    resolvedP2P++;
  }

  return { paidSportBets, resolvedP2P, alreadyResolved: false };
}

module.exports = { resolveMatch };
