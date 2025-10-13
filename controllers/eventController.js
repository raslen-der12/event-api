/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 1 / N) ────────────────────────────────────────────────────────────────
 *
 *  This section provides everything that must live at the *top* of the controller file:
 *     • Imports & common constants
 *     • A small toolbox of reusable helpers (ID casting, pagination, safe JSON).
 *     • A Redis-aware in-memory cache wrapper (can be disabled if no Redis client is injected).
 *     • PUBLIC endpoint **getEventFull()**  ➜  returns one huge JSON blob that drives the
 *       public-facing event page (hero, impacts, organisers, gallery, schedule, etc.).
 *       • Only VERIFIED comments are included.
 *       • Gallery capped to the 24 most-recent assets.
 *       • Everything fetched in parallel with lean() for max read speed.
 *
 *  Subsequent parts (2…N) will add:
 *     • Admin dashboard stats
 *     • CRUD endpoints for each child collection
 *     • Comment moderation, bill/ticket lists, refunds, etc.
 **************************************************************************************************/

/* ──────────────────────────────────────────────────────────────────────────────
 *  ⛓️  Imports
 * ─────────────────────────────────────────────────────────────────────────── */
require('dotenv').config({ path: '../.env' });
const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const deepmerge    = require('deepmerge');
const { cleanupFile } = require('../middleware/uploader'); // ⬅️ add
const path        = require('path'); // ⬅️ add

/* Core + child models */
const Event       = require('../models/event');
const Organizer   = require('../models/eventModels/organizer');
const Impact      = require('../models/eventModels/impact');
const Feature     = require('../models/eventModels/feature');
const Gallery     = require('../models/eventModels/gallery');
const Schedule    = require('../models/eventModels/schedule');
const Comment     = require('../models/eventModels/comment');
const EventBill = require('../models/eventModels/bill'); // or the correct path
const EventTicket = require('../models/eventModels/ticket');

/* Optionally inject a Redis client in server.js and attach to app.locals.redis */
let redis;   // (will be set in initCacheWrapper)

/* ──────────────────────────────────────────────────────────────────────────────
 *  🧰  Shared helper utilities
 * ─────────────────────────────────────────────────────────────────────────── */

/** Safe ObjectId casting  */
const toId = (id) => mongoose.Types.ObjectId.createFromHexString(id);

/** Quick & safe JSON.parse (returns null on failure) */
const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Simple paginated query builder  */
const buildPage = (arr, page = 1, limit = 20) =>
  arr.slice((page - 1) * limit, page * limit);

/* ──────────────────────────────────────────────────────────────────────────────
 *  💾  Tiny cache wrapper (10 min TTL per key)
 *      If no Redis passed, functions become no-ops.
 * ─────────────────────────────────────────────────────────────────────────── */
const CACHE_TTL = 600;                // 10 min

function initCacheWrapper(app) {
  redis = app?.locals?.redis || null;
}

async function cacheGet(key) {
  if (!redis) return null;
  const data = await redis.get(key);
  return tryParse(data);
}

async function cacheSet(key, json) {
  if (!redis) return;
  await redis.setEx(key, CACHE_TTL, JSON.stringify(json));
}

const { isValidObjectId } = mongoose;

/* ───────────────── helpers ───────────────── */
const COLL = Object.freeze({
  feature:   Feature,
  impact:    Impact,
  organizer: Organizer,
  comment:   Comment,
  gallery:   Gallery,
  schedule:  Schedule
});
const COLLECTION_KEYS = Object.keys(COLL);

const REQUIRED = Object.freeze({
  feature:   d => !!d?.title && !!d?.desc,
  impact:    d => !!d?.title && !!d?.description,
  organizer: d => !!d?.logo,
  comment:   d => !!d?.text && !!d?.id_actor && !!d?.actorModel, // enum in your model
  gallery:   d => !!d?.file,
  schedule:  d => !!d?.sessionTitle && !!d?.startTime && !!d?.endTime
});

const normActor = s => (s === 'attender' ? 'attendee' : s);
const sanitizeUpdate = (o) => { const x = { ...(o||{}) }; delete x.id; delete x._id; delete x.id_event; return x; };
const isHttpUrl = s => /^https?:\/\/.+/i.test(String(s||''));

/* pick exactly one collection object from body (e.g., { feature: {...} }) */
function pickCollectionObject(body) {
  const found = COLLECTION_KEYS.filter(k => body && typeof body[k] === 'object' && body[k] !== null);
  if (found.length === 0) return null;
  if (found.length > 1)   return { error: 'Provide only one collection object at a time', name: null, obj: null };
  const name = found[0];
  return { name, obj: body[name] };
}

function mapDbErr(err, res, fallback='Operation failed') {
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    return res.status(409).json({ message: `${field} must be unique` });
  }
  if (err?.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return res.status(400).json({ message: first?.message || 'Validation error' });
  }
  if (err?.name === 'CastError') return res.status(400).json({ message: `Bad ${err.path}` });
  return res.status(500).json({ message: fallback });
}

/* validate event payload (create or update) against timing & simple formats */
async function validateEventPayloadForUpdate(eventId, patch) {
  const ev = await Event.findById(eventId).lean();
  if (!ev) return { ok:false, msg:'Event not found' };

  const start = patch.startDate ? new Date(patch.startDate) : new Date(ev.startDate);
  const end   = patch.endDate   ? new Date(patch.endDate)   : new Date(ev.endDate);
  if (!(end > start)) return { ok:false, msg:'endDate must be after startDate' };

  if (patch.registrationDeadline) {
    const rd = new Date(patch.registrationDeadline);
    if (!(rd < start)) return { ok:false, msg:'registrationDeadline must be before startDate' };
  }
  if (patch.capacity != null && (!Number.isInteger(patch.capacity) || patch.capacity < 1))
    return { ok:false, msg:'capacity must be a positive integer' };

  if (patch.mapLink && !isHttpUrl(patch.mapLink)) return { ok:false, msg:'mapLink must be http(s) URL' };

  return { ok:true };
}

// ───────────────────────── helpers for multipart + coercion ─────────────────────────
const isPlainObject = v => v && typeof v === 'object' && !Array.isArray(v);

// inflate keys like "feature[title]" => { feature: { title: "..." } }
function inflateBrackets(flat = {}) {
  const nested = {};
  for (const [key, val] of Object.entries(flat)) {
    if (!key.includes('[')) continue;
    const parts = key.replace(/\]/g, '').split('[');
    const root = parts.shift();
    nested[root] = nested[root] || {};
    let cur = nested[root];
    while (parts.length > 1) {
      const p = parts.shift();
      cur[p] = cur[p] || {};
      cur = cur[p];
    }
    cur[parts[0]] = val;
  }
  return nested;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null || v === '') return v;
  const s = String(v).toLowerCase();
  if (['true','1','yes','on'].includes(s)) return true;
  if (['false','0','no','off'].includes(s)) return false;
  return v;
}
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}
function toDateVal(v) {
  if (v instanceof Date) return v;
  if (v == null || v === '') return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d;
}
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    // try JSON array first
    try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed; } catch {}
    // comma-separated fallback
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [v];
}

// Coerce event root fields
function coerceEventPatch(patch) {
  const p = { ...(patch || {}) };
  ['isPublished','isCancelled'].forEach(k => k in p && (p[k] = toBool(p[k])));
  ['capacity','seatsTaken'].forEach(k => k in p && (p[k] = toNum(p[k])));
  ['startDate','endDate','registrationDeadline'].forEach(k => k in p && (p[k] = toDateVal(p[k])));
  return p;
}

// Coerce collection-specific fields
function coerceCollectionInput(name, obj) {
  const o = { ...(obj || {}) };
  if (name === 'schedule') {
    if ('startTime' in o) o.startTime = toDateVal(o.startTime);
    if ('endTime'   in o) o.endTime   = toDateVal(o.endTime);
    if ('day'       in o) o.day       = toDateVal(o.day);
  }
  if (name === 'comment') {
    if ('verified' in o) o.verified = toBool(o.verified);
  }
  // Normalize common array-ish fields if ever sent as CSV/JSON (safe no-ops otherwise)
  ['tags','regions','matchPrefs','targetSectors','partnerTypes','preferredLanguages'].forEach(k => {
    if (k in o) o[k] = toArray(o[k]);
  });
  return o;
}

// Normalize req.body for multipart: rebuild bracketed keys and parse JSON strings
function normalizeBodyFromMultipart(req) {
  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  if (!isMultipart) return { ...(req.body || {}) };

  const flat = { ...(req.body || {}) };
  const nested = inflateBrackets(flat);

  const body = { ...flat, ...nested };
  // If a whole collection was sent as JSON string (e.g., feature: '{"title":".."}')
  for (const key of COLLECTION_KEYS) {
    if (typeof body[key] === 'string') {
      try { body[key] = JSON.parse(body[key]); } catch { /* ignore */ }
    }
  }
  return body;
}

/* ─────────────────────────────────────────────────────────────
 * 1) CREATE EVENT (root only)
 *    Body: { title, description, startDate, endDate, target, ...optional fields }
 * ────────────────────────────────────────────────────────────*/
exports.createEvent = asyncHandler(async (req, res) => {
  const {
    title, description, startDate, endDate, target,
    registrationDeadline, venueName, address, city, state, country, mapLink,
    capacity
  } = req.body || {};

  if (!title || !description || !startDate || !endDate || !target)
    return res.status(400).json({ message: 'Missing required event fields' });

  // timing + simple formats
  const start = new Date(startDate), end = new Date(endDate);
  if (!(end > start)) return res.status(400).json({ message: 'endDate must be after startDate' });
  if (registrationDeadline) {
    const rd = new Date(registrationDeadline);
    if (!(rd < start)) return res.status(400).json({ message:'registrationDeadline must be before startDate' });
  }
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 1))
    return res.status(400).json({ message:'capacity must be a positive integer' });
  if (mapLink && !isHttpUrl(mapLink)) return res.status(400).json({ message:'mapLink must be http(s) URL' });

  try {
    const doc = await Event.create({
      title, description, startDate, endDate, target,
      registrationDeadline, venueName, address, city, state, country, mapLink,
      capacity
    });
    return res.status(201).json({ success:true, data:doc });
  } catch (err) {
    return mapDbErr(err, res, 'Event creation failed');
  }
});
const UPLOADS_ROOT = path.resolve(__dirname, '../uploads');
const toPublicPath = (absPath) => {
  const rel = path.relative(UPLOADS_ROOT, absPath).replace(/\\/g, '/');
  return `/uploads/${rel}`;
};
const toAbsFromPublic = (publicPath) => {
  if (!publicPath) return null;
  const rel = publicPath.startsWith('/uploads/') ? publicPath.slice(1) : publicPath; // drop leading '/'
  return path.resolve(__dirname, '..', rel);
};
/* ─────────────────────────────────────────────────────────────
 * 2) UPDATE EVENT
 *    Body always contains: { eventId, ... }
 *    - If body contains one collection object (feature|impact|organizer|comment|gallery|schedule):
 *        - has obj.id  → update that child item
 *        - no obj.id   → create that child item
 *    - Else (no collection object) → update event root fields
 * ────────────────────────────────────────────────────────────*/
