// admin/admin.routes.js
const express = require('express');
const { body } = require('express-validator');
const {
  getAllUsers, giveCoins, giveCoinsAll, removeCoins,
  banUser, unbanUser, createMatch, resolveMatch,
  getStats, getAdminLogs,
} = require('./admin.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAdmin); // Todas las rutas requieren admin

router.get('/users',              getAllUsers);
router.get('/stats',              getStats);
router.get('/logs',               getAdminLogs);
router.post('/coins/give',        giveCoins);
router.post('/coins/give-all',    giveCoinsAll);
router.post('/coins/remove',      removeCoins);
router.post('/ban',               banUser);
router.post('/unban',             unbanUser);
router.post('/matches',           createMatch);
router.post('/matches/resolve',   resolveMatch);

module.exports = router;
