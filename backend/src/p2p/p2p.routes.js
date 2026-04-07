// backend/src/p2p/p2p.routes.js
// IMPORTANTE: rutas estáticas (/my, /create, /join, /cancel) SIEMPRE antes de /:id
// Si /:id va primero, Express captura /my como id="my" y da 404

const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  createPrivateBet,
  joinPrivateBet,
  resolvePrivateBet,
  getPrivateBet,
  getMyPrivateBets,
  cancelPrivateBet,
} = require('./p2p.controller');

const router = express.Router();
router.use(requireAuth);

// ── Rutas estáticas primero (CRÍTICO) ─────────────────────────────────────

// GET /api/p2p/my?status=OPEN|LOCKED|RESOLVED
router.get('/my', getMyPrivateBets);

// POST /api/p2p/create
router.post('/create', [
  body('matchId').notEmpty().withMessage('matchId requerido'),
  body('title').isLength({ min: 3, max: 80 }).withMessage('Título: 3-80 caracteres'),
  body('minAmount').isFloat({ min: 1 }).withMessage('Mínimo: 1 BC'),
  body('creatorSelection').isIn(['HOME', 'DRAW', 'AWAY']).withMessage('Selección inválida'),
  body('creatorAmount').isFloat({ min: 1 }).withMessage('Apuesta mínima: 1 BC'),
], createPrivateBet);

// POST /api/p2p/join
router.post('/join', [
  body('privateBetId').notEmpty().withMessage('privateBetId requerido'),
  body('selection').isIn(['HOME', 'DRAW', 'AWAY']).withMessage('Selección inválida'),
  body('amount').isFloat({ min: 1 }).withMessage('Mínimo: 1 BC'),
], joinPrivateBet);

// POST /api/p2p/cancel
router.post('/cancel', [
  body('privateBetId').notEmpty().withMessage('privateBetId requerido'),
], cancelPrivateBet);

// ── Ruta dinámica al final (SIEMPRE última) ───────────────────────────────

// GET /api/p2p/:id
router.get('/:id', [
  param('id').isUUID().withMessage('ID de apuesta inválido'),
], getPrivateBet);

module.exports = router;