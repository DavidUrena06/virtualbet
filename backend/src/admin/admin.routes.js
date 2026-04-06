// admin/admin.routes.js
const express = require('express');
const { body } = require('express-validator');
const {
  getAllUsers, giveBetCoins, giveBetCoinsAll, removeBetCoins,
  banUser, unbanUser, createMatch, resolveMatch,
  getStats, getAdminLogs,
} = require('./admin.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAdmin); // Todas las rutas requieren admin

router.get('/users',              getAllUsers);
router.get('/stats',              getStats);
router.get('/logs',               getAdminLogs);
router.post("/coins/give", giveBetCoins);
router.post("/coins/give-all", giveBetCoinsAll);
router.post("/coins/remove", removeBetCoins);
router.post('/ban',               banUser);
router.post('/unban',             unbanUser);
router.post('/matches',           createMatch);
router.post('/matches/resolve',   resolveMatch);

module.exports = router;