exports.updateEvent = asyncHandler(async (req, res) => {
  // normalize body (supports JSON and multipart/form-data)
  const body = normalizeBodyFromMultipart(req);
  console.log("body: ",body);
  const eventId = (body?.eventId || body?.id || '').toString().trim();
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ message: 'Invalid eventId' });

  const pick = pickCollectionObject(body);
  if (pick?.error) return res.status(400).json({ message: pick.error });

  // ───────────── Cover upload branch (no collection) ─────────────
  if (!pick) {
    const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    const coverFile = files.find(f => f.fieldname === 'cover');

    if (body.cover || coverFile) {
      if (!coverFile) return res.status(400).json({ message: 'cover file is missing (send as multipart field "cover")' });

      const ev = await Event.findById(eventId).lean().exec();
      if (!ev) return res.status(404).json({ message: 'Event not found' });

      const newPublic = toPublicPath(coverFile.path);

      try {
        await Event.updateOne(
          { _id: eventId },
          { $set: { cover: newPublic }, $currentDate: { updatedAt: true } }
        ).exec();

        if (ev.cover && typeof ev.cover === 'string') {
          const oldAbs = toAbsFromPublic(ev.cover);
          if (oldAbs) cleanupFile(oldAbs);
        }

        const fresh = await Event.findById(eventId).lean().exec();
        return res.json({ success: true, collection: 'event', mode: 'cover', data: { _id: eventId, cover: fresh?.cover || newPublic } });
      } catch (err) {
        return mapDbErr(err, res, 'Cover update failed');
      }
    }

    // ───────────── Regular event patch (coerced types) ─────────────
    const { eventId: _drop, ...rawPatch } = body || {};
    if (!Object.keys(rawPatch).length) return res.status(400).json({ message: 'No event fields to update' });

    const patch = coerceEventPatch(rawPatch);

    const v = await validateEventPayloadForUpdate(eventId, patch);
    if (!v.ok) return res.status(400).json({ message: v.msg });

    try {
      await Event.updateOne({ _id: eventId }, { $set: patch, $currentDate: { updatedAt: true } }).exec();
      const fresh = await Event.findById(eventId).lean().exec();
      if (!fresh) return res.status(404).json({ message: 'Event not found' });
      return res.json({ success: true, collection: 'event', mode: 'update', data: fresh });
    } catch (err) {
      return mapDbErr(err, res, 'Event update failed');
    }
  }

  // ───────────── One child collection (create/update) ─────────────
  const { name } = pick;
  const Model = COLL[name];

  // get & coerce collection object (supports multipart)
  const rawObj = body[name];
  const obj = coerceCollectionInput(name, isPlainObject(rawObj) ? rawObj : {});

  if (name === 'comment' && obj.actorModel) obj.actorModel = normActor(obj.actorModel);

  // GALLERY branch (unchanged except body use) …
  if (name === 'gallery') {
    const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    const classify = (m) => m?.startsWith('image/') ? 'image' : (m?.startsWith('video/') ? 'video' : 'file');

    if (obj?.id || obj?._id) {
      const id = obj.id || obj._id;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad item id' });

      const current = await Model.findOne({ _id: id, id_event: eventId }).exec();
      if (!current) return res.status(404).json({ message: 'gallery item not found' });

      let filePatch = {};
      if (files.length > 0) {
        const f = files[0];
        filePatch = {
          file        : toPublicPath(f.path),
          kind        : classify(f.mimetype),
          mime        : f.mimetype,
          size        : f.size,
          originalName: f.originalname
        };
      }

      try {
        const $set = { ...sanitizeUpdate(obj), ...filePatch };
        const updated = await Model.findOneAndUpdate(
          { _id: id, id_event: eventId },
          { $set, $currentDate: { updatedAt: true } },
          { new: true, runValidators: true, context: 'query' }
        ).lean().exec();

        if (files.length > 0 && current?.file) {
          const oldAbs = toAbsFromPublic(current.file);
          if (oldAbs) cleanupFile(oldAbs);
        }

        return res.json({ success: true, collection: 'gallery', mode: 'update', data: updated });
      } catch (err) {
        return mapDbErr(err, res, 'Update failed');
      }
    }

    if (!(Array.isArray(req.files) && req.files.length))
      return res.status(400).json({ message: 'No file(s) uploaded for gallery' });

    try {
      const baseFields = sanitizeUpdate(obj);
      const docs = await Promise.all(req.files.map(f =>
        Model.create({
          ...baseFields,
          id_event    : eventId,
          file        : toPublicPath(f.path),
          kind        : classify(f.mimetype),
          mime        : f.mimetype,
          size        : f.size,
          originalName: f.originalname
        })
      ));
      return res.status(201).json({ success: true, collection: 'gallery', mode: 'create', data: docs });
    } catch (err) {
      return mapDbErr(err, res, 'Create failed');
    }
  }

  // Other collections — UPDATE
  if (obj?.id || obj?._id) {
    const id = obj.id || obj._id;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad item id' });

    if (name === 'schedule' && (obj.startTime || obj.endTime)) {
      const current = await Model.findOne({ _id: id, id_event: eventId }).lean();
      if (!current) return res.status(404).json({ message: 'schedule item not found' });
      const newStart = obj.startTime ? new Date(obj.startTime) : new Date(current.startTime);
      const newEnd   = obj.endTime   ? new Date(obj.endTime)   : new Date(current.endTime);
      if (!(newEnd > newStart)) return res.status(400).json({ message: 'endTime must be after startTime' });
    }

    try {
      const $set = sanitizeUpdate(obj);
      const updated = await Model.findOneAndUpdate(
        { _id: id, id_event: eventId },
        { $set, $currentDate: { updatedAt: true } },
        { new: true, runValidators: true, context: 'query' }
      ).lean().exec();

      if (!updated) return res.status(404).json({ message: `${name} item not found` });
      return res.json({ success: true, collection: name, mode: 'update', data: updated });
    } catch (err) {
      return mapDbErr(err, res, 'Update failed');
    }
  }

  // Other collections — CREATE
  if (!REQUIRED[name](obj || {}))
    return res.status(400).json({ message: `Missing required fields for ${name}` });

  if (name === 'schedule') {
    const start = new Date(obj.startTime); const end = new Date(obj.endTime);
    if (!(end > start)) return res.status(400).json({ message: 'endTime must be after startTime' });
  }

  try {
    const doc = await Model.create({ ...obj, id_event: eventId });
    return res.status(201).json({ success: true, collection: name, mode: 'create', data: doc });
  } catch (err) {
    return mapDbErr(err, res, 'Create failed');
  }
});


/* ─────────────────────────────────────────────────────────────
 * 3) DELETE ONE CHILD ITEM (never deletes the event doc)
 *    Body: { eventId, feature:{ id:'...' } }  // or any collection
 * ────────────────────────────────────────────────────────────*/
exports.deleteEventCollectionItem = asyncHandler(async (req, res) => {
  const eventId = (req.body?.eventId || req.body?.id).toString().trim();
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ message:'Invalid eventId' });

  const pick = pickCollectionObject(req.body);
  if (!pick) return res.status(400).json({ message:'Provide one collection object with an id' });

  const { name, obj } = pick;
  const Model = COLL[name];
  const id = obj?.id || obj?._id;
  if (!id || !mongoose.isValidObjectId(id)) return res.status(400).json({ message:'Bad item id' });

  // If gallery: remove the physical file after deletion
  if (name === 'gallery') {
    const current = await Model.findOne({ _id:id, id_event:eventId }).lean().exec();
    if (!current) return res.status(404).json({ message:'gallery item not found' });

    const r = await Model.deleteOne({ _id:id, id_event:eventId }).exec();
    if (!r?.deletedCount) return res.status(404).json({ message:'gallery item not found' });

    // best-effort cleanup
    if (current.file && typeof current.file === 'string' && current.file.startsWith('/uploads/')) {
      const abs = path.resolve(__dirname, '..', current.file);
      cleanupFile(abs);
    }

    return res.json({ success:true, collection:'gallery', deletedId:id });
  }

  // other collections (no files on disk)
  try {
    const result = await Model.deleteOne({ _id:id, id_event:eventId }).exec();
    if (!result?.deletedCount) return res.status(404).json({ message: `${name} item not found` });
    return res.json({ success:true, collection:name, deletedId:id });
  } catch (err) {
    return mapDbErr(err, res, 'Delete failed');
  }
});

/* ──────────────────────────────────────────────────────────────────────────────
 *  🌍  PUBLIC: getEventFull  (GET /api/events/:eventId/full)
 * ─────────────────────────────────────────────────────────────────────────── */
/**
 * Fetch *all* visitor-visible content for a single event in one round-trip.
 * Steps:
 *   1.  Validate eventId & check short-lived cache.
 *   2.  Parallel Mongo queries using lean() to minimise overhead.
 *   3.  Merge results into a single JSON blob.
 *   4.  Cache the payload (Redis) and return.
 *
 * Response:
 *   {
 *     success : true,
 *     data    : {
 *       event, organizers, impacts, features,
 *       gallery, schedule, comments
 *     }
 *   }
 */

exports.getEvents = asyncHandler(async (req, res) => {

  const events = await Event.find().lean();
  res.json({ success: true, data: events });
});












exports.getEventFull = asyncHandler(async (req, res) => {
  const {eventId} = req.body;
  console.log(eventId);
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Invalid eventId' });

  /* 1️⃣  Check cache */
  const CACHE_KEY = `eventFull:${eventId}`;
  const cached = await cacheGet(CACHE_KEY);
  if (cached) return res.json({ success: true, data: cached });

  /* 2️⃣  Master + child queries in parallel */
  const [
    event,
    organizers,
    impacts,
    features,
    gallery,
    schedule,
    comments
  ] = await Promise.all([
    Event.findById(eventId).lean(),
    Organizer.find({ id_event: eventId }).lean(),
    Impact.find({ id_event: eventId }).lean(),
    Feature.find({ id_event: eventId }).lean(),
    Gallery.find({ id_event: eventId })
           .sort({ createdAt: -1 })
           .limit(24)
           .lean(),
    Schedule.find({ id_event: eventId })
            .sort({ startTime: 1 })
            .lean(),
    Comment.find({ id_event: eventId, verified: true })
           .sort({ createdAt: -1 })
           .limit(50)
           .lean()
  ]);

  /* 3️⃣  Merge + cache + respond */
  const payload = { event, organizers, impacts, features, gallery, schedule, comments };
  await cacheSet(CACHE_KEY, payload);

  res.json({ success: true, data: payload });
});

