// backend/src/admin/admin.routes.js
const express = require('express');
const { body } = require('express-validator');
const { requireAdmin } = require('../middleware/auth.middleware');
const {
  getAllUsers,
  giveBetCoins,
  giveBetCoinsAll,
  removeBetCoins,
  banUser,
  unbanUser,
  createMatch,
  resolveMatch,
  getStats,
  getAdminLogs,
} = require('./admin.controller');

const router = express.Router();
router.use(requireAdmin);

// Usuarios
router.get('/users',              getAllUsers);
router.post('/ban',               [body('userId').notEmpty(), body('reason').optional()], banUser);
router.post('/unban',             [body('userId').notEmpty()], unbanUser);

// BetCoins
router.post('/coins/give',        [body('userId').notEmpty(), body('amount').isFloat({ min: 1 })], giveBetCoins);
router.post('/coins/give-all',    [body('amount').isFloat({ min: 1 })], giveBetCoinsAll);
router.post('/coins/remove',      [body('userId').notEmpty(), body('amount').isFloat({ min: 1 })], removeBetCoins);

// Partidos
router.post('/matches',           [
  body('league').notEmpty(),
  body('teamHome').notEmpty(),
  body('teamAway').notEmpty(),
  body('oddHome').isFloat({ min: 1.01 }),
  body('oddDraw').isFloat({ min: 1.01 }),
  body('oddAway').isFloat({ min: 1.01 }),
  body('startsAt').isISO8601(),
], createMatch);
router.post('/matches/resolve',   [
  body('matchId').notEmpty(),
  body('result').isIn(['HOME', 'DRAW', 'AWAY']),
], resolveMatch);

// Stats y logs
router.get('/stats',              getStats);
router.get('/logs',               getAdminLogs);

module.exports = router;
