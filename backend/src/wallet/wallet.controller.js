// wallet/wallet.controller.js
// Manejo de balance y transacciones del usuario

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Obtener balance del usuario ──────────────────────────────────────────────
const getBalance = async (req, res) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user.id },
      select: {
        balance: true,
        totalWagered: true,
        totalWon: true,
        totalDeposited: true,
        updatedAt: true,
      },
    });

    if (!wallet) {
      return res.status(404).json({ error: 'Wallet no encontrada' });
    }

    res.json({ wallet });
  } catch (error) {
    console.error('[WALLET] Error en getBalance:', error);
    res.status(500).json({ error: 'Error al obtener balance' });
  }
};

// ─── Historial de transacciones ───────────────────────────────────────────────
const getTransactions = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          note: true,
          reference: true,
          createdAt: true,
        },
      }),
      prisma.transaction.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('[WALLET] Error en getTransactions:', error);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
};

// ─── Función interna: mover monedas con ledger ────────────────────────────────
// Esta función es usada por los juegos y apuestas, no es una ruta pública
const transferCoins = async (tx, userId, amount, type, note, reference = null) => {
  // amount positivo = sumar, negativo = restar
  const wallet = await tx.wallet.findUnique({ where: { userId } });

  if (!wallet) throw new Error('Wallet no encontrada');

  const newBalance = parseFloat(wallet.balance) + amount;

  if (newBalance < 0) {
    throw new Error('Saldo insuficiente');
  }

  // Actualiza wallet
  const updatedWallet = await tx.wallet.update({
    where: { userId },
    data: {
      balance: newBalance,
      totalWagered: amount < 0
        ? { increment: Math.abs(amount) }
        : wallet.totalWagered,
      totalWon: amount > 0 && (type === 'GAME_WIN' || type === 'SPORT_WIN')
        ? { increment: amount }
        : wallet.totalWon,
    },
  });

  // Registra en el ledger
  await tx.transaction.create({
    data: {
      userId,
      walletId: wallet.id,
      type,
      amount: Math.abs(amount),
      balanceBefore: wallet.balance,
      balanceAfter: newBalance,
      note,
      reference,
    },
  });

  return updatedWallet;
};

module.exports = { getBalance, getTransactions, transferCoins };
