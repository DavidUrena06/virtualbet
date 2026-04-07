// backend/src/friends/friends.routes.js
// Mismo patrón: estáticas primero, dinámicas al final

const express = require('express');
const { body } = require('express-validator');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  searchUsers,
  sendRequest,
  respondRequest,
  getFriends,
  getPendingRequests,
  removeFriend,
} = require('./friends.controller');

const router = express.Router();
router.use(requireAuth);

// ── Rutas estáticas primero ────────────────────────────────────────────────

// GET /api/friends/search?q=username
router.get('/search', searchUsers);

// GET /api/friends/requests — solicitudes pendientes RECIBIDAS
router.get('/requests', getPendingRequests);

// GET /api/friends — lista de amigos aceptados
router.get('/', getFriends);

// POST /api/friends/request — enviar solicitud
router.post('/request', [
  body('addresseeId').notEmpty().withMessage('addresseeId requerido'),
], sendRequest);

// POST /api/friends/respond — aceptar o rechazar
router.post('/respond', [
  body('friendshipId').notEmpty().withMessage('friendshipId requerido'),
  body('action').isIn(['accept', 'reject']).withMessage('Acción: accept o reject'),
], respondRequest);

// POST /api/friends/remove — eliminar amistad
router.post('/remove', [
  body('friendshipId').notEmpty().withMessage('friendshipId requerido'),
], removeFriend);

module.exports = router;