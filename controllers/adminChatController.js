// controllers/adminChatController.js
const mongoose  = require('mongoose');
const asyncHdl  = require('express-async-handler');
const jwt       = require('jsonwebtoken');

const ChatRoom  = require('../models/actorChatRoom');
const ChatMsg   = require('../models/actorChatMessage');
const Sanction  = require('../models/actorSanction');
const Notif     = require('../models/actorNotification');
const Upload    = require('../models/actorUpload');

const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const mime      = require('mime-types');

/* =====================================================================
 * Helpers
 * ===================================================================*/
function extractBearer(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : raw;
}
function decodeJWT(token) {
  try {
    const raw = extractBearer(token);
    if (!raw) return null;
    return jwt.verify(raw, process.env.ACCESS_TOKEN_SECRET);
  } catch { return null; }
}
function getAdminIdFromReq(req) {
  // prefer req.user?.ActorId if your auth middleware sets it
  const id = req?.user?.ActorId || req?.user?._id;
  if (id && mongoose.isValidObjectId(id)) return id;
  // fallback: decode from Authorization header
  const payload = decodeJWT(req?.headers?.authorization);
  const fromPayload =
    payload?.ActorId || payload?.UserInfo?.ActorId || payload?.UserInfo?._id || payload?.sub;
  return mongoose.isValidObjectId(fromPayload) ? String(fromPayload) : null;
}

/* =====================================================================
 * 2) UPLOAD FILES (admin) → returns file URLs
 *    POST /admin/chat/rooms/:roomId/files  (FormData files[])
 * ===================================================================*/
const uploadDir = path.join(__dirname, '../uploads/chat');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename:   (_, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'bin';
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + '.' + ext);
  }
});
const uploader = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }).array('files', 10);

module.exports.uploadFiles = [
  uploader,
  asyncHdl(async (req, res) => {
    const { roomId } = req.params;
    if (!mongoose.isValidObjectId(roomId)) return res.status(400).json({ message: 'Bad roomId' });

    const filesMeta = (req.files || []).map(f => ({
      url : `/uploads/chat/${path.basename(f.path)}`,
      mime: f.mimetype,
      size: f.size
    }));

    if (filesMeta.length) {
      await Upload.insertMany(filesMeta.map(m => ({ roomId, actorId: null, ...m })));
    }
    return res.status(201).json({ success: true, data: { files: filesMeta } });
  })
];

/* =====================================================================
 * 1) CREATE OR GET DM ROOM (admin–actor)
 *    POST /admin/chat/room  { aId, bId }
 * ===================================================================*/
module.exports.createRoom = asyncHdl(async (req, res) => {
  const { aId, bId } = req.body || {};
  if (!mongoose.isValidObjectId(aId) || !mongoose.isValidObjectId(bId) || String(aId) === String(bId)) {
    return res.status(400).json({ message: 'Bad aId/bId' });
  }

  let room = await ChatRoom.findOne({
    members: { $all: [aId, bId], $size: 2 },
    isGroup: { $ne: true }
  }).lean();

  if (!room) {
    room = await ChatRoom.create({ members: [aId, bId], isGroup: false });
  }
  return res.status(201).json({ success: true, data: { roomId: room._id } });
});

/* =====================================================================
 * 3) SEND SYSTEM/ADMIN MESSAGE (HTTP)
 *    POST /admin/chat/rooms/:roomId/system   { text, files?[] }
 *    Uses admin ActorId from token as senderId.
 * ===================================================================*/
