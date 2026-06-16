// promo/promo.controller.js
// Sistema de promociones: daily login bonus, leaderboard, eventos especiales.
//
// EVENTO MUNDIAL 2026 (FIFA World Cup en USA/Canadá/México):
//   - Junio 11 a Julio 19, 2026
//   - Daily bonus x2
//   - Featured matches con cuotas destacadas
//
// El bono diario usa el tipo SCHEDULED_BONUS del enum existente con un prefijo
// "DAILY:" en el campo `note`, así no necesitamos migración de DB.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Configuración del evento Mundial ────────────────────────────────────────
const WORLD_CUP_START = new Date('2026-06-11T00:00:00Z');
const WORLD_CUP_END   = new Date('2026-07-19T23:59:59Z');

function isWorldCupActive(now = new Date()) {
  return now >= WORLD_CUP_START && now <= WORLD_CUP_END;
}

// ─── Bono diario por racha ───────────────────────────────────────────────────
// Día 1: 100, Día 2: 150, Día 3: 200, ..., Día 7: 500 (max). Se resetea si
// el usuario falta más de 1 día. Durante el Mundial, x2.
const DAILY_BONUS_AMOUNTS = [100, 150, 200, 250, 300, 400, 500];

function dailyBonusForStreak(streak, mundialActive) {
  const idx    = Math.min(streak - 1, DAILY_BONUS_AMOUNTS.length - 1);
  const amount = DAILY_BONUS_AMOUNTS[Math.max(0, idx)];
  return mundialActive ? amount * 2 : amount;
}

// Calcula racha actual basada en las últimas N transacciones DAILY: del usuario
async function computeDailyStreak(userId, now = new Date()) {
  const last = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'SCHEDULED_BONUS',
      note: { startsWith: 'DAILY:' },
    },
    orderBy: { createdAt: 'desc' },
    take: 14,
    select: { createdAt: true },
  });

  if (last.length === 0) return { streak: 0, lastClaimAt: null };

  const lastClaimAt  = last[0].createdAt;
  const dayMs        = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfLast  = new Date(lastClaimAt.getFullYear(), lastClaimAt.getMonth(), lastClaimAt.getDate());
  const daysSince    = Math.round((startOfToday - startOfLast) / dayMs);

  if (daysSince >= 2) return { streak: 0, lastClaimAt };

  // Construye racha: cuenta días consecutivos hacia atrás
  let streak = 1;
  let cursor = startOfLast;
  for (let i = 1; i < last.length; i++) {
    const d   = last[i].createdAt;
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const gap = Math.round((cursor - day) / dayMs);
    if (gap === 1) { streak++; cursor = day; }
    else break;
  }

  return { streak, lastClaimAt };
}

// GET /api/promo/daily — status del bono diario (sin reclamar)
const getDailyBonusStatus = async (req, res) => {
  try {
    const userId          = req.user.id;
    const now             = new Date();
    const { streak, lastClaimAt } = await computeDailyStreak(userId, now);

    // ¿Ya reclamó hoy?
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const canClaim     = !lastClaimAt || lastClaimAt < startOfToday;

    const mundialActive = isWorldCupActive(now);
    const nextStreak    = canClaim ? (streak + 1 || 1) : streak;
    const amount        = dailyBonusForStreak(nextStreak, mundialActive);

    res.json({
      canClaim,
      currentStreak: streak,
      nextStreakDay: nextStreak,
      nextAmount:    amount,
      mundialActive,
      mundialMultiplier: mundialActive ? 2 : 1,
      lastClaimAt,
    });
  } catch (err) {
    console.error('[PROMO] daily status:', err.message);
    res.status(500).json({ error: 'Error al obtener bono diario' });
  }
};

// POST /api/promo/daily/claim — reclama el bono del día
const claimDailyBonus = async (req, res) => {
  try {
    const userId = req.user.id;
    const now    = new Date();

    const { streak, lastClaimAt } = await computeDailyStreak(userId, now);
    const startOfToday            = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (lastClaimAt && lastClaimAt >= startOfToday) {
      return res.status(400).json({ error: 'Ya reclamaste tu bono de hoy. Volvé mañana.' });
    }

    const mundialActive = isWorldCupActive(now);
    const newStreak     = streak + 1;
    const amount        = dailyBonusForStreak(newStreak, mundialActive);

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error('Wallet no encontrada');

      const newBalance = parseFloat(wallet.balance) + amount;
      await tx.wallet.update({
        where: { userId },
        data:  { balance: newBalance, totalDeposited: { increment: amount } },
      });

      const note = mundialActive
        ? `DAILY: día ${newStreak} ⚽ Mundial x2 (+${amount} BC)`
        : `DAILY: día ${newStreak} (+${amount} BC)`;

      await tx.transaction.create({
        data: {
          userId,
          walletId:      wallet.id,
          type:          'SCHEDULED_BONUS',
          amount,
          balanceBefore: wallet.balance,
          balanceAfter:  newBalance,
          note,
        },
      });

      return { newBalance };
    });

    res.json({
      message:       mundialActive
        ? `+${amount} BC (día ${newStreak} de tu racha · Mundial x2 🏆)`
        : `+${amount} BC reclamados (día ${newStreak} de racha)`,
      amount,
      newStreak,
      mundialActive,
      newBalance:    result.newBalance,
    });
  } catch (err) {
    console.error('[PROMO] claim daily:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── Leaderboard semanal de apuestas deportivas ──────────────────────────────
// GET /api/promo/leaderboard?period=week&mundial=true
const getLeaderboard = async (req, res) => {
  try {
    const period         = (req.query.period || 'week').toLowerCase();
    const onlyMundial    = req.query.mundial === 'true';

    const days  = period === 'today' ? 1 : period === 'month' ? 30 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Filtra apuestas ganadas en el período
    const where = {
      status:     'WON',
      resolvedAt: { gte: since },
    };
    if (onlyMundial) {
      where.match = { league: 'FIFA_WORLD_CUP' };
    }

    const wonBets = await prisma.sportBet.findMany({
      where,
      select: {
        userId:       true,
        amount:       true,
        potentialWin: true,
        user:         { select: { username: true, avatarEmoji: true } },
      },
    });

    // Agrupa por usuario
    const byUser = {};
    for (const bet of wonBets) {
      const profit = parseFloat(bet.potentialWin) - parseFloat(bet.amount);
      const key    = bet.userId;
      if (!byUser[key]) {
        byUser[key] = {
          userId:       bet.userId,
          username:     bet.user.username,
          avatarEmoji:  bet.user.avatarEmoji || '🎰',
          totalProfit:  0,
          wonBets:      0,
          totalWinnings: 0,
        };
      }
      byUser[key].totalProfit   += profit;
      byUser[key].totalWinnings += parseFloat(bet.potentialWin);
      byUser[key].wonBets++;
    }

    const top = Object.values(byUser)
      .sort((a, b) => b.totalProfit - a.totalProfit)
      .slice(0, 20)
      .map((u, i) => ({
        rank:          i + 1,
        ...u,
        totalProfit:   +u.totalProfit.toFixed(2),
        totalWinnings: +u.totalWinnings.toFixed(2),
      }));

    res.json({
      period,
      onlyMundial,
      mundialActive: isWorldCupActive(),
      since,
      leaderboard:   top,
    });
  } catch (err) {
    console.error('[PROMO] leaderboard:', err.message);
    res.status(500).json({ error: 'Error al obtener leaderboard' });
  }
};

module.exports = {
  getDailyBonusStatus,
  claimDailyBonus,
  getLeaderboard,
  isWorldCupActive,
  WORLD_CUP_START,
  WORLD_CUP_END,
};
