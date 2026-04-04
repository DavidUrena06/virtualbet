// betting/betting.routes.js
const express = require('express');
const { getMatches, placeBet, getBetHistory } = require('./betting.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/matches',  getMatches);
router.post('/place',   placeBet);
router.get('/history',  getBetHistory);

module.exports = router;
