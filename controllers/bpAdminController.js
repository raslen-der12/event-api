// controllers/bpAdminController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const BPAuditLog = require('../models/BPAuditLog');
const { paginate, toLimit, makeRx, isId, cleanStr } = require('../utils/bpUtil');

const mustAdmin = (req) => !!req.user?.isAdmin;

// GET /admin/bp/queue
exports.queue = asyncHdl(async (req, res) => {
  if (!mustAdmin(req)) return res.status(403).json({ message: 'Forbidden' });
  const { limit=40 } = req.query || {};

  const profiles = await BusinessProfile.find({ published: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(toLimit(limit, 40))
    .select('name owner createdAt published')
    .lean();

  const items = await BPItem.find({ published: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(toLimit(limit, 40))
    .select('kind title profile createdAt published')
    .lean();

  res.json({ ok: true, unpublished: { profiles, items } });
});

// PATCH /admin/bp/:id/publish
exports.setProfilePublished = asyncHdl(async (req, res) => {
  if (!mustAdmin(req)) return res.status(403).json({ message: 'Forbidden' });
  const { id } = req.params; const { published=true } = req.body || {};
  const p = await BusinessProfile.findByIdAndUpdate(id, { $set: { published: !!published } }, { new: true }).lean();
  if (!p) return res.status(404).json({ message: 'Not found' });
  res.json({ ok: true, published: p.published });
});

// PATCH /admin/bp/items/:itemId/hide
exports.hideItem = asyncHdl(async (req, res) => {
  if (!mustAdmin(req)) return res.status(403).json({ message: 'Forbidden' });
  const { itemId } = req.params; const { hidden=true, reason='' } = req.body || {};
  const it = await BPItem.findByIdAndUpdate(itemId, { $set: { 'adminFlags.hidden': !!hidden, 'adminFlags.reason': reason } }, { new: true }).lean();
  if (!it) return res.status(404).json({ message: 'Not found' });
  res.json({ ok: true, hidden: !!it.adminFlags?.hidden });
});
const ensureAdmin = (req) => {
  if (!req.user || !['admin','superadmin'].includes(String(req.user.role || '').toLowerCase())) {
    const err = new Error('Forbidden'); err.status = 403; throw err;
  }
};

// GET /admin/bp/profiles?q=&eventId=&role=&published=&featured=&page=&limit=&sort=
exports.adminListProfiles = asyncHdl(async (req, res) => {
  ensureAdmin(req);

  const { q='', eventId='', role='', published='', featured='', sort='new' } = req.query || {};
  const { page, limit, skip } = paginate(req.query.page, req.query.limit, 200);

  const qry = {};
  if (q.trim()) {
    const rx = makeRx(q);
    qry.$or = [{ name: rx }, { tagline: rx }, { about: rx }, { slug: rx }, { industries: rx }];
  }
  if (isId(eventId)) qry.event = eventId;
  if (role) qry['owner.role'] = String(role).toLowerCase();                 // attendee/exhibitor/speaker/... (not student)
  if (published) qry.published = ['1','true','yes'].includes(String(published).toLowerCase());
  if (featured) qry.featured = ['1','true','yes'].includes(String(featured).toLowerCase());

  let sortSpec = { createdAt: -1 };
  if (sort === 'popular') sortSpec = { 'stats.views': -1, 'stats.likes': -1 };
  if (sort === 'name') sortSpec = { name: 1 };

  const [rows, total] = await Promise.all([
    BusinessProfile.find(qry)
      .select('name slug owner role event published featured stats industries countries languages logoUpload createdAt updatedAt')
      .sort(sortSpec).skip(skip).limit(limit).lean(),
    BusinessProfile.countDocuments(qry)
  ]);

  res.json({ ok:true, page, perPage: limit, total, data: rows });
});

// GET /admin/bp/profile/:id
exports.adminGetProfile = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const { id } = req.params || {};
  if (!isId(id)) return res.status(400).json({ message: 'Bad id' });

  const [p, items] = await Promise.all([
    BusinessProfile.findById(id).lean(),
    BPItem.find({ profile: id }).sort({ createdAt: -1 }).lean()
  ]);
  if (!p) return res.status(404).json({ message: 'Not found' });

  res.json({ ok:true, profile: p, items });
});

// PATCH /admin/bp/profile/:id/moderate
// body: { publish?:bool, feature?:bool, note?:string }
exports.adminModerateProfile = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const { id } = req.params || {};
  if (!isId(id)) return res.status(400).json({ message: 'Bad id' });

  const patch = {};
  if (typeof req.body.publish === 'boolean') patch.published = !!req.body.publish;
  if (typeof req.body.feature === 'boolean') patch.featured  = !!req.body.feature;

  if (!Object.keys(patch).length) return res.status(400).json({ message: 'Nothing to change' });

  const before = await BusinessProfile.findById(id).select('published featured').lean();
  const after  = await BusinessProfile.findByIdAndUpdate(
    id, { $set: patch, $currentDate: { updatedAt: true } }, { new: true }
  ).lean();

  await BPAuditLog.create({
    actorId: req.user._id,
    actorRole: 'admin',
    target: { kind: 'profile', id: id },
    action: 'moderate-profile',
    diff: { before, after },
    note: cleanStr(req.body?.note || '')
  });

  res.json({ ok:true, data: after });
});

