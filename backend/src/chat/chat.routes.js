// chat/chat.routes.js
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getMessages, sendMessage } = require('./chat.controller');

const router = express.Router();
router.use(requireAuth);

router.get('/:matchId',  getMessages);
router.post('/:matchId', sendMessage);

module.exports = router;