/* Export the cache-init so server.js can inject redis */
module.exports.initCacheWrapper = initCacheWrapper;
module.exports.toId             = toId;
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 2 / N) ────────────────────────────────────────────────────────────────
 *
 *  ADMIN-ONLY ENDPOINTS
 *  ────────────────────
 *  1.  getAdminDashboard  – overall stats for the admin home.
 *  2.  listBills          – paginated bills with filters.
 *  3.  listTickets        – paginated tickets with filters.
 *  4.  listPendingComments/approveComment/rejectComment.
 *
 *  Dependencies:   Part 1 must already be loaded in the same module scope
 *                  (imports / models / helpers like `toId`, `buildPage`, cache wrapper).
 **************************************************************************************************/

/* ──────────────────────────────────────────────────────────────────────────────
 *  🛂  Simple role guard (re-use your roleGuard middleware in routes ideally)
 * ─────────────────────────────────────────────────────────────────────────── */
const isAdminReq = (req) => req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');

/* ──────────────────────────────────────────────────────────────────────────────
 *  1️⃣  ADMIN DASHBOARD  (GET /api/events/:eventId/admin/dashboard)
 *      • Total revenue, tickets sold, refund count
 *      • Gallery count, speakers count, comment stats
 *      • Cached for 60 s
 * ─────────────────────────────────────────────────────────────────────────── */
const DASH_TTL = 60;   // 60 s cache just for admin

exports.getAdminDashboard = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Bad eventId' });

  const CACHE_KEY = `dash:${eventId}`;
  const cached = await cacheGet(CACHE_KEY);     // ← cache helpers from Part 1
  if (cached) return res.json({ success: true, data: cached });

  /* Aggregate stats in parallel */
  const [
    billAgg,
    ticketAgg,
    refundAgg,
    commentAgg,
    galleryCount,
    speakerCount
  ] = await Promise.all([
    EventBill.aggregate([
      { $match: { id_event: toId(eventId), status: 'paid' } },
      { $group: { _id: null, totalRevenue: { $sum: '$total' }, count: { $sum: 1 } } }
    ]),
    EventTicket.countDocuments({ id_event: eventId }),
    EventBill.countDocuments({ id_event: eventId, status: 'refunded' }),
    Comment.aggregate([
      { $match: { id_event: toId(eventId) } },
      { $group: { _id: '$verified', count: { $sum: 1 } } }
    ]),
    Gallery.countDocuments({ id_event: eventId }),
    Schedule.distinct('speaker', { id_event: eventId })  // unique speakers
  ]);

  const paidStats   = billAgg[0] || { totalRevenue: 0, count: 0 };
  const verifiedCnt = commentAgg.find(c => c._id === true)?.count || 0;
  const pendingCnt  = commentAgg.find(c => c._id === false)?.count || 0;

  const dash = {
    revenueUSD : paidStats.totalRevenue,
    ticketsSold: ticketAgg,
    refundCount: refundAgg,
    galleryItems: galleryCount,
    speakers   : speakerCount.length,
    comments: {
      verified: verifiedCnt,
      pending : pendingCnt
    }
  };

  await cacheSet(CACHE_KEY, dash);              // TTL 60 s
  res.json({ success: true, data: dash });
});

/* ──────────────────────────────────────────────────────────────────────────────
 *  2️⃣  BILLS LIST  (GET /api/events/:eventId/bills)
 *      Query params: ?status=paid|refunded&currency=USD&page=1&limit=20
 * ─────────────────────────────────────────────────────────────────────────── */
exports.listBills = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { status, currency, page = 1, limit = 20 } = req.query;

  const query = { id_event: eventId };
  if (status)   query.status   = status;
  if (currency) query.currency = currency;

  const [bills, total] = await Promise.all([
    EventBill.find(query)
             .sort({ createdAt: -1 })
             .skip((page - 1) * limit)
             .limit(Number(limit))
             .lean(),
    EventBill.countDocuments(query)
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    count: bills.length,
    data: bills
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 *  3️⃣  TICKETS LIST  (GET /api/events/:eventId/tickets)
 *      Query params: ?type=silver|vip&page=1&limit=20
 * ─────────────────────────────────────────────────────────────────────────── */
exports.listTickets = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { type, page = 1, limit = 20 } = req.query;

  const q = { id_event: eventId };
  if (type) q.ticketType = type;

  const [tickets, total] = await Promise.all([
    EventTicket.find(q)
               .sort({ createdAt: -1 })
               .skip((page - 1) * limit)
               .limit(Number(limit))
               .lean(),
    EventTicket.countDocuments(q)
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    count: tickets.length,
    data: tickets
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 *  4️⃣  COMMENT MODERATION
 *      • listPendingComments  (GET  /events/:eventId/comments/pending)
 *      • approveComment       (PATCH /comments/:commentId/approve)
 *      • rejectComment        (DELETE/patch /comments/:commentId/reject)
 * ─────────────────────────────────────────────────────────────────────────── */
exports.listPendingComments = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const pending = await Comment.find({ id_event: eventId, verified: false })
                               .sort({ createdAt: -1 })
                               .lean();
  res.json({ success: true, count: pending.length, data: pending });
});

exports.approveComment = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { commentId } = req.params;
  if (!mongoose.isValidObjectId(commentId))
    return res.status(400).json({ message: 'Invalid commentId' });

  const updated = await Comment.findByIdAndUpdate(
    commentId,
    { verified: true },
    { new: true }
  ).lean();

  if (!updated) return res.status(404).json({ message: 'Comment not found' });
  res.json({ success: true, data: updated });
});

exports.rejectComment = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { commentId } = req.params;
  if (!mongoose.isValidObjectId(commentId))
    return res.status(400).json({ message: 'Invalid commentId' });

  const removed = await Comment.findByIdAndDelete(commentId).lean();
  if (!removed) return res.status(404).json({ message: 'Comment not found' });

  res.json({ success: true, message: 'Comment deleted' });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 3 / N) ────────────────────────────────────────────────────────────────
 *
 *  ADMIN CRUD – ORGANIZER  +  IMPACT
 *  ──────────────────────────────────
 *  Endpoints implemented here:
 *
 *  ORGANIZERS
 *  ----------  (all routes assume prefix /api/events/:eventId/organizers)
 *   • listOrganizers      – GET    /               (paginated)
 *   • createOrganizer     – POST   /
 *   • updateOrganizer     – PATCH  /:orgId
 *   • deleteOrganizer     – DELETE /:orgId
 *
 *  IMPACTS
 *  -------  (prefix /api/events/:eventId/impacts)
 *   • listImpacts         – GET    /
 *   • createImpact        – POST   /
 *   • updateImpact        – PATCH  /:impactId
 *   • deleteImpact        – DELETE /:impactId
 *
 *  All routes require admin role, validated by the isAdminReq() helper from Part 2.
 **************************************************************************************************/


/*──────────────────────── Internal field validators ───────────────*/
const URL_RX = /^https?:\/\/[\w.-]+/;
const ORG_TYPE_SET = new Set(['host', 'co-host', 'sponsor', 'partner', 'media']);

/*──────────────────────── Organizers CRUD ──────────────────────────*/

/** GET paginated organizers */
exports.listOrganizers = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const [rows, total] = await Promise.all([
    Organizer.find({ id_event: eventId })
             .sort({ createdAt: -1 })
             .skip((page - 1) * limit)
             .limit(Number(limit))
             .lean(),
    Organizer.countDocuments({ id_event: eventId })
  ]);

  res.json({ success:true, page:Number(page), pages:Math.ceil(total/limit), count:rows.length, data:rows });
});

/** POST create new organizer */
exports.createOrganizer = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { logo, link = '', type = 'host' } = req.body;

  if (!logo || !URL_RX.test(logo))
    return res.status(400).json({ message: 'Valid logo URL required' });
  if (link && !URL_RX.test(link))
    return res.status(400).json({ message: 'Invalid link URL' });
  if (!ORG_TYPE_SET.has(type))
    return res.status(400).json({ message: `type must be one of ${[...ORG_TYPE_SET].join(', ')}` });

  const doc = await Organizer.create({ logo, link, type, id_event: eventId });
  res.status(201).json({ success:true, data:doc });
});

/** PATCH update organizer */
exports.updateOrganizer = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { orgId } = req.params;
  if (!mongoose.isValidObjectId(orgId))
    return res.status(400).json({ message: 'Invalid orgId' });

  const update = {};
  const { logo, link, type } = req.body;
  if (logo !== undefined) {
    if (!URL_RX.test(logo)) return res.status(400).json({ message: 'Invalid logo URL' });
    update.logo = logo;
  }
  if (link !== undefined) {
    if (link && !URL_RX.test(link)) return res.status(400).json({ message: 'Invalid link URL' });
    update.link = link;
  }
  if (type !== undefined) {
    if (!ORG_TYPE_SET.has(type)) return res.status(400).json({ message: 'Bad type' });
    update.type = type;
  }
  update.updatedAt = Date.now();

  const doc = await Organizer.findByIdAndUpdate(orgId, update, { new:true }).lean();
  if (!doc) return res.status(404).json({ message: 'Organizer not found' });
  res.json({ success:true, data:doc });
});

/** DELETE organizer */
exports.deleteOrganizer = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { orgId } = req.params;
  if (!mongoose.isValidObjectId(orgId))
    return res.status(400).json({ message: 'Invalid orgId' });

  const out = await Organizer.findByIdAndDelete(orgId).lean();
  if (!out) return res.status(404).json({ message: 'Organizer not found' });
  res.json({ success:true, message:'Organizer deleted' });
});

/*──────────────────────── Impacts CRUD ─────────────────────────────*/

/** GET all impacts (no pagination; typically few) */
exports.listImpacts = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });
  const rows = await Impact.find({ id_event: req.params.eventId }).sort({ createdAt: -1 }).lean();
  res.json({ success:true, count:rows.length, data:rows });
});

/** POST create impact */
exports.createImpact = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { title, description } = req.body;
  if (!title || title.length < 3) return res.status(400).json({ message: 'Title min 3 chars' });
  if (!description || description.length < 10)
    return res.status(400).json({ message: 'Description min 10 chars' });

  const doc = await Impact.create({ title, description, id_event: req.params.eventId });
  res.status(201).json({ success:true, data:doc });
});

/** PATCH update impact */
exports.updateImpact = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { impactId } = req.params;
  if (!mongoose.isValidObjectId(impactId))
    return res.status(400).json({ message: 'Invalid impactId' });

  const update = {};
  if (req.body.title)       update.title       = req.body.title;
  if (req.body.description) update.description = req.body.description;
  update.updatedAt = Date.now();

  const doc = await Impact.findByIdAndUpdate(impactId, update, { new:true }).lean();
  if (!doc) return res.status(404).json({ message: 'Impact not found' });
  res.json({ success:true, data:doc });
});

