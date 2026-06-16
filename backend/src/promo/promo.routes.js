// promo/promo.routes.js
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  getDailyBonusStatus,
  claimDailyBonus,
  getLeaderboard,
} = require('./promo.controller');

const router = express.Router();
router.use(requireAuth);

router.get('/daily',         getDailyBonusStatus);
router.post('/daily/claim',  claimDailyBonus);
router.get('/leaderboard',   getLeaderboard);

module.exports = router;