module.exports.sendSystemMessage = asyncHdl(async (req, res) => {
  const io = req.app.locals.io;
  const adminNs = io?.of('/admin');

  const { roomId } = req.params;
  const { text = '', files = [] } = req.body || {};

  if (!mongoose.isValidObjectId(roomId) || (!text.trim() && !Array.isArray(files))) {
    return res.status(400).json({ message: 'Bad input' });
  }

  const adminId = getAdminIdFromReq(req);
  if (!adminId) return res.status(401).json({ message: 'Unauthorized (no admin ActorId)' });

  const cleanText = text.trim();
  const msg = await ChatMsg.create({
    roomId,
    senderId: adminId,
    text: cleanText ? `[SYSTEM] ${cleanText}` : '',
    files: Array.isArray(files) ? files.filter(Boolean) : [],
    seenBy: []
  });

  // Emit to actors (default ns)
  io.to(String(roomId)).emit('chat:new', {
    roomId,
    msg: { _id: msg._id, senderId: msg.senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt }
  });
  // Emit to admins (admin ns)
  adminNs?.to(String(roomId)).emit('chat:system', {
    roomId,
    msg: { _id: msg._id, senderId: msg.senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt }
  });

  res.status(201).json({ success: true, data: { messageId: msg._id } });
});

/* =====================================================================
 * SOCKETS for ADMIN namespace (/admin)
 *  - extracts admin ActorId from handshake.auth.token (JWT)
 *  - supports acks for admin:joinRoom / admin:system
 * ===================================================================*/
function initAdminChatSockets(app) {
  const io = app.locals.io;
  if (!io) return;

  const ns = io.of('/admin');

  // Per-socket auth: decode token -> set socket.data.adminId
  ns.use((socket, next) => {
    const token = socket.handshake?.auth?.token;
    const payload = decodeJWT(token);
    const id = payload?.ActorId || payload?.UserInfo?.ActorId || payload?.UserInfo?._id || payload?.sub || null;
    socket.data.adminId = (id && mongoose.isValidObjectId(id)) ? String(id) : null;
    if (!socket.data.adminId) {
      console.log('[admin-socket] reject: no admin ActorId in token');
      // You can choose to reject or allow read-only. We'll reject:
      return next(new Error('Unauthorized'));
    }
    next();
  });

  ns.on('connection', (socket) => {
    console.log('[admin-socket] connected', socket.id, 'adminId:', socket.data.adminId);

    socket.on('admin:joinRoom', (roomId, cb) => {
      if (!roomId || !mongoose.isValidObjectId(roomId)) {
        cb && cb({ ok: false, error: 'bad roomId' });
        return;
      }
      socket.join(String(roomId));
      console.log('[admin-socket] join', roomId, 'by', socket.data.adminId);
      cb && cb({ ok: true });
    });

    socket.on('admin:leaveRoom', (roomId, cb) => {
      if (roomId) socket.leave(String(roomId));
      console.log('[admin-socket] leave', roomId, 'by', socket.data.adminId);
      cb && cb({ ok: true });
    });

    socket.on('admin:typing', ({ roomId, isTyping }, cb) => {
      if (!mongoose.isValidObjectId(roomId)) {
        cb && cb({ ok: false, error: 'bad roomId' });
        return;
      }
      socket.to(String(roomId)).emit('chat:typing', { roomId, isTyping: !!isTyping, user: 'admin' });
      cb && cb({ ok: true });
    });

    // Admin sends a message (uses admin id as senderId)
    socket.on('admin:system', async ({ roomId, text = '', files = [] }, cb) => {
      try {
        if (!mongoose.isValidObjectId(roomId)) {
          cb && cb({ ok: false, error: 'bad roomId' });
          return;
        }
        const adminId = socket.data.adminId;
        if (!adminId) {
          cb && cb({ ok: false, error: 'unauthorized' });
          return;
        }
        const cleanText = String(text || '').trim();
        if (!cleanText && !Array.isArray(files)) {
          cb && cb({ ok: false, error: 'empty' });
          return;
        }

        const msg = await ChatMsg.create({
          roomId,
          senderId: adminId,
          text: cleanText ? `[SYSTEM] ${cleanText}` : '',
          files: Array.isArray(files) ? files.filter(Boolean) : [],
          seenBy: []
        });

        // broadcast to default ns (actors) and admin ns
        io.to(String(roomId)).emit('chat:new', {
          roomId,
          msg: { _id: msg._id, senderId: msg.senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt }
        });
        ns.to(String(roomId)).emit('chat:system', {
          roomId,
          msg: { _id: msg._id, senderId: msg.senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt }
        });

        cb && cb({ ok: true, id: String(msg._id) });
      } catch (e) {
        console.error('[admin:system] err', e);
        cb && cb({ ok: false, error: 'server' });
      }
    });

    socket.on('disconnect', () => {
      console.log('[admin-socket] disconnected', socket.id);
    });
  });
}
module.exports.initAdminChatSockets = initAdminChatSockets;