/** DELETE impact */
exports.deleteImpact = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { impactId } = req.params;
  if (!mongoose.isValidObjectId(impactId))
    return res.status(400).json({ message: 'Invalid impactId' });

  const out = await Impact.findByIdAndDelete(impactId).lean();
  if (!out) return res.status(404).json({ message: 'Impact not found' });
  res.json({ success:true, message:'Impact deleted' });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 4 / N) ────────────────────────────────────────────────────────────────
 *
 *  ADMIN CRUD – GALLERY  +  FEATURE
 *  ─────────────────────────────────
 *  Endpoints implemented here:
 *
 *  GALLERY
 *  -------  (prefix /api/events/:eventId/gallery)
 *    • listGallery         – GET    /             (filter + pagination)
 *    • uploadGalleryItem   – POST   /             (create)
 *    • updateGalleryItem   – PATCH  /:itemId
 *    • deleteGalleryItem   – DELETE /:itemId
 *
 *  FEATURE
 *  -------  (prefix /api/events/:eventId/features)
 *    • listFeatures        – GET    /
 *    • createFeature       – POST   /
 *    • updateFeature       – PATCH  /:featureId
 *    • deleteFeature       – DELETE /:featureId
 *
 *  NOTE: Uses the isAdminReq() helper from Part 2 for role gating.
 **************************************************************************************************/

/* Already imported in Part 1:
      const Gallery  = require('../models/eventGallery');
      const Feature  = require('../models/eventFeature');
*/

/*──────────────────────── Validation Helpers ─────────────────────────*/
const IMG_RX   = /^https?:\/\/[\w.-]+\.(png|jpe?g|gif|webp)$/i;
const VID_RX   = /^https?:\/\/[\w.-]+\.(mp4|mov|avi|webm)$/i;
const PDF_RX   = /^https?:\/\/[\w.-]+\.pdf$/i;

function validateGalleryFile(url, type) {
  if (type === 'image'   && !IMG_RX.test(url)) return false;
  if (type === 'video'   && !VID_RX.test(url)) return false;
  if (type === 'pdf'     && !PDF_RX.test(url)) return false;
  return true;
}

/*─────────────────────────── GALLERY CRUD ────────────────────────────*/

/**
 * GET paginated gallery items with optional type filter
 * Query params:  ?type=image|video|pdf&page=1&limit=24
 */
exports.listGallery = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { type, page = 1, limit = 24 } = req.query;

  const query = { id_event: eventId };
  if (type) query.type = type;

  const [items, total] = await Promise.all([
    Gallery.find(query)
           .sort({ createdAt: -1 })
           .skip((page - 1) * limit)
           .limit(Number(limit))
           .lean(),
    Gallery.countDocuments(query)
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    count: items.length,
    data: items
  });
});

/**
 * POST upload (create) a gallery item
 * Body: { file, type=image|video|pdf, title? }
 */
exports.uploadGalleryItem = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { file, type = 'image', title = '' } = req.body;

  if (!file || !['image', 'video', 'pdf'].includes(type))
    return res.status(400).json({ message: 'file URL and valid type required' });

  if (!validateGalleryFile(file, type))
    return res.status(400).json({ message: 'file URL extension does not match type' });

  const doc = await Gallery.create({ file, type, title, id_event: eventId });
  res.status(201).json({ success: true, data: doc });
});

/**
 * PATCH update gallery item (title or file/type replacement)
 */
exports.updateGalleryItem = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { itemId } = req.params;
  if (!mongoose.isValidObjectId(itemId))
    return res.status(400).json({ message: 'Invalid itemId' });

  const update = {};
  const { file, type, title } = req.body;

  if (file !== undefined || type !== undefined) {
    const newType = type || (await Gallery.findById(itemId).lean())?.type || 'image';
    const newFile = file || (await Gallery.findById(itemId).lean())?.file;
    if (!validateGalleryFile(newFile, newType))
      return res.status(400).json({ message: 'file URL extension mismatch' });
    update.file = newFile;
    update.type = newType;
  }
  if (title !== undefined) update.title = title;
  update.updatedAt = Date.now();

  const doc = await Gallery.findByIdAndUpdate(itemId, update, { new: true }).lean();
  if (!doc) return res.status(404).json({ message: 'Gallery item not found' });
  res.json({ success: true, data: doc });
});

/**
 * DELETE gallery item
 */
exports.deleteGalleryItem = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { itemId } = req.params;
  if (!mongoose.isValidObjectId(itemId))
    return res.status(400).json({ message: 'Invalid itemId' });

  const out = await Gallery.findByIdAndDelete(itemId).lean();
  if (!out) return res.status(404).json({ message: 'Gallery item not found' });
  res.json({ success: true, message: 'Gallery item deleted' });
});

/*─────────────────────────── FEATURE CRUD ────────────────────────────*/

/**
 * GET paginated features
 * Query: ?page=1&limit=20
 */
exports.listFeatures = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const [rows, total] = await Promise.all([
    Feature.find({ id_event: eventId })
           .sort({ createdAt: -1 })
           .skip((page - 1) * limit)
           .limit(Number(limit))
           .lean(),
    Feature.countDocuments({ id_event: eventId })
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    count: rows.length,
    data: rows
  });
});

/**
 * POST create feature
 * Body: { title, subtitle?, desc, image? }
 */
exports.createFeature = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { title, subtitle = '', desc, image = '' } = req.body;

  if (!title || title.length < 3)
    return res.status(400).json({ message: 'title min 3 chars' });
  if (!desc || desc.length < 10)
    return res.status(400).json({ message: 'desc min 10 chars' });
  if (image && !IMG_RX.test(image))
    return res.status(400).json({ message: 'Invalid image URL' });

  const doc = await Feature.create({ title, subtitle, desc, image, id_event: eventId });
  res.status(201).json({ success: true, data: doc });
});

/**
 * PATCH update feature
 */
exports.updateFeature = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { featureId } = req.params;
  if (!mongoose.isValidObjectId(featureId))
    return res.status(400).json({ message: 'Invalid featureId' });

  const update = {};
  const { title, subtitle, desc, image } = req.body;

  if (title !== undefined) {
    if (title.length < 3) return res.status(400).json({ message: 'title min 3 chars' });
    update.title = title;
  }
  if (subtitle !== undefined) update.subtitle = subtitle;
  if (desc !== undefined) {
    if (desc.length < 10) return res.status(400).json({ message: 'desc min 10 chars' });
    update.desc = desc;
  }
  if (image !== undefined) {
    if (image && !IMG_RX.test(image))
      return res.status(400).json({ message: 'Invalid image URL' });
    update.image = image;
  }
  update.updatedAt = Date.now();

  const doc = await Feature.findByIdAndUpdate(featureId, update, { new: true }).lean();
  if (!doc) return res.status(404).json({ message: 'Feature not found' });
  res.json({ success: true, data: doc });
});

/**
 * DELETE feature
 */
exports.deleteFeature = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { featureId } = req.params;
  if (!mongoose.isValidObjectId(featureId))
    return res.status(400).json({ message: 'Invalid featureId' });

  const out = await Feature.findByIdAndDelete(featureId).lean();
  if (!out) return res.status(404).json({ message: 'Feature not found' });
  res.json({ success: true, message: 'Feature deleted' });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 5 / N) ────────────────────────────────────────────────────────────────
 *
 *  ADMIN CRUD – SCHEDULE
 *  ──────────────────────
 *  Prefix for all routes in this section:  /api/events/:eventId/schedule
 *
 *   • listSchedule     – GET    /                         (paginated, by day)
 *   • createSession    – POST   /                         (add session)
 *   • updateSession    – PATCH  /:sessionId               (edit session)
 *   • deleteSession    – DELETE /:sessionId               (remove session)
 *
 *  Extras:
 *    » Validates start < end and no overlaps in the same room.
 *    » Optionally checks speaker exists (by ObjectId).
 *    » Times are ISO strings or epoch numbers; stored as Date.
 **************************************************************************************************/

const Speaker  = require('../models/speaker');      // for existence check

/*──────────────────────── Helper: parse/validate ISO dates ───────────*/
function toDate(val) { const d = new Date(val); return isNaN(d) ? null : d; }

/*──────────────────────── List schedule (paginated) ──────────────────
 *  Query params:
 *     ?day=2025-08-05      → only sessions on that calendar day
 *     ?page=1&limit=30
 */
exports.listSchedule = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { day, page = 1, limit = 30 } = req.query;

  const match = { id_event: eventId };
  if (day) {                       // filter by single day
    const start = new Date(`${day}T00:00:00.000Z`);
    const end   = new Date(`${day}T23:59:59.999Z`);
    match.startTime = { $gte: start, $lte: end };
  }

  const [rows, total] = await Promise.all([
    Schedule.find(match)
            .sort({ startTime: 1 })
            .skip((page - 1) * limit)
            .limit(Number(limit))
            .lean(),
    Schedule.countDocuments(match)
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    count: rows.length,
    data: rows
  });
});

/*──────────────────────── Create session ─────────────────────────────
 * Body: { sessionTitle, speaker?, room?, startTime, endTime }
 */
exports.createSession = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { sessionTitle, speaker, room = '', startTime, endTime } = req.body;

  /* Basic validation -------------------------------------------------- */
  if (!sessionTitle || sessionTitle.length < 3)
    return res.status(400).json({ message: 'sessionTitle min 3 chars' });

  const start = toDate(startTime);
  const end   = toDate(endTime);
  if (!start || !end) return res.status(400).json({ message: 'Invalid ISO dates' });
  if (end <= start)   return res.status(400).json({ message: 'endTime must be after startTime' });

  /* Speaker existence (optional) -------------------------------------- */
  if (speaker && !await Speaker.exists({ _id: speaker }))
    return res.status(400).json({ message: 'Speaker not found' });

  /* No-overlap rule in same room -------------------------------------- */
  if (room) {
    const clash = await Schedule.findOne({
      id_event: eventId,
      room,
      $or: [
        { startTime: { $lt: end,  $gte: start } },
        { endTime:   { $gt: start, $lte: end } },
        { startTime: { $lte: start }, endTime: { $gte: end } }
      ]
    }).lean();
    if (clash)
      return res.status(409).json({ message: `Time clash with session "${clash.sessionTitle}"` });
  }

  /* Create session ---------------------------------------------------- */
  const doc = await Schedule.create({
    id_event: eventId,
    sessionTitle,
    speaker,
    room,
    startTime: start,
    endTime: end
  });

  res.status(201).json({ success: true, data: doc });
});

