// controllers/community.controller.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Attendee = require('../models/attendee');
const Speaker  = require('../models/speaker');

const toStr = v => (typeof v === 'string' ? v : '');
const esc   = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rxEq  = v => new RegExp(`^${esc(String(v))}$`, 'i');
const toNum = (v,d=0) => (Number.isFinite(+v) ? +v : d);

/* ────────────────────────────────────────────────────────────────────
 * FACETS: actorType list + countries list (by event, optional)
 * GET /community/facets?eventId=<id>
 * ──────────────────────────────────────────────────────────────────── */
exports.getCommunityFacets = asyncHandler(async (req, res) => {
  const eventId = toStr(req.query.eventId);
  const matchEv = (id) => (mongoose.isValidObjectId(id) ? { id_event: new mongoose.Types.ObjectId(id) } : {});

  // Build small aggregations on both collections
  const [attTypes, spkTypes, attCountries, spkCountries] = await Promise.all([
    Attendee.aggregate([
      { $match: matchEv(eventId) },
      { $match: { actorType: { $ne: "" } } },
      { $group: { _id: "$actorType", c: { $sum: 1 } } },
      { $sort: { c: -1, _id: 1 } }
    ]),
    Speaker.aggregate([
      { $match: matchEv(eventId) },
      { $match: { actorType: { $ne: "" } } },
      { $group: { _id: "$actorType", c: { $sum: 1 } } },
      { $sort: { c: -1, _id: 1 } }
    ]),
    Attendee.aggregate([
      { $match: matchEv(eventId) },
      { $group: { _id: "$personal.country", c: { $sum: 1 } } },
      { $sort: { c: -1, _id: 1 } }
    ]),
    Speaker.aggregate([
      { $match: matchEv(eventId) },
      { $group: { _id: "$personal.country", c: { $sum: 1 } } },
      { $sort: { c: -1, _id: 1 } }
    ]),
  ]);

  // merge counts from both models
  const mergeCounts = (a, b) => {
    const map = new Map();
    for (const r of a) { map.set(r._id, (map.get(r._id)||0) + r.c); }
    for (const r of b) { map.set(r._id, (map.get(r._id)||0) + r.c); }
    return [...map.entries()].map(([k,v]) => ({ name: k || '', count: v })).sort((x,y)=>y.count-x.count);
  };

  res.json({
    success: true,
    types: mergeCounts(attTypes, spkTypes),
    countries: mergeCounts(attCountries, spkCountries).map(x => ({ code: (x.name||'').toUpperCase(), count: x.count }))
  });
});

/* ────────────────────────────────────────────────────────────────────
 * LIST: members with filters and pagination
 * GET /community/list?eventId=&actorType=&country=&q=&page=1&limit=24
 * ──────────────────────────────────────────────────────────────────── */
exports.getCommunityList = asyncHandler(async (req, res) => {
  const eventId   = toStr(req.query.eventId);
  const actorType = toStr(req.query.actorType);         // optional
  const country   = toStr(req.query.country);           // ISO2
  const q         = toStr(req.query.q);
  const page      = Math.max(1, toNum(req.query.page, 1));
  const limit     = Math.max(1, Math.min(100, toNum(req.query.limit, 24)));
  const skip      = Math.max(0, (page-1)*limit);

  const baseAtt = mongoose.isValidObjectId(eventId) ? { id_event: new mongoose.Types.ObjectId(eventId) } : {};
  const baseSpk = mongoose.isValidObjectId(eventId) ? { id_event: new mongoose.Types.ObjectId(eventId) } : {};

  // Build model-specific filters
  const attQ = { ...baseAtt };
  const spkQ = { ...baseSpk };
  if (actorType) { attQ.actorType = rxEq(actorType); spkQ.actorType = rxEq(actorType); }
  if (country)   { attQ['personal.country'] = rxEq(country); spkQ['personal.country'] = rxEq(country); }
  if (q) {
    const r = new RegExp(esc(q), 'i');
    Object.assign(attQ, { $or: [
      { 'personal.fullName': r }, { 'organization.orgName': r }
    ]});
    Object.assign(spkQ, { $or: [
      { 'personal.fullName': r }, { 'organization.orgName': r }
    ]});
  }

  // Fetch both in parallel then merge + sort by name
  const [attList, spkList, attCnt, spkCnt] = await Promise.all([
    Attendee.find(attQ).select('actorType personal.fullName personal.profilePic personal.country organization.orgName links').skip(skip).limit(limit).lean(),
    Speaker.find(spkQ).select('actorType personal.fullName personal.profilePic personal.country organization.orgName enrichments').skip(skip).limit(limit).lean(),
    Attendee.countDocuments(attQ),
    Speaker.countDocuments(spkQ),
  ]);

  const mapAtt = a => ({
    id: String(a._id),
    kind: 'attendee',
    actorType: a.actorType || '',
    fullName: a?.personal?.fullName || '',
    country: (a?.personal?.country||'').toUpperCase(),
    avatar: a?.personal?.profilePic || null,
    orgName: a?.organization?.orgName || '',
    website: a?.links?.website || '',
    linkedin: a?.links?.linkedin || ''
  });

  const mapSpk = s => ({
    id: String(s._id),
    kind: 'speaker',
    actorType: s.actorType || '',
    fullName: s?.personal?.fullName || '',
    country: (s?.personal?.country||'').toUpperCase(),
    avatar: s?.personal?.profilePic || null,
    orgName: s?.organization?.orgName || '',
    website: s?.organization?.orgWebsite || '',
    linkedin: (Array.isArray(s?.enrichments?.socialLinks) ? s.enrichments.socialLinks[0] : '') || ''
  });

  const items = [...attList.map(mapAtt), ...spkList.map(mapSpk)]
    .sort((a,b)=>a.fullName.localeCompare(b.fullName));

  res.json({
    success: true,
    total: attCnt + spkCnt,
    items
  });
});
