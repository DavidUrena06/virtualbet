// games/games.routes.js — VERSIÓN COMPLETA CON TODOS LOS JUEGOS
// Reemplaza el archivo games.routes.js existente con este

const express   = require('express');
const { body }  = require('express-validator');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth.middleware');

// Controladores originales (Dice, Coinflip, Crash)
const {
  playDice,
  playCoinflip,
  startCrash,
  cashoutCrash,
  getGameHistory,
} = require('./games.controller');

// Controladores nuevos (Mines, Plinko, Roulette)
const {
  startMines,
  revealCell,
  cashoutMines,
  playPlinko,
  playRoulette,
} = require('./games.controller');

const router = express.Router();
router.use(requireAuth);

// Rate limit anti-spam (5 requests por segundo por IP)
const gameLimiter = rateLimit({
  windowMs: 1000,
  max: 5,
  message: { error: 'Demasiados requests. Tomá un respiro.' },
});
router.use(gameLimiter);

// ─── Dice ──────────────────────────────────────────────────────────────────
router.post('/dice', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('target').isInt({ min: 2, max: 98 }).withMessage('Target: 2-98'),
  body('direction').isIn(['OVER', 'UNDER']).withMessage('Dirección: OVER o UNDER'),
], playDice);

// ─── Coinflip ─────────────────────────────────────────────────────────────
router.post('/coinflip', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('choice').isIn(['HEADS', 'TAILS']).withMessage('Elegí HEADS o TAILS'),
], playCoinflip);

// ─── Crash ────────────────────────────────────────────────────────────────
router.post('/crash/start', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
], startCrash);

router.post('/crash/cashout', [
  body('roundId').notEmpty().withMessage('roundId requerido'),
  body('cashoutAt').isFloat({ min: 1.01 }).withMessage('Cashout mínimo: 1.01x'),
], cashoutCrash);

// ─── Mines ────────────────────────────────────────────────────────────────
router.post('/mines/start', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('minesCount').isInt({ min: 1, max: 24 }).withMessage('Minas: 1-24'),
], startMines);

router.post('/mines/reveal', [
  body('gameId').notEmpty().withMessage('gameId requerido'),
  body('cellIndex').isInt({ min: 0, max: 24 }).withMessage('Celda: 0-24'),
], revealCell);

router.post('/mines/cashout', [
  body('gameId').notEmpty().withMessage('gameId requerido'),
], cashoutMines);

// ─── Plinko ───────────────────────────────────────────────────────────────
router.post('/plinko', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('risk').isIn(['low', 'mid', 'high']).withMessage('Riesgo: low, mid o high'),
], playPlinko);

// ─── Ruleta ───────────────────────────────────────────────────────────────
router.post('/roulette', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('betType').isIn(['number','color','parity','dozen','half'])
    .withMessage('Tipo inválido'),
  body('betValue').notEmpty().withMessage('betValue requerido'),
], playRoulette);

// ─── Historial ────────────────────────────────────────────────────────────
router.get('/history', getGameHistory);

module.exports = router;
