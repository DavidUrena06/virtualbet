// auth/auth.controller.js
// Registro, login y datos del usuario autenticado

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Registro de usuario ──────────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    // Valida inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password } = req.body;

    // Verifica que no exista el usuario
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { username: username.toLowerCase() },
        ],
      },
    });

    if (existingUser) {
      const field = existingUser.email === email.toLowerCase() ? 'email' : 'username';
      return res.status(409).json({ error: `Este ${field} ya está en uso` });
    }

    // Hashea la contraseña (12 rounds = seguro pero no lento)
    const passwordHash = await bcrypt.hash(password, 12);

    // Crea usuario + wallet en una sola transacción de BD
    const welcomeBonus = parseFloat(process.env.WELCOME_BONUS) || 100; // Bonus de bienvenida configurable

    const user = await prisma.$transaction(async (tx) => {
      // Crea el usuario
      const newUser = await tx.user.create({
        data: {
          username: username.toLowerCase(),
          email: email.toLowerCase(),
          passwordHash,
        },
      });

      // Crea su wallet con bonus de bienvenida
      const wallet = await tx.wallet.create({
        data: {
          userId: newUser.id,
          balance: welcomeBonus,
          totalDeposited: welcomeBonus,
        },
      });

      // Registra la transacción inicial en el ledger
      await tx.transaction.create({
        data: {
          userId: newUser.id,
          walletId: wallet.id,
          type: 'ADMIN_DEPOSIT',
          amount: welcomeBonus,
          balanceBefore: 0,
          balanceAfter: welcomeBonus,
          note: 'Bonus de bienvenida',
        },
      });

      return newUser;
    });

    // Genera JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      message: 'Cuenta creada exitosamente',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[AUTH] Error en registro:', error);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
};

// ─── Login ────────────────────────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Busca el usuario (respuesta genérica para no revelar si el email existe)
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { wallet: true },
    });

    // Siempre compara hash para evitar timing attacks
    const passwordMatch = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, '$2b$12$invalidhashtopreventtimingatk');

    if (!user || !passwordMatch) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    if (user.isBanned) {
      return res.status(403).json({
        error: `Cuenta suspendida. Razón: ${user.banReason || 'Violación de términos'}`,
      });
    }

    // Genera JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      message: 'Sesión iniciada',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.wallet?.balance || 0,
      },
    });
  } catch (error) {
    console.error('[AUTH] Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
};

// ─── Datos del usuario autenticado ───────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
        wallet: {
          select: {
            balance: true,
            totalWagered: true,
            totalWon: true,
          },
        },
      },
    });

    res.json({ user });
  } catch (error) {
    console.error('[AUTH] Error en getMe:', error);
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
};

module.exports = { register, login, getMe };
