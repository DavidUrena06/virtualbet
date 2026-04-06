// sportsbook/sportsbook.routes.js

const express = require('express');
const { body } = require('express-validator');
const { getMatches, placeBet, getBetHistory, getMatchById } = require('./sportsbook.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/matches',     getMatches);
router.get('/matches/:id', getMatchById);
router.post('/bet', [
  body('matchId').notEmpty(),
  body('selection').isIn(['HOME','DRAW','AWAY']),
  body('amount').isFloat({ min: 1, max: 100000 }),
], placeBet);
router.get('/history', getBetHistory);

module.exports = router;