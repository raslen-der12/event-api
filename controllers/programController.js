// controllers/programController.js
const mongoose = require('mongoose');
const asyncHdl = require('express-async-handler');
const Schedule = require('../models/eventModels/schedule');
const Room     = require('../models/programRoom');
const Reg      = require('../models/sessionRegistration');

const isId = (id) => mongoose.isValidObjectId(id);

// ───────────────────────── Helpers ─────────────────────────
function overlaps(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || aStart >= bEnd);
}

async function hasTimeConflict({ actorId, eventId, start, end, excludeSessionId=null }) {
  const regs = await Reg.find({ actorId, eventId, status: 'registered' })
                        .select('sessionId').lean();
  if (!regs.length) return false;
  const sess = await Schedule.find({ _id: { $in: regs.map(r => r.sessionId) } })
                             .select('_id startTime endTime').lean();
  return sess.some(s => String(s._id) !== String(excludeSessionId || '') &&
                        overlaps(start, end, s.startTime, s.endTime));
}

// ───────────────────────── Rooms (admin) ─────────────────────────
exports.createRoom = asyncHdl(async (req, res) => {
  const { id_event, name, location='', capacity=0 } = req.body || {};
  if (!isId(id_event) || !name?.trim()) return res.status(400).json({ message: 'id_event & name required' });
  const room = await Room.create({ id_event, name: name.trim(), location: location.trim(), capacity: Number(capacity)||0 });
  res.status(201).json({ success: true, data: room });
});

exports.listRooms = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  if (!isId(eventId)) return res.status(400).json({ message: 'Bad eventId' });
  const rows = await Room.find({ id_event: eventId }).sort({ name: 1 }).lean();
  res.json({ success: true, data: rows });
});

// ───────────────────────── Sessions (admin) ───────────────────────
exports.createSession = asyncHdl(async (req, res) => {
  const data = req.body || {};
  if (!isId(data.id_event)) return res.status(400).json({ message: 'id_event required' });
  if (!data.sessionTitle?.trim()) return res.status(400).json({ message: 'sessionTitle required' });
  if (!data.startTime || !data.endTime) return res.status(400).json({ message: 'startTime & endTime required' });

  const s = await Schedule.create({
    ...data,
    sessionTitle: data.sessionTitle.trim(),
    track: (data.track || '').trim(),
    room: (data.room || '').trim()
  });
  res.status(201).json({ success: true, data: s });
});

exports.updateSession = asyncHdl(async (req, res) => {
  const { sessionId } = req.params;
  if (!isId(sessionId)) return res.status(400).json({ message: 'Bad sessionId' });
  const patch = { ...req.body, updatedAt: new Date() };
  const s = await Schedule.findByIdAndUpdate(sessionId, patch, { new: true, runValidators: true }).lean();
  if (!s) return res.status(404).json({ message: 'Not found' });
  res.json({ success: true, data: s });
});

exports.deleteSession = asyncHdl(async (req, res) => {
  const { sessionId } = req.params;
  if (!isId(sessionId)) return res.status(400).json({ message: 'Bad sessionId' });
  await Schedule.deleteOne({ _id: sessionId });
  await Reg.updateMany({ sessionId }, { $set: { status: 'cancelled' } });
  res.json({ success: true });
});

// ───────────────────────── Program listing (grid) ─────────────────
/**
 * GET /program/events/:eventId/sessions?day=YYYY-MM-DD&roomId=&track=&includeCounts=1
 * Returns flat array plus optional {counts:{[sessionId]:{registered,waitlisted}}}
 */