/*──────────────────────── Update session ─────────────────────────────*/
exports.updateSession = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { sessionId } = req.params;
  if (!mongoose.isValidObjectId(sessionId))
    return res.status(400).json({ message: 'Invalid sessionId' });

  const update = {};
  const { sessionTitle, speaker, room, startTime, endTime } = req.body;

  if (sessionTitle !== undefined) {
    if (sessionTitle.length < 3) return res.status(400).json({ message: 'sessionTitle min 3 chars' });
    update.sessionTitle = sessionTitle;
  }

  if (speaker !== undefined) {
    if (speaker && !await Speaker.exists({ _id: speaker }))
      return res.status(400).json({ message: 'Speaker not found' });
    update.speaker = speaker;
  }

  if (room !== undefined) update.room = room;

  /* If times are supplied, validate and check for clash */
  let start = undefined, end = undefined;
  if (startTime !== undefined) {
    start = toDate(startTime);
    if (!start) return res.status(400).json({ message: 'Bad startTime' });
    update.startTime = start;
  }
  if (endTime !== undefined) {
    end = toDate(endTime);
    if (!end) return res.status(400).json({ message: 'Bad endTime' });
    update.endTime = end;
  }
  if (start !== undefined || end !== undefined) {
    const curr = await Schedule.findById(sessionId).lean();
    const newStart = start || curr.startTime;
    const newEnd   = end   || curr.endTime;
    if (newEnd <= newStart) return res.status(400).json({ message: 'endTime must be after startTime' });

    const clash = await Schedule.findOne({
      _id: { $ne: sessionId },
      id_event: curr.id_event,
      room: room !== undefined ? room : curr.room,
      $or: [
        { startTime: { $lt: newEnd,  $gte: newStart } },
        { endTime:   { $gt: newStart, $lte: newEnd } },
        { startTime: { $lte: newStart }, endTime: { $gte: newEnd } }
      ]
    }).lean();
    if (clash)
      return res.status(409).json({ message: `Time clash with session "${clash.sessionTitle}"` });
  }

  update.updatedAt = Date.now();

  const doc = await Schedule.findByIdAndUpdate(sessionId, update, { new: true }).lean();
  if (!doc) return res.status(404).json({ message: 'Session not found' });
  res.json({ success: true, data: doc });
});

/*──────────────────────── Delete session ─────────────────────────────*/
exports.deleteSession = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { sessionId } = req.params;
  if (!mongoose.isValidObjectId(sessionId))
    return res.status(400).json({ message: 'Invalid sessionId' });

  const out = await Schedule.findByIdAndDelete(sessionId).lean();
  if (!out) return res.status(404).json({ message: 'Session not found' });
  res.json({ success: true, message: 'Session deleted' });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 6 / N) ────────────────────────────────────────────────────────────────
 *
 *  VISITOR-SIDE ENDPOINTS
 *  ──────────────────────
 *  Not every public page needs the giant blob from getEventFull() (Part 1).  
 *  These functions return *just the slice* a page needs, keeping bandwidth low
 *  and enabling browser-level SW caching.
 *
 *  Included in this part:
 *   • getGalleryPublic      – GET /events/:eventId/gallery        (paginated)
 *   • getSchedulePublic     – GET /events/:eventId/schedule
 *   • getFeaturesPublic     – GET /events/:eventId/features
 *   • getImpactsPublic      – GET /events/:eventId/impacts
 *   • getOrganizersPublic   – GET /events/:eventId/organizers
 *   • getVisitorStats       – GET /events/:eventId/stats
 *
 *  All data is <strong>read-only</strong>; no auth required.
 *  Each handler checks Redis cache (TTL 5 min) to keep Mongo load minimal.
 **************************************************************************************************/

const CACHE_5M = 300;   // seconds

/* ───────────────────────── Helper: generic cached fetch ───────────── */
async function cachedQuery(key, ttl, queryFn) {
  const hit = await cacheGet(key);
  if (hit) return hit;
  const data = await queryFn();
  await cacheSet(key, data, ttl);
  return data;
}

/* ───────────────────────── Gallery (public) ──────────────────────────
 *  Query ?page & ?limit; type filter optional (?type=image/video/pdf)  */
exports.getGalleryPublic = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { page = 1, limit = 24, type } = req.query;

  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Bad eventId' });

  const cacheKey = `pubGallery:${eventId}:${page}:${limit}:${type || 'all'}`;
  const payload = await cachedQuery(cacheKey, CACHE_5M, async () => {
    const q = { id_event: eventId };
    if (type) q.type = type;
    const [rows, total] = await Promise.all([
      Gallery.find(q).sort({ createdAt: -1 })
             .skip((page - 1) * limit).limit(Number(limit)).lean(),
      Gallery.countDocuments(q)
    ]);
    return { rows, total };
  });

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(payload.total / limit),
    count: payload.rows.length,
    data: payload.rows
  });
});

/* ───────────────────────── Schedule (public) ──────────────────────── */
exports.getSchedulePublic = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Bad eventId' });

  const cacheKey = `pubSchedule:${eventId}`;
  const rows = await cachedQuery(cacheKey, CACHE_5M, () =>
    Schedule.find({ id_event: eventId })
            .sort({ startTime: 1 })
            .lean()
  );

  res.json({ success: true, count: rows.length, data: rows });
});

/* ───────────────────────── Features (public) ──────────────────────── */
exports.getFeaturesPublic = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const cacheKey = `pubFeatures:${eventId}`;
  const rows = await cachedQuery(cacheKey, CACHE_5M, () =>
    Feature.find({ id_event: eventId }).sort({ createdAt: -1 }).lean()
  );
  res.json({ success: true, count: rows.length, data: rows });
});

/* ───────────────────────── Impacts (public) ───────────────────────── */
exports.getImpactsPublic = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const rows = await cachedQuery(`pubImpacts:${eventId}`, CACHE_5M, () =>
    Impact.find({ id_event: eventId }).lean()
  );
  res.json({ success: true, count: rows.length, data: rows });
});

/* ───────────────────────── Organizers (public) ────────────────────── */
exports.getOrganizersPublic = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const rows = await cachedQuery(`pubOrgs:${eventId}`, CACHE_5M, () =>
    Organizer.find({ id_event: eventId }).lean()
  );
  res.json({ success: true, count: rows.length, data: rows });
});

/* ───────────────────────── Visitor mini-stats ───────────────────────
 *  Returns *public* counts (no sensitive money figures):
 *    { ticketsSold, gallery, speakers, features }
 *  Cached 5 min
 */
exports.getVisitorStats = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Bad eventId' });

  const key = `pubStats:${eventId}`;
  const stats = await cachedQuery(key, CACHE_5M, async () => {
    const [ticketCnt, galleryCnt, speakersCnt, featureCnt] = await Promise.all([
      EventTicket.countDocuments({ id_event: eventId }),
      Gallery.countDocuments({ id_event: eventId }),
      Schedule.distinct('speaker', { id_event: eventId }),
      Feature.countDocuments({ id_event: eventId })
    ]);
    return {
      ticketsSold: ticketCnt,
      galleryItems: galleryCnt,
      speakers: speakersCnt.length,
      features: featureCnt
    };
  });

  res.json({ success: true, data: stats });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 7 / N) ───────────────────────────────────────────────────────────────
 *
 *  EXPORT / FEED ENDPOINTS
 *  ───────────────────────
 *   1. exportBillsCSV       – Admin → CSV download of bills
 *   2. exportTicketsCSV     – Admin → CSV download of tickets
 *   3. getScheduleICS       – Public → .ics calendar feed of all sessions
 *
 *  Notes
 *  -----
 *   • Uses json2csv for quick CSV; streams directly to the response.
 *   • Uses ical-generator for a valid VCALENDAR feed.
 **************************************************************************************************/

const { Parser } = require('json2csv');
const ical      = require('ical-generator');

const fs        = require('node:stream');   // for pipeline()

/*──────────────────────── 1️⃣  Bills CSV (admin) ──────────────────────
 *  GET /api/events/:eventId/bills/export.csv?status=paid
 */
exports.exportBillsCSV = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { status } = req.query;

  const query = { id_event: eventId };
  if (status) query.status = status;

  const bills = await EventBill.find(query).lean();

  const csv = new Parser({
    fields: [
      { label: 'Bill ID',        value: '_id' },
      { label: 'Actor ID',       value: 'id_actor' },
      { label: 'Currency',       value: 'currency' },
      { label: 'Subtotal',       value: 'subtotal' },
      { label: 'Tax Rate',       value: 'taxRate' },
      { label: 'Discount',       value: 'discount' },
      { label: 'Total',          value: 'total' },
      { label: 'Status',         value: 'status' },
      { label: 'Method',         value: 'method' },
      { label: 'Gateway Ref',    value: 'gatewayRef' },
      { label: 'Issued At',      value: (row) => row.issuedAt?.toISOString() },
      { label: 'Paid At',        value: (row) => row.paidAt?.toISOString() }
    ]
  }).parse(bills);

  res.setHeader('Content-Type',        'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bills_${eventId}.csv"`);
  res.status(200).send(csv);
});

/*──────────────────────── 2️⃣  Tickets CSV (admin) ────────────────────
 *  GET /api/events/:eventId/tickets/export.csv?type=vip
 */
exports.exportTicketsCSV = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const { type } = req.query;

  const q = { id_event: eventId };
  if (type) q.ticketType = type;

  const tickets = await EventTicket.find(q).lean();

  const csv = new Parser({
    fields: [
      { label: 'Ticket ID',   value: '_id' },
      { label: 'Actor ID',    value: 'id_actor' },
      { label: 'Bill ID',     value: 'id_bill' },
      { label: 'Type',        value: 'ticketType' },
      { label: 'Checked In',  value: 'checkedIn' },
      { label: 'Created At',  value: (row) => row.createdAt?.toISOString() },
      { label: 'Checked At',  value: (row) => row.checkedInAt?.toISOString() }
    ]
  }).parse(tickets);

  res.setHeader('Content-Type',        'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="tickets_${eventId}.csv"`);
  res.status(200).send(csv);
});

/*──────────────────────── 3️⃣  Schedule ICS (public) ──────────────────
 *  GET /api/events/:eventId/schedule.ics
 */