/* =====================================================================
 * GUARD: prevent muted/banned actors from sending (actor side)
 * Add BEFORE sendChatMessage in ActorRoutes:
 * router.post('/actor/chat/:roomId', protect, chatSanctionGuard, chatBlockGuard, sendChatMessage)
 * ===================================================================*/
module.exports.chatSanctionGuard = asyncHdl(async (req, res, next) => {
  const userId = req.user?._id;
  const { roomId } = req.params || {};
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const now = new Date();
  const sanctions = await Sanction.find({
    actorId: userId,
    $and: [
      { $or: [{ scopeGlobal: true }, { roomId: mongoose.isValidObjectId(roomId) ? roomId : null }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }
    ]
  }).lean();

  const banned = sanctions.some(s => s.type === 'ban');
  const muted  = sanctions.some(s => s.type === 'mute');
  if (banned) return res.status(403).json({ message: 'You are banned from chat.' });
  if (muted)  return res.status(403).json({ message: 'You are muted in this room.' });
  next();
});

/* =====================================================================
 * LIST ROOMS (admin)
 * GET /admin/chat/rooms?member=<actorId>&limit=20&before=<roomId>
 * ===================================================================*/
module.exports.listRooms = asyncHdl(async (req, res) => {
  const { member, limit = 20, before } = req.query;
  const q = {};
  if (member && mongoose.isValidObjectId(member)) q.members = mongoose.Types.ObjectId.createFromHexString(String(member));
  if (before && mongoose.isValidObjectId(before)) q._id = { $lt: before };

  const rows = await ChatRoom.find(q)
    .sort({ _id: -1 })
    .limit(Math.min(100, Number(limit) || 20))
    .lean();

  res.json({ success: true, count: rows.length, data: rows });
});

/* =====================================================================
 * ROOM INFO (members, last message)
 * GET /admin/chat/rooms/:roomId
 * ===================================================================*/
module.exports.roomInfo = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  if (!mongoose.isValidObjectId(roomId)) return res.status(400).json({ message: 'Bad roomId' });

  const room = await ChatRoom.findById(roomId).lean();
  if (!room) return res.status(404).json({ message: 'Room not found' });

  const last = await ChatMsg.findOne({ roomId }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: { ...room, lastMessage: last || null } });
});

/* =====================================================================
 * LIST MESSAGES (admin)
 * GET /admin/chat/rooms/:roomId/messages?before=<msgId>&limit=50
 * ===================================================================*/
module.exports.listMessages = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { before, limit = 50 } = req.query;
  if (!mongoose.isValidObjectId(roomId)) return res.status(400).json({ message: 'Bad roomId' });

  const q = { roomId };
  if (before && mongoose.isValidObjectId(before)) q._id = { $lt: before };

  const rows = await ChatMsg.find(q)
    .sort({ _id: -1 })
    .limit(Math.min(200, Number(limit) || 50))
    .lean();

  res.json({ success: true, count: rows.length, data: rows.reverse() });
});

/* =====================================================================
 * DELETE MESSAGE (admin)
 * DELETE /admin/chat/messages/:msgId   body { reason? }
 * ===================================================================*/