exports.listSessions = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  let { day, roomId, track, includeCounts } = req.query;
  if (!isId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  const q = { id_event: eventId };
  if (roomId && isId(roomId)) q.roomId = roomId;
  if (track?.trim()) q.track = track.trim();
  if (day) {
    const start = new Date(day + 'T00:00:00.000Z');
    const end   = new Date(day + 'T23:59:59.999Z');
    q.startTime = { $gte: start, $lte: end };
  }

  const rows = await Schedule.find(q).sort({ startTime: 1 }).lean();

  let counts = {};
  if (String(includeCounts) === '1' && rows.length) {
    const ids = rows.map(r => r._id);
    const agg = await Reg.aggregate([
      { $match: { sessionId: { $in: ids }, status: { $in: ['registered','waitlisted'] } } },
      { $group: { _id: { sessionId: '$sessionId', status: '$status' }, n: { $sum: 1 } } }
    ]);
    agg.forEach(a => {
      const sid = String(a._id.sessionId);
      counts[sid] = counts[sid] || { registered: 0, waitlisted: 0 };
      counts[sid][a._id.status] = a.n;
    });
  }

  res.json({ success: true, data: rows, counts });
});
// utils
const escapeRegExp = (s='') => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sessions (register view)
exports.listSessionsRegister = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  let { day, roomId, track, includeCounts } = req.query;

  if (!isId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  // Base match
  const match = { id_event: new mongoose.Types.ObjectId(eventId) };

  if (roomId && isId(roomId)) {
    match.roomId = new mongoose.Types.ObjectId(roomId);
  }

  if (track && String(track).trim()) {
    // case-insensitive exact match to avoid “AI” matching “AIsomething”
    match.track = { $regex: `^${escapeRegExp(String(track).trim())}$`, $options: 'i' };
  }

  if (day) {
    // day is UTC YYYY-MM-DD
    const start = new Date(`${day}T00:00:00.000Z`);
    const end   = new Date(`${day}T23:59:59.999Z`);
    match.startTime = { $gte: start, $lte: end };
  }

  const pipeline = [
    { $match: match },
    { $sort: { startTime: 1 } },
    {
      $lookup: {
        from: 'programrooms',
        localField: 'roomId',
        foreignField: '_id',
        as: 'roomDoc'
      }
    },
    { $addFields: { roomDoc: { $first: '$roomDoc' } } },
    {
      $project: {
        _id: 1,
        // normalized fields for UI
        title: { $ifNull: ['$sessionTitle', ''] },
        description: { $ifNull: ['$description', ''] },
        startAt: '$startTime',
        endAt: '$endTime',
        cover: { $ifNull: ['$coverImage', ''] },
        track: { $ifNull: ['$track', ''] },
        tags: { $ifNull: ['$tags', []] },
        speakers: { $ifNull: ['$speakers', []] },
        // embedded minimal room
        room: {
          _id: '$roomId',
          name: { $ifNull: ['$roomDoc.name', null] },
          location: { $ifNull: ['$roomDoc.location', null] },
          capacity: { $ifNull: ['$roomDoc.capacity', 0] }
        }
      }
    }
  ];

  const rows = await Schedule.aggregate(pipeline);

  let counts = {};
  const needCounts = (includeCounts === '1' || includeCounts === 1 || includeCounts === true || includeCounts === 'true');
  if (needCounts && rows.length) {
    const ids = rows.map(r => r._id);
    const agg = await Reg.aggregate([
      { $match: { sessionId: { $in: ids }, status: { $in: ['registered','waitlisted'] } } },
      { $group: { _id: { sessionId: '$sessionId', status: '$status' }, n: { $sum: 1 } } }
    ]);
    agg.forEach(a => {
      const sid = String(a._id.sessionId);
      if (!counts[sid]) counts[sid] = { registered: 0, waitlisted: 0 };
      counts[sid][a._id.status] = a.n;
    });
  }

  return res.json({ success: true, data: rows, counts });
});


// Rooms (for filter select)
exports.listRoomsRegister = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  if (!isId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  // keep it minimal and consistent
  const rows = await Room.find({ id_event: eventId })
    .select({ _id: 1, name: 1, location: 1, capacity: 1 })
    .sort({ name: 1 })
    .lean();

  return res.json({ success: true, data: rows });
});

// ───────────────────────── Actor signup / cancel ──────────────────
/**
 * POST   /program/sessions/:sessionId/signup   { waitlistOk?: boolean }
 * DELETE /program/sessions/:sessionId/signup
 */