exports.getScheduleICS = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Bad eventId' });

  /* Small cache (5 min) because schedule rarely changes */
  const CACHE_KEY = `ics:${eventId}`;
  const cached = await cacheGet(CACHE_KEY);
  if (cached) {
    res.setHeader('Content-Type', 'text/calendar');
    return res.status(200).send(cached);
  }

  const sessions = await Schedule.find({ id_event: eventId }).lean();
  if (sessions.length === 0)
    return res.status(404).json({ message: 'No sessions' });

  const cal = ical({ name: `Event ${eventId} Schedule` });
  sessions.forEach(s => {
    cal.createEvent({
      id:    s._id.toString(),
      start: s.startTime,
      end:   s.endTime,
      summary: s.sessionTitle,
      location: s.room || '',
      url: `${process.env.FRONTEND_URL}/events/${eventId}#session-${s._id}`
    });
  });

  const icsString = cal.toString();
  await cacheSet(CACHE_KEY, icsString, 300);      // 5 min

  res.setHeader('Content-Type',        'text/calendar');
  res.setHeader('Content-Disposition', `attachment; filename="event_${eventId}.ics"`);
  res.status(200).send(icsString);
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 8 / N) ────────────────────────────────────────────────────────────────
 *
 *  1. handleBankWebhook  – POST /webhooks/bank
 *     Receives async notifications from the real bank gateway (success, refund, failure),
 *     updates bills & tickets accordingly, and sends e-mail receipts / refund notices.
 *
 *  2. getBillReceiptPDF  – GET  /bills/:billId/receipt.pdf   (admin or owner)
 *     Generates a one-off PDF receipt using PDFKit and streams it.
 *
 *  Requires:
 *     • PDFKit   →  npm i pdfkit
 *     • bankGateway util already configured (signature verification optional)
 **************************************************************************************************/

const PDFDocument = require('pdfkit');
const Bank        = require('../config/bankgateway');
const { sendMail } = require('../config/mailer');

/*──────────────────────── 1️⃣  Bank webhook ───────────────────────────
 *  IMPORTANT: set the route in server.js BEFORE body-parser! Use raw
 *  body for signature verification if your bank supports it. Here we
 *  assume application/json and a shared secret header “x-bank-sign”.
 *
 *  Event examples:
 *    { type:'charge.captured', data:{ id:'cap_123', amount:99, currency:'USD',
 *                                     metadata:{ billId:'...' } } }
 *    { type:'charge.refunded', data:{ id:'cap_123', amount:99, ... } }
 */
exports.handleBankWebhook = asyncHandler(async (req, res) => {
  /* 0. (Optional) verify signature ------------------------------------ */
  // const sig = req.headers['x-bank-sign'];
  // if (!Bank.verifyWebhook(sig, req.rawBody)) return res.status(400).send('Bad sig');

  const { type, data } = req.body;
  if (!type || !data?.metadata?.billId)
    return res.status(400).send('Malformed payload');

  const billId = data.metadata.billId;
  const bill = await EventBill.findById(billId).exec();
  if (!bill) return res.status(200).send('Ignored');

  switch (type) {
    case 'charge.captured': {
      if (bill.status === 'paid') break; // idempotent
      bill.status = 'paid';
      bill.paidAt = new Date(data.captured_at || Date.now());
      await bill.save();

      /* create ticket if it wasn’t done by email flow (guest payment link) */
      const existing = await EventTicket.findOne({ id_bill: bill._id });
      if (!existing) {
        await EventTicket.create({
          id_event: bill.id_event,
          id_actor: bill.id_actor,
          actorModel: bill.actorModel,
          id_bill: bill._id,
          ticketType: 'silver'
        });
        await Event.updateOne({ _id: bill.id_event }, { $inc: { seatsTaken: 1 } });
      }

      sendMail(bill.email, 'Payment received', `Your payment of ${bill.total} ${bill.currency} is confirmed.`);
      break;
    }

    case 'charge.refunded': {
      if (bill.status === 'refunded') break;
      bill.status = 'refunded';
      bill.updatedAt = Date.now();
      await bill.save();

      await EventTicket.updateOne(
        { id_bill: bill._id },
        { $set: { ticketType: 'refunded' } }
      );
      await Event.updateOne(
        { _id: bill.id_event, seatsTaken: { $gt: 0 } },
        { $inc: { seatsTaken: -1 } }
      );

      sendMail(bill.email, 'Refund processed', `Your refund of ${bill.total} ${bill.currency} is complete.`);
      break;
    }

    default:
      /* ignore unrelated event types */
  }

  res.status(200).send('OK');
});

/*──────────────────────── 2️⃣  Bill → PDF receipt ──────────────────────
 *  GET /api/bills/:billId/receipt.pdf
 *  • Admins can fetch any bill.
 *  • Users can fetch only their own bill (match email / id_actor).
 */
exports.getBillReceiptPDF = asyncHandler(async (req, res) => {
  const { billId } = req.params;
  if (!mongoose.isValidObjectId(billId))
    return res.status(400).json({ message: 'Invalid billId' });

  const bill = await EventBill.findById(billId).populate('id_event').lean();
  if (!bill) return res.status(404).json({ message: 'Bill not found' });

  /* Authorization: admin OR bill owner (by email or actorId) */
  const isOwner = req.user && (
    (bill.id_actor && bill.id_actor.toString() === req.user._id) ||
    (bill.email    && bill.email === req.user.email)
  );
  if (!isOwner && !isAdminReq(req))
    return res.status(403).json({ message: 'Forbidden' });

  /* Create PDF --------------------------------------------------------- */
  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt_${billId}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  /* Header */
  doc.fontSize(20).text('Payment Receipt', { align: 'center' }).moveDown();
  doc.fontSize(12)
     .text(`Bill ID : ${bill._id}`)
     .text(`Date    : ${bill.paidAt ? new Date(bill.paidAt).toLocaleString() : new Date().toLocaleString()}`)
     .text(`Event   : ${bill.id_event?.title || bill.id_event}`)
     .moveDown();

  /* Table */
  doc.text(`Subtotal : ${bill.subtotal.toFixed(2)} ${bill.currency}`);
  doc.text(`Tax (${(bill.taxRate*100).toFixed(2)}%) : ${(bill.subtotal*bill.taxRate).toFixed(2)} ${bill.currency}`);
  doc.text(`Discount : ${bill.discount.toFixed(2)} ${bill.currency}`);
  doc.moveDown();
  doc.fontSize(14).text(`TOTAL : ${bill.total.toFixed(2)} ${bill.currency}`, { align: 'right' });
  doc.moveDown();

  doc.fontSize(12).text(`Status : ${bill.status}`);
  doc.text(`Payment Method : ${bill.method}`);
  doc.text(`Gateway Ref    : ${bill.gatewayRef}`);

  doc.moveDown(2).fontSize(10).text('Thank you for your purchase!', { align: 'center' });

  doc.end(); // PDFKit streams automatically
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 9 / N) ────────────────────────────────────────────────────────────────
 *
 *  ANALYTICS ENDPOINTS  (admin only)
 *  ─────────────────────────────────
 *   • getDailyRevenueTrend   – GET /events/:eventId/analytics/revenue?days=30
 *   • getTicketTypeBreakdown – GET /events/:eventId/analytics/tickets
 *
 *  Both endpoints:
 *     – use MongoDB aggregation for efficiency
 *     – cache results 2 min via Redis
 **************************************************************************************************/

const DAY_MS     = 86_400_000;
const CACHE_2M   = 120;        // seconds
const TICKET_SET = ['silver', 'gold', 'vip', 'refunded'];

/*──────────────────────── 1️⃣  Revenue trend (last N days) ───────────*/
/**
 * Example:  GET /events/123/analytics/revenue?days=14
 * Response: { labels:["2025-08-01","08-02",…], values:[123,98,…], currency:"USD" }
 */
exports.getDailyRevenueTrend = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);

  const cacheKey = `revTrend:${eventId}:${days}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return res.json({ success:true, data:cached });

  const startDate = new Date(Date.now() - (days - 1) * DAY_MS);
  const bills = await EventBill.aggregate([
    { $match: { id_event: toId(eventId), status:'paid', paidAt:{ $gte:startDate } } },
    { $group: {
        _id: { $dateToString:{ format:'%Y-%m-%d', date:'$paidAt' } },
        revenue: { $sum:'$total' },
        currency:{ $first:'$currency' }
      }},
    { $sort: { _id:1 } }
  ]);

  /* Build zero-filled series */
  const labels = [];
  const values = [];
  for (let i=days-1;i>=0;i--) {
    const d = new Date(Date.now() - i*DAY_MS);
    const key = d.toISOString().substring(0,10);
    labels.push(key);
    const hit = bills.find(b => b._id === key);
    values.push(hit ? hit.revenue : 0);
  }

  const payload = { labels, values, currency: bills[0]?.currency || 'USD' };
  await cacheSet(cacheKey, payload, CACHE_2M);
  res.json({ success:true, data:payload });
});

/*──────────────────────── 2️⃣  Ticket type breakdown ─────────────────*/
/**
 * GET /events/:eventId/analytics/tickets
 * Response: { silver:120, gold:34, vip:9, refunded:3 }
 */
exports.getTicketTypeBreakdown = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message: 'Admin only' });

  const { eventId } = req.params;
  const cacheKey = `ticketBreak:${eventId}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return res.json({ success:true, data:cached });

  const agg = await EventTicket.aggregate([
    { $match: { id_event: toId(eventId) } },
    { $group: { _id:'$ticketType', count:{ $sum:1 } } }
  ]);

  const out = Object.fromEntries(TICKET_SET.map(t => [t,0]));
  agg.forEach(row => { out[row._id] = row.count; });

  await cacheSet(cacheKey, out, CACHE_2M);
  res.json({ success:true, data:out });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 10 / N) ───────────────────────────────────────────────────────────────
 *
 *  LIFE-CYCLE  (admin-only)
 *  ──────────────────────────────────────────────────────────────────────────
 *   1. publishEvent        – PATCH /events/:eventId/publish     (bool)
 *   2. duplicateEvent      – POST  /events/:eventId/duplicate   (returns new ID)
 *   3. cascadeDeleteEvent  – DELETE/patch /events/:eventId      (removes event + children)
 *
 *   • All children collections are included in clone / delete.
 *   • Duplicate resets seats, tickets, bills, gallery stats, etc.
 **************************************************************************************************/

/* Child model list reused in multiple functions */
const CHILD_MODELS = {
  organizers : Organizer,
  impacts    : Impact,
  features   : Feature,
  gallery    : Gallery,
  schedule   : Schedule,
  comments   : Comment,
  bills      : EventBill,
  tickets    : EventTicket
};

/*──────────────────────── 1️⃣  Publish / Unpublish ───────────────────*/
/**
 * PATCH body: { published:true|false }
 * Adds published flag to Event doc (default false) so public routes can hide drafts.
 */
exports.publishEvent = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  const { published } = req.body;
  if (typeof published !== 'boolean')
    return res.status(400).json({ message:'published must be boolean' });

  const ev = await Event.findByIdAndUpdate(eventId, { published }, { new:true }).lean();
  if (!ev) return res.status(404).json({ message:'Event not found' });

  /* Bust event cache (Part 1 + 6) */
  await cacheSet(`eventFull:${eventId}`, null, 1);
  await cacheSet(`pubSchedule:${eventId}`, null, 1);

  res.json({ success:true, data:{ _id:ev._id, published:ev.published } });
});

