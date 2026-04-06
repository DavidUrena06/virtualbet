// p2p/p2p.routes.js

const express  = require('express');
const { body } = require('express-validator');
const { requireAuth } = require('../middleware/auth.middleware');

const {
  createPrivateBet,
  joinPrivateBet,
  cancelPrivateBet,
  getPrivateBet,
  getMyPrivateBets,
} = require('./p2p.controller');

const router = express.Router();
router.use(requireAuth);

// Crear apuesta P2P
router.post('/create', [
  body('matchId').notEmpty().withMessage('matchId requerido'),
  body('title').notEmpty().withMessage('Título requerido'),
  body('minAmount').isFloat({ min: 1 }).withMessage('Mínimo: 1 BC'),
  body('creatorSelection').isIn(['HOME','DRAW','AWAY']).withMessage('Selección inválida'),
  body('creatorAmount').isFloat({ min: 1 }).withMessage('Apuesta mínima: 1 BC'),
], createPrivateBet);

// Unirse a apuesta P2P
router.post('/join', [
  body('privateBetId').notEmpty().withMessage('privateBetId requerido'),
  body('selection').isIn(['HOME','DRAW','AWAY']).withMessage('Selección inválida'),
  body('amount').isFloat({ min: 1 }).withMessage('Apuesta mínima: 1 BC'),
], joinPrivateBet);

// Cancelar apuesta P2P
router.post('/cancel', [
  body('privateBetId').notEmpty().withMessage('privateBetId requerido'),
], cancelPrivateBet);

// Ver apuesta por ID
router.get('/:id', getPrivateBet);

// Mis apuestas P2P
router.get('/my', getMyPrivateBets);

module.exports = router;