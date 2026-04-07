// friends/friends.routes.js

const express = require('express');
const { body } = require('express-validator');
const {
  searchUsers, sendRequest, respondRequest,
  getFriends, getPendingRequests, removeFriend,
} = require('./friends.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

// Rutas específicas PRIMERO (antes que '/')
router.get('/search',   searchUsers);        // ?q=username
router.get('/requests', getPendingRequests);

// Luego la raíz
router.get('/', getFriends);

router.post('/request', [body('addresseeId').notEmpty()], sendRequest);
router.post('/respond', [
  body('friendshipId').notEmpty(),
  body('action').isIn(['accept', 'reject']),
], respondRequest);
router.post('/remove', [body('friendshipId').notEmpty()], removeFriend);

module.exports = router;