/*──────────────────────── 2️⃣  Deep duplicate ─────────────────────────*/
/**
 * Creates a *new* event document and clones all child docs, adjusting
 * ids + resetting counts. Used for “copy last year’s event”.
 */
exports.duplicateEvent = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  const src = await Event.findById(eventId).lean();
  if (!src) return res.status(404).json({ message:'Event not found' });

  /* 1. Clone Event base ------------------------------------------------- */
  const { _id, createdAt, updatedAt, seatsTaken, ...props } = src;
  props.title += ' (Copy)';
  props.published = false;
  props.seatsTaken = 0;
  const newEvent = await Event.create(props);

  /* 2. Clone children in parallel -------------------------------------- */
  const tasks = Object.entries(CHILD_MODELS).map(async ([key, Model]) => {
    const docs = await Model.find({ id_event:eventId }).lean();
    if (!docs.length) return;
    const clones = docs.map(d => {
      const { _id, createdAt, updatedAt, ...rest } = d;
      return { ...rest, id_event:newEvent._id };
    });
    return Model.insertMany(clones);
  });
  await Promise.all(tasks);

  res.status(201).json({ success:true, newEventId:newEvent._id });
});

/*──────────────────────── 3️⃣  Cascade delete ─────────────────────────*/
/**
 * *Danger zone* – removes event and ALL references. Requires “superadmin”
 * role or a confirm=true query param.
 */
exports.cascadeDeleteEvent = asyncHandler(async (req, res) => {
  const userIsSuper = req.user && req.user.role === 'superadmin';
  const confirmed   = req.query.confirm === 'true';
  if (!userIsSuper && !confirmed)
    return res.status(400).json({ message:'Must confirm=true or be superadmin' });

  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message:'Bad eventId' });

  const ev = await Event.findByIdAndDelete(eventId).lean();
  if (!ev) return res.status(404).json({ message:'Event not found' });

  /* Remove children */
  const deletions = Object.values(CHILD_MODELS).map(M =>
    M.deleteMany({ id_event:eventId })
  );
  await Promise.all(deletions);

  /* Clean caches */
  const keys = await redis?.keys(`*:${eventId}*`) || [];
  if (keys.length) await redis.del(keys);

  res.json({ success:true, message:'Event and all related data removed.' });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 11 / N)
 *  ------------------------------------------------------------------
 *  PUBLIC SEARCH ENDPOINT
 *  ----------------------
 *  GET  /events/:eventId/search?q=ai&scope=schedule,gallery&limit=15
 *
 *  • Uses MongoDB Atlas $search if available; falls back to normal text
 *    index (`text: { $search: q }`) when run on Community edition.
 *  • Scopes: schedule | gallery | features | impacts  (default “all”)
 *  • Returns array of { type, _id, score, snippet, extra }
 *
 **************************************************************************************************/

/* Identify whether $search is available once at startup */
let atlasSearchOK = true;
(async () => {
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    /* try a dummy $search stage; if it errors, disable */
    await Schedule.aggregate([{ $search: { text:{ query:'test', path:'sessionTitle' } } }]).limit(1);
  } catch { atlasSearchOK = false; }
})();

const SCOPE_MAP = {
  schedule: { model: Schedule, fields:['sessionTitle','room'] },
  gallery : { model: Gallery,  fields:['title'] },
  features: { model: Feature,  fields:['title','subtitle','desc'] },
  impacts : { model: Impact,   fields:['title','description'] }
};

function buildSearchPipeline(q, fields) {
  return [
    { $search: { text:{ query:q, path:fields } } },
    { $addFields: { score: { $meta:'searchScore' } } }
  ];
}

exports.searchEventContent = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { q = '', scope = 'all', limit = 20 } = req.query;
  const LIM = Math.min(Number(limit) || 20, 50);
  if (!q.trim()) return res.status(400).json({ message:'q required' });

  const scopes = scope === 'all' ? Object.keys(SCOPE_MAP) : scope.split(',').map(s=>s.trim());
  const tasks = scopes.map(async key => {
    const conf = SCOPE_MAP[key];
    if (!conf) return [];

    if (atlasSearchOK) {
      /* Atlas full-text pipeline */
      return conf.model.aggregate([
        { $match: { id_event: toId(eventId) } },
        ...buildSearchPipeline(q, conf.fields),
        { $limit: LIM },
        { $project:{ snippet: { $substrCP:[conf.fields[0],0,120] }, extra:1, score:1 } }
      ]).lean().then(rows => rows.map(r => ({ type:key, ...r })));
    } else {
      /* Fallback classic $text */
      return conf.model.find(
        { id_event:eventId, $text:{ $search:q } },
        { score:{ $meta:'textScore' }, snippet:1, extra:1 }
      )
      .sort({ score:{ $meta:'textScore' } })
      .limit(LIM)
      .lean()
      .then(rows => rows.map(r => ({ type:key, ...r })));
    }
  });

  const resultsNested = await Promise.all(tasks);
  /* Flatten + top-score sort */
  const flat = resultsNested.flat().sort((a,b)=>b.score - a.score).slice(0,LIM);
  res.json({ success:true, count:flat.length, data:flat });
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 12 / N) ───────────────────────────────────────────────────────────────
 *
 *  AUDIT LOG
 *  ─────────
 *  1. logAction middleware  – call inside any admin route to persist an event.
 *  2. listAuditLogs         – GET  /events/:eventId/audit?actor=123&action=delete&page=1
 *  3. exportAuditCSV        – GET  /events/:eventId/audit/export.csv
 *
 *  Model (simple):
 *     {
 *       _id, id_event, actorId, actorRole, action, target, payload, ip, ua,
 *       createdAt
 *     }
 *
 *  NOTE: Attach `logAction(req, { action:'delete', target:'feature', targetId })`
 *        just before sending your success response in admin controllers.
 **************************************************************************************************/

const Audit = mongoose.model('eventAudit',
  new mongoose.Schema({
    id_event   : { type: mongoose.Schema.Types.ObjectId, ref:'event', index:true },
    actorId    : { type: mongoose.Schema.Types.ObjectId },
    actorRole  : String,
    action     : String,              // e.g. 'create','update','delete','publish'
    target     : String,              // collection name
    targetId   : mongoose.Schema.Types.ObjectId,
    payload    : Object,              // optional diff / fields
    ip         : String,
    ua         : String,
    createdAt  : { type:Date, default:Date.now }
  }, { versionKey:false })
);

/*──────────────────────── 1️⃣  logAction helper ──────────────────────*/
exports.logAction = async (req, details) => {
  try {
    await Audit.create({
      id_event : details.id_event || req.params.eventId,
      actorId  : req.user?._id,
      actorRole: req.user?.role,
      action   : details.action,
      target   : details.target,
      targetId : details.targetId,
      payload  : details.payload,
      ip       : req.ip,
      ua       : req.headers['user-agent']
    });
  } catch (err) {
    console.error('Audit log insert failed', err);
  }
};

/*──────────────────────── 2️⃣  listAuditLogs (admin) ─────────────────*/
exports.listAuditLogs = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  const { actor, action, target, page=1, limit=40 } = req.query;
  const q = { id_event:eventId };
  if (actor)  q.actorId  = actor;
  if (action) q.action   = action;
  if (target) q.target   = target;

  const [rows, total] = await Promise.all([
    Audit.find(q)
         .sort({ createdAt:-1 })
         .skip((page-1)*limit)
         .limit(Number(limit))
         .lean(),
    Audit.countDocuments(q)
  ]);

  res.json({ success:true, page:Number(page), pages:Math.ceil(total/limit), count:rows.length, data:rows });
});

