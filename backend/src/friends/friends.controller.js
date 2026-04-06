// friends/friends.controller.js
// Sistema de amigos — buscar, solicitar, aceptar, listar

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Buscar usuarios por username o email ──────────────────────────────────
const searchUsers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Mínimo 2 caracteres para buscar' });
    }

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: req.user.id } },
          { isBanned: false },
          {
            OR: [
              { username: { contains: q.toLowerCase(), mode: 'insensitive' } },
              { email:    { contains: q.toLowerCase(), mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 10,
      select: {
        id: true,
        username: true,
        avatarEmoji: true,
        createdAt: true,
      },
    });

    // Agrega estado de relación para cada resultado
    const myId = req.user.id;
    const withStatus = await Promise.all(users.map(async (u) => {
      const friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { requesterId: myId, addresseeId: u.id },
            { requesterId: u.id, addresseeId: myId },
          ],
        },
      });

      let relationStatus = 'none';
      if (friendship) {
        if (friendship.status === 'ACCEPTED') relationStatus = 'friends';
        else if (friendship.status === 'PENDING') {
          relationStatus = friendship.requesterId === myId ? 'pending_sent' : 'pending_received';
        } else if (friendship.status === 'BLOCKED') {
          relationStatus = 'blocked';
        }
      }

      return { ...u, relationStatus, friendshipId: friendship?.id || null };
    }));

    res.json({ users: withStatus });
  } catch (err) {
    console.error('[FRIENDS] searchUsers:', err);
    res.status(500).json({ error: 'Error al buscar usuarios' });
  }
};

// ── Enviar solicitud de amistad ───────────────────────────────────────────
const sendRequest = async (req, res) => {
  try {
    const { addresseeId } = req.body;
    const requesterId = req.user.id;

    if (requesterId === addresseeId) {
      return res.status(400).json({ error: 'No podés mandarte solicitud a vos mismo' });
    }

    // Verifica que el destinatario existe
    const addressee = await prisma.user.findUnique({
      where: { id: addresseeId },
      select: { id: true, username: true, isBanned: true },
    });

    if (!addressee || addressee.isBanned) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Verifica que no exista ya una relación
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId },
          { requesterId: addresseeId, addresseeId: requesterId },
        ],
      },
    });

    if (existing) {
      const msgs = {
        ACCEPTED: 'Ya son amigos',
        PENDING:  'Ya existe una solicitud pendiente',
        BLOCKED:  'No se puede enviar solicitud',
      };
      return res.status(409).json({ error: msgs[existing.status] || 'Ya existe una relación' });
    }

    // Crea la solicitud
    const friendship = await prisma.friendship.create({
      data: { requesterId, addresseeId, status: 'PENDING' },
    });

    // Notifica al destinatario
    await prisma.notification.create({
      data: {
        userId:  addresseeId,
        type:    'FRIEND_REQUEST',
        title:   'Nueva solicitud de amistad',
        message: `${req.user.username} quiere ser tu amigo`,
        data:    { friendshipId: friendship.id, requesterId, username: req.user.username },
      },
    });

    res.status(201).json({ message: `Solicitud enviada a ${addressee.username}`, friendship });
  } catch (err) {
    console.error('[FRIENDS] sendRequest:', err);
    res.status(500).json({ error: 'Error al enviar solicitud' });
  }
};

// ── Responder solicitud (aceptar o rechazar) ──────────────────────────────
const respondRequest = async (req, res) => {
  try {
    const { friendshipId, action } = req.body;

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción: accept o reject' });
    }

    const friendship = await prisma.friendship.findUnique({
      where: { id: friendshipId },
      include: { requester: { select: { id: true, username: true } } },
    });

    if (!friendship) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (friendship.addresseeId !== req.user.id) {
      return res.status(403).json({ error: 'No es tu solicitud' });
    }
    if (friendship.status !== 'PENDING') {
      return res.status(400).json({ error: 'Solicitud ya procesada' });
    }

    if (action === 'accept') {
      await prisma.friendship.update({
        where: { id: friendshipId },
        data:  { status: 'ACCEPTED' },
      });

      // Notifica al que envió la solicitud
      await prisma.notification.create({
        data: {
          userId:  friendship.requesterId,
          type:    'FRIEND_ACCEPTED',
          title:   'Solicitud aceptada',
          message: `${req.user.username} aceptó tu solicitud de amistad`,
          data:    { friendshipId, username: req.user.username },
        },
      });

      res.json({ message: `Ahora sos amigo de ${friendship.requester.username}` });
    } else {
      // Rechazar → borra la solicitud
      await prisma.friendship.delete({ where: { id: friendshipId } });
      res.json({ message: 'Solicitud rechazada' });
    }
  } catch (err) {
    console.error('[FRIENDS] respondRequest:', err);
    res.status(500).json({ error: 'Error al responder solicitud' });
  }
};

// ── Lista de amigos ───────────────────────────────────────────────────────
const getFriends = async (req, res) => {
  try {
    const userId = req.user.id;

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: { id: true, username: true, avatarEmoji: true } },
        addressee: { select: { id: true, username: true, avatarEmoji: true } },
      },
    });

    // Devuelve el amigo (no el usuario actual)
    const friends = friendships.map(f => ({
      friendshipId: f.id,
      friend: f.requesterId === userId ? f.addressee : f.requester,
      since: f.updatedAt,
    }));

    res.json({ friends });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener amigos' });
  }
};

// ── Solicitudes pendientes recibidas ──────────────────────────────────────
const getPendingRequests = async (req, res) => {
  try {
    const requests = await prisma.friendship.findMany({
      where: { addresseeId: req.user.id, status: 'PENDING' },
      include: {
        requester: { select: { id: true, username: true, avatarEmoji: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener solicitudes' });
  }
};

// ── Eliminar amigo ────────────────────────────────────────────────────────
const removeFriend = async (req, res) => {
  try {
    const { friendshipId } = req.body;
    const userId = req.user.id;

    const friendship = await prisma.friendship.findUnique({
      where: { id: friendshipId },
    });

    if (!friendship) return res.status(404).json({ error: 'Amistad no encontrada' });
    if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
      return res.status(403).json({ error: 'No tenés permiso' });
    }

    await prisma.friendship.delete({ where: { id: friendshipId } });
    res.json({ message: 'Amigo eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar amigo' });
  }
};

module.exports = { searchUsers, sendRequest, respondRequest, getFriends, getPendingRequests, removeFriend };
