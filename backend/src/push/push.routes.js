// push/push.routes.js
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  getPublicKey,
  subscribe,
  unsubscribe,
  sendTest,
} = require('./push.controller');

const router = express.Router();

// Public key es público (no requiere auth)
router.get('/public-key', getPublicKey);

router.use(requireAuth);
router.post('/subscribe',   subscribe);
router.post('/unsubscribe', unsubscribe);
router.post('/test',        sendTest);

module.exports = router;
