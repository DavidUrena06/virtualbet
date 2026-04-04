// auth/auth.routes.js
// Rutas de registro, login y perfil

const express = require('express');
const { body } = require('express-validator');
const { register, login, getMe } = require('./auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// ─── Validaciones ─────────────────────────────────────────────────────────────
const registerValidations = [
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username: 3-20 caracteres')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username: solo letras, números y guión bajo'),

  body('email')
    .trim()
    .isEmail()
    .withMessage('Email inválido')
    .normalizeEmail(),

  body('password')
    .isLength({ min: 8 })
    .withMessage('Contraseña: mínimo 8 caracteres')
    .matches(/[A-Z]/)
    .withMessage('Contraseña: al menos una mayúscula')
    .matches(/[0-9]/)
    .withMessage('Contraseña: al menos un número'),
];

const loginValidations = [
  body('email').trim().isEmail().withMessage('Email inválido').normalizeEmail(),
  body('password').notEmpty().withMessage('Contraseña requerida'),
];

// ─── Rutas ────────────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/register', registerValidations, register);

// POST /api/auth/login
router.post('/login', loginValidations, login);

// GET /api/auth/me  (requiere JWT)
router.get('/me', requireAuth, getMe);

module.exports = router;
