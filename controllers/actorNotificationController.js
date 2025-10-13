// controllers/actorNotificationController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ActorNotification = require('../models/actorNotification');

function getActorId(req) {
  return req?.user?._id || req?.user?.id || req?.user?.ActorId || null;
}

/** GET /actor/me/notifications  → { success, data:[...] } */
exports.listMine = asyncHandler(async (req, res) => {
  const actorId = getActorId(req);
  if (!actorId) return res.status(401).json({ message: 'Unauthorized' });

  const docs = await ActorNotification.find({ actorId })
    .sort({ read: 1, priority: -1, createdAt: -1 })
    .lean();

  const data = (docs || []).map(d => ({
    _id: d._id,
    title: d.title || '',
    body: d.body || '',
    link: d.link || null,
    priority: typeof d.priority === 'number' ? d.priority : 0,
    read: !!d.read,
    ts: d.ts || d.createdAt || d.updatedAt || null,
  }));

  res.json({ success: true, data });
});

/** PATCH /actor/me/notifications/:id/ack  → { success, data:{ _id, read:true } } */
exports.ackMine = asyncHandler(async (req, res) => {
const id =
    req.params?.id ||
    req.params?.notificationId ||
    req.body?.id ||
    req.body?._id ||
    req.query?.id ;
  const actorId = getActorId(req);
  // in ackMine
console.log('ACK route hit → params.id =', req.params.id, 'actorId =', getActorId(req));

  if (!actorId) return res.status(401).json({ message: 'Unauthorized' });
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad notification id' });

  const doc = await ActorNotification.findOneAndUpdate(
    { _id: id, actorId },
    { $set: { read: true, readAt: new Date() } },
    { new: true }
  ).lean();

  if (!doc) return res.status(404).json({ message: 'Notification not found' });
  res.json({ success: true, data: { _id: doc._id, read: true } });
});
