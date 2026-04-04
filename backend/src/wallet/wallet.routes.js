// wallet/wallet.routes.js
const express = require('express');
const { getBalance, getTransactions } = require('./wallet.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// Todas las rutas de wallet requieren autenticación
router.use(requireAuth);

// GET /api/wallet/balance
router.get('/balance', getBalance);

// GET /api/wallet/transactions
router.get('/transactions', getTransactions);

module.exports = router;
