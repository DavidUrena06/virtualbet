// chat/chat.controller.js
// Chat de partidos basado en polling (GET con ?after=timestamp cada 5s).
// No usamos WebSocket porque el free tier de Render duerme los sockets.

const { PrismaClient } = require('@prisma/client');
const xss = require('xss');
const prisma = new PrismaClient();

// Rate limit en memoria: máx 1 mensaje cada 3s por usuario
const lastMessageAt = new Map();
const COOLDOWN_MS   = 3000;
const MAX_LENGTH    = 280;

// GET /api/chat/:matchId?after=ISO_TIMESTAMP
const getMessages = async (req, res) => {
  try {
    const { matchId } = req.params;
    const after       = req.query.after ? new Date(req.query.after) : null;

    const match = await prisma.match.findUnique({
      where:  { id: matchId },
      select: { id: true, status: true, teamHome: true, teamAway: true },
    });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });

    const where = { matchId };
    if (after && !isNaN(after.getTime())) {
      where.createdAt = { gt: after };
    }

    const messages = await prisma.matchMessage.findMany({
      where,
      orderBy: { createdAt: after ? 'asc' : 'desc' },
      take:    after ? 50 : 30,
      include: {
        user: { select: { username: true, avatarEmoji: true, role: true } },
      },
    });

    // Si no es polling incremental, devolvemos en orden cronológico
    const ordered = after ? messages : messages.reverse();

    res.json({
      match: {
        id: match.id, status: match.status,
        teamHome: match.teamHome, teamAway: match.teamAway,
      },
      messages: ordered.map(m => ({
        id:        m.id,
        message:   m.message,
        username:  m.user.username,
        avatar:    m.user.avatarEmoji,
        isAdmin:   m.user.role === 'ADMIN',
        createdAt: m.createdAt,
      })),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CHAT] getMessages:', err.message);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
};

// POST /api/chat/:matchId  body: { message }
const sendMessage = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId      = req.user.id;
    const raw         = (req.body.message || '').trim();

    if (!raw)                  return res.status(400).json({ error: 'Mensaje vacío' });
    if (raw.length > MAX_LENGTH) return res.status(400).json({ error: `Máximo ${MAX_LENGTH} caracteres` });

    // Rate limit
    const last = lastMessageAt.get(userId) || 0;
    const now  = Date.now();
    if (now - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({ error: `Esperá ${wait}s entre mensajes` });
    }

    const match = await prisma.match.findUnique({
      where:  { id: matchId },
      select: { id: true, status: true },
    });
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    if (match.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Chat cerrado para este partido' });
    }

    // Sanitize HTML
    const message = xss(raw, { whiteList: {}, stripIgnoreTag: true });
    if (!message) return res.status(400).json({ error: 'Mensaje inválido' });

    const saved = await prisma.matchMessage.create({
      data:    { matchId, userId, message },
      include: { user: { select: { username: true, avatarEmoji: true, role: true } } },
    });

    lastMessageAt.set(userId, now);

    // Cleanup periódico del Map (evita leak en runtime largo)
    if (lastMessageAt.size > 5000) {
      const cutoff = now - 60_000;
      for (const [uid, ts] of lastMessageAt) {
        if (ts < cutoff) lastMessageAt.delete(uid);
      }
    }

    res.status(201).json({
      message: {
        id:        saved.id,
        message:   saved.message,
        username:  saved.user.username,
        avatar:    saved.user.avatarEmoji,
        isAdmin:   saved.user.role === 'ADMIN',
        createdAt: saved.createdAt,
      },
    });
  } catch (err) {
    console.error('[CHAT] sendMessage:', err.message);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
};

module.exports = { getMessages, sendMessage };