// PATCH /admin/bp/profile/:id/owner-role
// body: { role: 'exhibitor'|'attendee'|'speaker'|'expert'|'investor'|'employee'|'consultant'|'businessowner' }
exports.adminChangeOwnerRole = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const { id } = req.params || {};
  const role = String(req.body?.role || '').toLowerCase();
  const allowed = ['attendee','exhibitor','speaker','expert','investor','employee','consultant','businessowner'];
  if (!isId(id)) return res.status(400).json({ message: 'Bad id' });
  if (!allowed.includes(role)) return res.status(400).json({ message: 'Bad role' });

  const before = await BusinessProfile.findById(id).select('owner').lean();
  const after  = await BusinessProfile.findByIdAndUpdate(
    id, { $set: { 'owner.role': role } , $currentDate: { updatedAt: true } }, { new: true }
  ).lean();

  await BPAuditLog.create({
    actorId: req.user._id, actorRole:'admin',
    target: { kind:'profile', id },
    action: 'change-owner-role',
    diff: { before: before?.owner, after: after?.owner }
  });

  res.json({ ok:true, data: after });
});

// PATCH /admin/bp/items/:itemId/moderate
// body: { hide?:bool, publish?:bool, note?:string }
exports.adminModerateItem = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const { itemId } = req.params || {};
  if (!isId(itemId)) return res.status(400).json({ message: 'Bad id' });

  const patch = {};
  if (typeof req.body.publish === 'boolean') patch.published = !!req.body.publish;
  if (typeof req.body.hide === 'boolean') patch['adminFlags.hidden'] = !!req.body.hide;
  if (!Object.keys(patch).length) return res.status(400).json({ message: 'Nothing to change' });

  const before = await BPItem.findById(itemId).select('published adminFlags').lean();
  const after  = await BPItem.findByIdAndUpdate(
    itemId, { $set: patch, $currentDate: { updatedAt: true } }, { new: true }
  ).lean();

  await BPAuditLog.create({
    actorId: req.user._id, actorRole:'admin',
    target: { kind:'item', id: itemId, extra: { profile: after?.profile } },
    action: 'moderate-item',
    diff: { before, after },
    note: cleanStr(req.body?.note || '')
  });

  res.json({ ok:true, data: after });
});

// POST /admin/bp/profiles/bulk
// body: { ids:[], op:'publish'|'unpublish'|'feature'|'unfeature' }
exports.adminBulkProfiles = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isId);
  const op  = String(req.body?.op || '').toLowerCase();
  if (!ids.length) return res.status(400).json({ message: 'No ids' });

  let patch = null;
  if (op === 'publish')   patch = { published: true };
  if (op === 'unpublish') patch = { published: false };
  if (op === 'feature')   patch = { featured: true };
  if (op === 'unfeature') patch = { featured: false };
  if (!patch) return res.status(400).json({ message: 'Bad op' });

  const { modifiedCount } = await BusinessProfile.updateMany(
    { _id: { $in: ids } },
    { $set: patch, $currentDate: { updatedAt: true } }
  );

  await BPAuditLog.create({
    actorId: req.user._id, actorRole:'admin',
    target: { kind:'profile', id: null, extra: { ids } },
    action: `bulk-${Object.keys(patch)[0]}`,
    diff: { count: modifiedCount }
  });

  res.json({ ok:true, updated: modifiedCount });
});

// GET /admin/bp/audit?targetId=&kind=&page=&limit=
exports.adminAuditLogs = asyncHdl(async (req, res) => {
  ensureAdmin(req);
  const { targetId='', kind='' } = req.query || {};
  const { page, limit, skip } = paginate(req.query.page, req.query.limit, 200);

  const qry = {};
  if (isId(targetId)) qry['target.id'] = targetId;
  if (kind) qry['target.kind'] = kind;

  const [rows, total] = await Promise.all([
    BPAuditLog.find(qry).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    BPAuditLog.countDocuments(qry)
  ]);

  res.json({ ok:true, page, perPage: limit, total, data: rows });
});