module.exports.deleteMessageAdmin = asyncHdl(async (req, res) => {
  const io = req.app.locals.io;
  const ns = io.of('/admin');

  const { msgId } = req.params;
  const { reason } = req.body || {};
  if (!mongoose.isValidObjectId(msgId)) return res.status(400).json({ message: 'Bad msgId' });

  const msg = await ChatMsg.findById(msgId);
  if (!msg) return res.status(404).json({ message: 'Message not found' });

  await ChatMsg.deleteOne({ _id: msgId });

  io.to(String(msg.roomId)).emit('chat:deleted', { msgId, reason: reason || null, by: 'admin' });
  ns.to(String(msg.roomId)).emit('chat:deleted', { msgId, reason: reason || null, by: 'admin' });

  res.json({ success: true });
});

/* =====================================================================
 * SANCTIONS: MUTE / UNMUTE / BAN / UNBAN
 * POST /admin/chat/rooms/:roomId/mute   { actorId, minutes?, reason? }
 * POST /admin/chat/mute-global          { actorId, minutes?, reason? }
 * POST /admin/chat/rooms/:roomId/ban    { actorId, minutes?, reason? }
 * POST /admin/chat/ban-global           { actorId, minutes?, reason? }
 * DELETE /admin/chat/sanctions/:id
 * ===================================================================*/
const calcExpiry = (minutes) => {
  if (!minutes || Number(minutes) <= 0) return null;
  const ms = Number(minutes) * 60 * 1000;
  return new Date(Date.now() + ms);
};

module.exports.muteInRoom = asyncHdl(async (req, res) => {
  const ns = req.app.locals.io.of('/admin');
  const { roomId } = req.params;
  const { actorId, minutes, reason } = req.body || {};
  if (!mongoose.isValidObjectId(roomId) || !mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: 'Bad ids' });

  const s = await Sanction.create({
    actorId, type: 'mute', scopeGlobal: false, roomId,
    reason: reason || '', expiresAt: calcExpiry(minutes), createdBy: req.user?._id || null
  });

  ns.to(String(roomId)).emit('admin:sanction', { roomId, actorId, type: 'mute' });
  res.status(201).json({ success: true, data: s });
});

module.exports.muteGlobal = asyncHdl(async (req, res) => {
  const { actorId, minutes, reason } = req.body || {};
  if (!mongoose.isValidObjectId(actorId)) return res.status(400).json({ message: 'Bad actorId' });

  const s = await Sanction.create({
    actorId, type: 'mute', scopeGlobal: true, roomId: null,
    reason: reason || '', expiresAt: calcExpiry(minutes), createdBy: req.user?._id || null
  });

  res.status(201).json({ success: true, data: s });
});

module.exports.banInRoom = asyncHdl(async (req, res) => {
  const ns = req.app.locals.io.of('/admin');
  const { roomId } = req.params;
  const { actorId, minutes, reason } = req.body || {};
  if (!mongoose.isValidObjectId(roomId) || !mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: 'Bad ids' });

  const s = await Sanction.create({
    actorId, type: 'ban', scopeGlobal: false, roomId,
    reason: reason || '', expiresAt: calcExpiry(minutes), createdBy: req.user?._id || null
  });

  ns.to(String(roomId)).emit('admin:sanction', { roomId, actorId, type: 'ban' });
  res.status(201).json({ success: true, data: s });
});

module.exports.banGlobal = asyncHdl(async (req, res) => {
  const { actorId, minutes, reason } = req.body || {};
  if (!mongoose.isValidObjectId(actorId)) return res.status(400).json({ message: 'Bad actorId' });

  const s = await Sanction.create({
    actorId, type: 'ban', scopeGlobal: true, roomId: null,
    reason: reason || '', expiresAt: calcExpiry(minutes), createdBy: req.user?._id || null
  });

  res.status(201).json({ success: true, data: s });
});

module.exports.removeSanction = asyncHdl(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad id' });

  await Sanction.deleteOne({ _id: id });
  res.json({ success: true });
});

/* =====================================================================
 * KICK a member from a GROUP (admin)
 * POST /admin/chat/rooms/:roomId/kick  { actorId }
 * ===================================================================*/