exports.signup = asyncHdl(async (req, res) => {
  const { sessionId } = req.params;
  const { waitlistOk = true } = req.body || {};
  if (!isId(sessionId)) return res.status(400).json({ message: 'Bad sessionId' });

  const meId   = req.user?._id;
  const myRole = (req.user?.role || '').toLowerCase();
  if (!isId(meId)) return res.status(401).json({ message: 'Unauthorized' });

  const s = await Schedule.findById(sessionId).lean();
  if (!s) return res.status(404).json({ message: 'Session not found' });
  // if (!s.allowRegistration) return res.status(403).json({ message: 'Registration closed for this session' });
  // if (Array.isArray(s.allowedRoles) && s.allowedRoles.length && !s.allowedRoles.includes(myRole)) {
  //   return res.status(403).json({ message: 'Your role is not allowed to register for this session' });
  // }

  // const now = new Date();
  // if (s.registrationOpenAt && now < new Date(s.registrationOpenAt)) {
  //   return res.status(403).json({ message: 'Registration has not opened yet' });
  // }
  // if (s.registrationCloseAt && now > new Date(s.registrationCloseAt)) {
  //   return res.status(403).json({ message: 'Registration window has closed' });
  // }

  // conflict check
  if (await hasTimeConflict({ actorId: meId, eventId: s.id_event, start: s.startTime, end: s.endTime, excludeSessionId: s._id })) {
    return res.status(409).json({ message: 'Time conflict with another registered session' });
  }

  // capacity & status
  let status = 'registered';
  if (s.capacity && s.capacity > 0) {
    const count = await Reg.countDocuments({ sessionId: s._id, status: 'registered' });
    if (count >= s.capacity) status = waitlistOk ? 'waitlisted' : null;
  }
  if (!status) return res.status(409).json({ message: 'Session is full' });

  const doc = await Reg.findOneAndUpdate(
    { sessionId: s._id, actorId: meId },
    {
      $setOnInsert: {
        eventId: s.id_event,
        actorRole: myRole,
        createdAt: new Date()
      },
      $set: { status }
    },
    { new: true, upsert: true }
  ).lean();

  res.status(201).json({ success: true, data: { status: doc.status } });
});

exports.cancelSignup = asyncHdl(async (req, res) => {
  const { sessionId } = req.params;
  if (!isId(sessionId)) return res.status(400).json({ message: 'Bad sessionId' });

  const meId = req.user?._id;
  if (!isId(meId)) return res.status(401).json({ message: 'Unauthorized' });

  const reg = await Reg.findOneAndUpdate(
    { sessionId, actorId: meId, status: { $in: ['registered','waitlisted'] } },
    { $set: { status: 'cancelled' } },
    { new: true }
  ).lean();

  if (!reg) return res.status(404).json({ message: 'No active signup to cancel' });

  // Promote first waitlisted (if any) to registered
  const next = await Reg.findOneAndUpdate(
    { sessionId, status: 'waitlisted' },
    { $set: { status: 'registered' } },
    { sort: { createdAt: 1 }, new: true }
  ).lean();

  res.json({ success: true, promoted: !!next });
});

// ───────────────────────── My schedule (actor) ────────────────────
/**
 * GET /program/mine?eventId=
 */
exports.mySchedule = asyncHdl(async (req, res) => {
  const meId = req.user?._id;
  if (!isId(meId)) return res.status(401).json({ message: 'Unauthorized' });

  const { eventId } = req.query;

  // build query safely
  const q = { actorId: meId };
  if (eventId && isId(eventId)) q.eventId = eventId;

  // exclude cancelled (optional)
  q.status = { $ne: 'cancelled' };

  const regs = await Reg.find(q).lean();
  const sessionIds = regs.map(r => r.sessionId).filter(Boolean);
  const sessions = sessionIds.length
    ? await Schedule.find({ _id: { $in: sessionIds } }).lean()
    : [];

  const byId = Object.fromEntries(sessions.map(s => [ String(s._id), s ]));
  const rows = regs
    .map(r => ({ status: r.status, session: byId[String(r.sessionId)] }))
    .filter(x => x.session);

  res.json({ success: true, data: rows });
});

