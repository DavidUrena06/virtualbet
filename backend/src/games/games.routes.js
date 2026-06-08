// games/games.routes.js — VERSIÓN COMPLETA CON TODOS LOS JUEGOS

const express   = require('express');
const { body }  = require('express-validator');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth.middleware');

const {
  playDice,
  playCoinflip,
  startCrash,
  cashoutCrash,
  getCrashStatus,
  getGameHistory,
  startMines,
  revealCell,
  cashoutMines,
  playPlinko,
  playRoulette,
} = require('./games.controller');

const blackjack = require('./blackjack.controller');
const keno      = require('./keno.controller');

const router = express.Router();
router.use(requireAuth);

const gameLimiter = rateLimit({
  windowMs: 1000,
  max: 5,
  message: { error: 'Demasiados requests. Tomá un respiro.' },
});
router.use(gameLimiter);

// ─── Dice ─────────────────────────────────────────────────────────────────────
router.post('/dice', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('target').isInt({ min: 2, max: 98 }).withMessage('Target: 2-98'),
  body('direction').isIn(['OVER', 'UNDER']).withMessage('Dirección: OVER o UNDER'),
], playDice);

// ─── Coinflip ─────────────────────────────────────────────────────────────────
router.post('/coinflip', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('choice').isIn(['HEADS', 'TAILS']).withMessage('Elegí HEADS o TAILS'),
], playCoinflip);

// ─── Crash ────────────────────────────────────────────────────────────────────
router.post('/crash/start', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
], startCrash);

router.post('/crash/cashout', [
  body('roundId').notEmpty().withMessage('roundId requerido'),
  body('cashoutAt').isFloat({ min: 1.01 }).withMessage('Cashout mínimo: 1.01x'),
], cashoutCrash);

// GET /api/games/crash/status?roundId=xxx — polling sin consumir la ronda
router.get('/crash/status', getCrashStatus);

// ─── Mines ────────────────────────────────────────────────────────────────────
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

// ─── Plinko ───────────────────────────────────────────────────────────────────
router.post('/plinko', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('risk').isIn(['low', 'mid', 'high']).withMessage('Riesgo: low, mid o high'),
], playPlinko);

// ─── Ruleta ───────────────────────────────────────────────────────────────────
router.post('/roulette', [
  body('betAmount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('betType').isIn(['number','color','parity','dozen','half']).withMessage('Tipo inválido'),
  body('betValue').notEmpty().withMessage('betValue requerido'),
], playRoulette);

// ─── Blackjack ────────────────────────────────────────────────────────────────
router.post('/blackjack/deal', [
  body('amount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
], blackjack.deal);
router.post('/blackjack/hit', [
  body('gameId').notEmpty().withMessage('gameId requerido'),
], blackjack.hit);
router.post('/blackjack/stand', [
  body('gameId').notEmpty().withMessage('gameId requerido'),
], blackjack.stand);
router.post('/blackjack/double', [
  body('gameId').notEmpty().withMessage('gameId requerido'),
], blackjack.double);

// ─── Keno ─────────────────────────────────────────────────────────────────────
router.post('/keno/play', [
  body('amount').isFloat({ min: 1, max: 10000 }).withMessage('Apuesta: 1-10,000'),
  body('picks').isArray({ min: 1, max: 10 }).withMessage('Picks: 1-10 números'),
], keno.play);

// ─── Historial ────────────────────────────────────────────────────────────────
router.get('/history', getGameHistory);

module.exports = router;