module.exports.kickFromRoom = asyncHdl(async (req, res) => {
  const ns = req.app.locals.io.of('/admin');
  const { roomId } = req.params;
  const { actorId } = req.body || {};
  if (!mongoose.isValidObjectId(roomId) || !mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: 'Bad ids' });

  const room = await ChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!room.isGroup) return res.status(409).json({ message: 'Cannot kick from DM' });

  await ChatRoom.updateOne({ _id: roomId }, { $pull: { members: actorId } });
  ns.to(String(roomId)).emit('admin:kicked', { roomId, actorId });
  res.json({ success: true });
});

/* =====================================================================
 * SEARCH across all messages (admin)
 * GET /admin/chat/search?q=&limit=50
 * ===================================================================*/
module.exports.searchMessages = asyncHdl(async (req, res) => {
  const { q = '', limit = 50 } = req.query;
  if (q.trim().length < 2) return res.status(400).json({ message: 'Query too short' });

  let rows = await ChatMsg.find(
    { $text: { $search: q } },
    { score: { $meta: 'textScore' } }
  )
  .sort({ score: { $meta: 'textScore' } })
  .limit(Math.min(200, Number(limit) || 50))
  .lean();

  if (!rows.length) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rows = await ChatMsg.find({ text: rx })
      .sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 50)).lean();
  }
  res.json({ success: true, count: rows.length, data: rows });
});

/* =====================================================================
 * EXPORT transcript (admin)
 * GET /admin/chat/rooms/:roomId/transcript?format=txt|json
 * ===================================================================*/
module.exports.exportTranscript = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { format = 'txt' } = req.query;
  if (!mongoose.isValidObjectId(roomId)) return res.status(400).json({ message: 'Bad roomId' });

  const msgs = await ChatMsg.find({ roomId }).sort({ createdAt: 1 }).lean();
  if (format === 'json') {
    return res.json({ success: true, data: msgs });
  }
  const lines = msgs.map(m =>
    `[${new Date(m.createdAt).toISOString()}] ${m.senderId ? m.senderId.toString() : 'SYSTEM'}: ${m.text || ''}`
  ).join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines);
});

/* =====================================================================
 * BROADCAST notification
 * POST /admin/chat/broadcast  { title, body, actorIds?[], roles?[], eventId? }
 * ===================================================================*/
const Attendee  = require('../models/attendee');
const Exhibitor = require('../models/exhibitor');
const Speaker   = require('../models/speaker');

module.exports.broadcast = asyncHdl(async (req, res) => {
  const { title, body, actorIds, roles, eventId } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ message: 'title & body required' });

  let targets = [];
  if (Array.isArray(actorIds) && actorIds.length) {
    targets = actorIds
      .filter(id => mongoose.isValidObjectId(id))
      .map(id => mongoose.Types.ObjectId.createFromHexString(String(id)));
  } else if (Array.isArray(roles) && roles.length) {
    const filters = (eventId && mongoose.isValidObjectId(eventId)) ? { id_event: eventId } : {};
    const pulls = [];
    if (roles.includes('attendee'))  pulls.push(Attendee.find(filters).select('_id').lean());
    if (roles.includes('exhibitor')) pulls.push(Exhibitor.find(filters).select('_id').lean());
    if (roles.includes('speaker'))   pulls.push(Speaker.find(filters).select('_id').lean());
    const sets = await Promise.all(pulls);
    targets = sets.flat().map(r => r._id);
  } else {
    return res.status(400).json({ message: 'Provide actorIds or roles' });
  }

  if (!targets.length) return res.status(404).json({ message: 'No targets' });

  const docs = targets.map(id => ({
    actorId: id, title: title.trim(), body: body.trim(), link: '', read: false, createdAt: new Date()
  }));
  await Notif.insertMany(docs);

  try {
    const ns = req.app.locals.io.of('/admin');
    targets.forEach(id => ns.to(String(id)).emit('admin:broadcast', { title, body }));
  } catch (_) {}

  res.json({ success: true, sent: targets.length });
});
