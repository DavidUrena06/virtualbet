// games/games.routes.js
const express = require('express');
const { body } = require('express-validator');
const {
  playDice,
  playCoinflip,
  startCrash,
  cashoutCrash,
  getGameHistory,
} = require('./games.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

// Rate limit específico para juegos (evita spam de requests)
const rateLimit = require('express-rate-limit');
const gameLimiter = rateLimit({
  windowMs: 1000, // 1 segundo
  max: 5,         // máximo 5 juegos por segundo por IP
  message: { error: 'Demasiados requests. Calmate un poco.' },
});

router.use(gameLimiter);

// POST /api/games/dice
router.post('/dice', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('target').isInt({ min: 2, max: 98 }).withMessage('Target: 2-98'),
  body('direction').isIn(['OVER', 'UNDER']).withMessage('Dirección: OVER o UNDER'),
], playDice);

// POST /api/games/coinflip
router.post('/coinflip', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('choice').isIn(['HEADS', 'TAILS']).withMessage('Elegí HEADS o TAILS'),
], playCoinflip);

// POST /api/games/crash/start
router.post('/crash/start', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
], startCrash);

// POST /api/games/crash/cashout
router.post('/crash/cashout', [
  body('roundId').notEmpty().withMessage('roundId requerido'),
  body('cashoutAt').isFloat({ min: 1.01 }).withMessage('Cashout mínimo: 1.01'),
], cashoutCrash);

// GET /api/games/history
router.get('/history', getGameHistory);

module.exports = router;