/*──────────────────────── 3️⃣  exportAuditCSV (admin) ────────────────*/
exports.exportAuditCSV = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  const logs = await Audit.find({ id_event:eventId }).lean();

  const csv = new Parser({
    fields:[
      { label:'Time',      value: row => new Date(row.createdAt).toISOString() },
      { label:'Actor ID',  value:'actorId' },
      { label:'Role',      value:'actorRole' },
      { label:'Action',    value:'action' },
      { label:'Target',    value:'target' },
      { label:'Target ID', value:'targetId' },
      { label:'Payload',   value: row => JSON.stringify(row.payload) },
      { label:'IP',        value:'ip' }
    ]
  }).parse(logs);

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="audit_${eventId}.csv"`);
  res.status(200).send(csv);
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 13 / N) ────────────────────────────────────────────────────────────────
 *
 *  LIVE OPERATIONS
 *  ───────────────
 *   1. checkInTicket         – POST /tickets/:ticketId/checkin         (staff / admin)
 *      • Verifies ticket belongs to event and isn’t already used.
 *      • Marks as checked-in and bumps seatsTaken.
 *      • Emits “checkin” and “stats” events on Socket.IO room `event:<id>`.
 *
 *   2. sseLiveStats          – GET  /events/:eventId/live-stats        (dashboard widget)
 *      • Server-Sent Events stream: first chunk = current stats,
 *        subsequent chunks whenever “stats” is published by check-ins or refunds.
 *
 *  Requires:
 *     • Socket.IO server instance attached to `app.locals.io`
 *     • `initLiveSockets(app)` exported to hook rooms on server bootstrap.
 **************************************************************************************************/

const { logAction } = require('./eventController');  // Part 12 helper

/*──────────────────────── 1️⃣  Check-in endpoint ─────────────────────*/
exports.checkInTicket = asyncHandler(async (req, res) => {
  const { ticketId } = req.params;
  if (!mongoose.isValidObjectId(ticketId))
    return res.status(400).json({ message:'Bad ticketId' });

  const ticket = await EventTicket.findById(ticketId).exec();
  if (!ticket)  return res.status(404).json({ message:'Ticket not found' });
  if (ticket.checkedIn) return res.status(409).json({ message:'Already checked-in' });

  /* Gate: allow admin or staff role; staff = exhibitor or custom role */
  if (!req.user || !['admin','staff'].includes(req.user.role))
    return res.status(403).json({ message:'Insufficient rights' });

  /* Mark checked-in */
  ticket.checkedIn   = true;
  ticket.checkedInAt = new Date();
  await ticket.save();

  await Event.updateOne({ _id: ticket.id_event }, { $inc:{ seatsTaken:1 } }).exec();

  /* Audit log */
  await logAction(req, {
    action  :'checkin',
    target  :'ticket',
    targetId: ticketId,
    id_event: ticket.id_event
  });

  /* Emit real-time events */
  const io = req.app.locals.io;
  if (io) {
    io.to(`event:${ticket.id_event}`).emit('checkin', {
      ticketId,
      actorId : ticket.id_actor,
      when    : ticket.checkedInAt
    });
    /* also push updated stats */
    const seatsTaken = await Event.findById(ticket.id_event).select('seatsTaken').lean();
    io.to(`event:${ticket.id_event}`).emit('stats', { seatsTaken: seatsTaken.seatsTaken });
  }

  res.json({ success:true, message:'Checked-in', data:{ ticketId } });
});

/*──────────────────────── 2️⃣  Server-Sent Events stream ─────────────*/
exports.sseLiveStats = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message:'Bad eventId' });

  /* Initial headers for SSE */
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();

  /* Send current stats once */
  const ev = await Event.findById(eventId).select('seatsTaken capacity').lean();
  const init = { seatsTaken: ev?.seatsTaken || 0, capacity: ev?.capacity || null };
  res.write(`event: stats\ndata: ${JSON.stringify(init)}\n\n`);

  /* Subscription via Socket.IO adapter ---------------------------------*/
  const io = req.app.locals.io;
  if (!io) return res.end();   // socket server not mounted

  const nsp  = io.of('/');
  const cb   = data => res.write(`event: stats\ndata: ${JSON.stringify(data)}\n\n`);
  nsp.to(`event:${eventId}`).on('stats', cb);

  req.on('close', () => {
    nsp.to(`event:${eventId}`).off('stats', cb);
    res.end();
  });
});

/*──────────────────────── 3️⃣  Socket.IO room helper ──────────────────*/
exports.initLiveSockets = (app) => {
  const io = app.locals.io;
  if (!io) return;

  io.on('connection', socket => {
    socket.on('joinEventRoom', eventId => {
      if (mongoose.isValidObjectId(eventId))
        socket.join(`event:${eventId}`);
    });
    socket.on('leaveEventRoom', eventId => {
      socket.leave(`event:${eventId}`);
    });
  });
};
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 14 / N) ───────────────────────────────────────────────────────────────
 *
 *  PROMO CODES
 *  ───────────
 *   Data Model (models/eventPromo.js):
 *     {
 *       _id, id_event, code, discountType:'percent'|'flat',
 *       amount, usageLimit, used:0, validFrom, validTo,
 *       ticketTypes:['silver','vip'…] (empty = any), createdAt
 *     }
 *
 *   Endpoints (admin):
 *     • listPromos        – GET    /events/:eventId/promos
 *     • createPromo       – POST   /events/:eventId/promos
 *     • updatePromo       – PATCH  /events/:eventId/promos/:promoId
 *     • deletePromo       – DELETE /events/:eventId/promos/:promoId
 *
 *   Public helper used by initPurchase (Part 1):
 *     • applyPromo(code, eventId, ticketType) → { ok, discount }
 **************************************************************************************************/

/*──────────────────────── Model declaration ─────────────────────────*/
const Promo = mongoose.model('eventPromo',
  new mongoose.Schema({
    id_event     : { type:mongoose.Schema.Types.ObjectId, ref:'event', index:true },
    code         : { type:String, uppercase:true, unique:true },
    discountType : { type:String, enum:['percent','flat'], default:'percent' },
    amount       : { type:Number, required:true, min:0 },
    usageLimit   : { type:Number, default:0 },    // 0 = unlimited
    used         : { type:Number, default:0 },
    ticketTypes  : { type:[String], default:[] }, // empty = all
    validFrom    : { type:Date, default:Date.now },
    validTo      : { type:Date },
    createdAt    : { type:Date, default:Date.now }
  }, { versionKey:false })
);

/*──────────────────────── Public applyPromo helper ──────────────────*/
/**
 *  Returns { ok:false,msg } OR { ok:true, discount } where discount is
 *  an object: { discountType, amount } ready for price calc.
 */
exports.applyPromo = async (code, eventId, ticketType) => {
  if (!code) return { ok:false, msg:'No code' };
  const promo = await Promo.findOne({ code:code.toUpperCase(), id_event:eventId }).lean();
  if (!promo) return { ok:false, msg:'Invalid code' };

  const now = Date.now();
  if (promo.validFrom && now < promo.validFrom)   return { ok:false, msg:'Not active yet' };
  if (promo.validTo   && now > promo.validTo)     return { ok:false, msg:'Code expired' };
  if (promo.usageLimit && promo.used >= promo.usageLimit)
                                                    return { ok:false, msg:'Code exhausted' };
  if (promo.ticketTypes.length && !promo.ticketTypes.includes(ticketType))
                                                    return { ok:false, msg:'Not valid for this ticket' };

  return { ok:true, discount:{ discountType:promo.discountType, amount:promo.amount }, _id:promo._id };
};

/* Call this in Part 1 after price calc: */
/*
  const promoRes = await applyPromo(promoCode, eventId, ticketType);
  if (promoRes.ok) {
    if (promoRes.discount.discountType==='flat')   discount = promoRes.discount.amount;
    else                                          discount = subtotal * (promoRes.discount.amount/100);
    await Promo.updateOne({ _id:promoRes._id }, { $inc:{ used:1 } });
  }
*/

/*──────────────────────── Admin list promos ─────────────────────────*/
exports.listPromos = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({message:'Admin only'});
  const rows = await Promo.find({ id_event:req.params.eventId }).lean();
  res.json({ success:true, count:rows.length, data:rows });
});

/*──────────────────────── Admin create promo ────────────────────────*/
exports.createPromo = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({message:'Admin only'});
  const { code, discountType='percent', amount, usageLimit=0, validFrom, validTo, ticketTypes=[] } = req.body;
  if (!code || !amount) return res.status(400).json({message:'code and amount required'});
  const doc = await Promo.create({
    id_event:req.params.eventId, code:code.toUpperCase(), discountType, amount,
    usageLimit, validFrom, validTo, ticketTypes
  });
  res.status(201).json({ success:true, data:doc });
});

/*──────────────────────── Admin update promo ────────────────────────*/
exports.updatePromo = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({message:'Admin only'});
  const { promoId } = req.params;
  const update = { ...req.body, updatedAt:Date.now() };
  if (update.code) update.code = update.code.toUpperCase();
  const doc = await Promo.findByIdAndUpdate(promoId, update, {new:true}).lean();
  if (!doc) return res.status(404).json({message:'Promo not found'});
  res.json({ success:true, data:doc });
});

/*──────────────────────── Admin delete promo ────────────────────────*/
exports.deletePromo = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({message:'Admin only'});
  const { promoId } = req.params;
  const out = await Promo.findByIdAndDelete(promoId).lean();
  if (!out) return res.status(404).json({message:'Promo not found'});
  res.json({ success:true, message:'Promo deleted'});
});
/***************************************************************************************************
 *  EVENT CONTROLLER  (PART 15 / N) ───────────────────────────────────────────────────────────────
 *
 *  REMINDER ENGINE
 *  ───────────────
 *  1. scheduleEventReminders   – POST  /events/:eventId/reminders
 *       Body: { hoursBefore:24 } → creates a reminder job.
 *  2. listScheduledReminders   – GET   /events/:eventId/reminders
 *       Returns all future jobs for the event.
 *  3. cancelReminder           – DELETE /events/:eventId/reminders/:jobId
 *
 *  Background job runner (agenda.js) is initialised via initReminderEngine(app).
 *  At runtime, each job queries tickets for that event and fires transactional
 *  e-mails using utils/mailer.
 *
 *  ENV:
 *     REMINDER_DB_URI (optional, defaults to same Mongo)
 **************************************************************************************************/

const Agenda   = require('agenda');

const REMIND_JOB = 'event:sendReminder';
let   agenda;                   // will hold Agenda instance

/*──────────────────────── 0️⃣  Init – called from server.js ──────────*/
exports.initReminderEngine = (app) => {
  agenda = new Agenda({
    db: { address: process.env.REMINDER_DB_URI || process.env.MONGO_URI, collection:'agendaJobs' }
  });
  /* Define the job behaviour once */
  agenda.define(REMIND_JOB, async job => {
    const { eventId, hrs } = job.attrs.data;
    const ev  = await Event.findById(eventId).lean();
    if (!ev) return job.remove();

    const tickets = await EventTicket.find({ id_event:eventId }).populate('id_actor').lean();
    const whenStr = new Date(ev.startDate || ev.createdAt).toLocaleString();

    await Promise.all(tickets.map(t => sendMail(
      t.id_actor?.email,
      `Reminder: ${ev.title}`,
      `<p>This is a reminder that <strong>${ev.title}</strong> starts on ${whenStr}.</p>
       <p>We’ll see you there! 🎉</p>`
    )));
  });

  agenda.on('ready', () => agenda.start());
  app.locals.agenda = agenda;
};

/* Helper to build job name */
const jobName = (eventId, hrs) => `${eventId}:${hrs}`;

/*──────────────────────── 1️⃣  scheduleEventReminders ───────────────*/
exports.scheduleEventReminders = asyncHandler(async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  const { hoursBefore = 24 } = req.body;
  if (hoursBefore < 1 || hoursBefore > 168)
    return res.status(400).json({ message:'hoursBefore 1-168' });

  const ev = await Event.findById(eventId).lean();
  if (!ev || !ev.startDate)
    return res.status(400).json({ message:'Event startDate required' });

  const fireAt = new Date(ev.startDate - hoursBefore*60*60*1000);
  if (fireAt < Date.now())
    return res.status(400).json({ message:'Time already passed' });

  /* Remove existing job with same offset */
  await agenda.cancel({ name:REMIND_JOB, 'data.eventId':eventId, 'data.hrs':hoursBefore });

  /* Schedule new */
  const j = agenda.create(REMIND_JOB, { eventId, hrs:hoursBefore });
  j.unique({ 'data.eventId':eventId, 'data.hrs':hoursBefore });
  j.schedule(fireAt);
  await j.save();

  res.status(201).json({ success:true, jobId:j.attrs._id, runAt:fireAt });
});

/*──────────────────────── 2️⃣  listScheduledReminders ───────────────*/
exports.listScheduledReminders = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });
  const { eventId } = req.params;

  const jobs = await agenda.jobs({ name:REMIND_JOB, 'data.eventId':eventId });
  const rows = jobs.map(j => ({
    jobId  : j.attrs._id,
    runAt  : j.attrs.nextRunAt,
    hoursBefore: j.attrs.data.hrs
  }));

  res.json({ success:true, count:rows.length, data:rows });
});

/*──────────────────────── 3️⃣  cancelReminder ───────────────────────*/
exports.cancelReminder = asyncHandler(async (req,res)=>{
  if (!isAdminReq(req)) return res.status(403).json({ message:'Admin only' });
  const { jobId } = req.params;

  const num = await agenda.cancel({ _id:mongoose.Types.ObjectId(jobId) });
  if (num === 0) return res.status(404).json({ message:'Job not found' });

  res.json({ success:true, removed:num });
});

exports.getEventMini= asyncHandler(async (req, res) => {
  const {eventId} = req.body;
  console.log(eventId);
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Invalid eventId' });

  const event = await Event.findById(eventId).lean();
  if (!event) return res.status(404).json({ message: 'Event not found here' });

  res.json({ success: true, data: event });
});
