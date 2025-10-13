// controllers/bpItemController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const BPTaxonomy = require('../models/BPTaxonomy');
const { toStr, normTags, isId, toLimit, makeRx } = require('../utils/bpUtil');

/* ----------------------- logging helpers ----------------------- */
const TAG = 'bpItemController';
const ts = () => new Date().toISOString().split('T')[1].replace('Z','');
const s = (v) => {
  try {
    return JSON.stringify(v, (k, val) => {
      if (typeof val === 'string' && val.length > 400) return `${val.slice(0, 400)}…(${val.length})`;
      return val;
    }, 2);
  } catch {
    return String(v);
  }
};
const log = (...args) => console.log(`[${ts()}][${TAG}]`, ...args);

/* ----------------------- core helpers ----------------------- */
async function myProfile(req) {
  const actorId = req.user?._id || req.user?.id;
  log('myProfile() actorId =', actorId);
  const p = await BusinessProfile.findOne({ 'owner.actor': actorId });
  log('myProfile() -> profile:', p ? { _id: String(p._id), name: p.name } : null);
  if (!p) { const e = new Error('Profile not found'); e.statusCode = 404; throw e; }
  return p;
}

async function validateTaxonomy(sector, subsectorId, kind) {
  log('validateTaxonomy() in:', { sector, subsectorId, kind });
  if (!sector) {
    log('validateTaxonomy() -> OK (no sector)');
    return { ok: true, sector: null, subsectorName: null, subsectorId: null };
  }
  const sectorKey = String(sector).toLowerCase().trim();
  const t = await BPTaxonomy.findOne({ sector: sectorKey }).lean();
  log('validateTaxonomy() fetched sector:', t ? { sector: t.sector, subsectors: (t.subsectors || []).length } : null);
  if (!t) return { ok: false, error: 'sector_not_found' };

  if (!subsectorId) {
    log('validateTaxonomy() -> OK (no subsectorId)');
    return { ok: true, sector: t.sector, subsectorName: null, subsectorId: null };
  }
  const sub = (t.subsectors || []).find(s => String(s._id) === String(subsectorId));
  log('validateTaxonomy() matched subsector:', sub ? { _id: String(sub._id), name: sub.name, allowProducts: sub.allowProducts, allowServices: sub.allowServices } : null);
  if (!sub) return { ok: false, error: 'subsector_not_found' };
  if (kind === 'product' && !sub.allowProducts) return { ok: false, error: 'subsector_disallows_product' };
  if (kind === 'service' && !sub.allowServices) return { ok: false, error: 'subsector_disallows_service' };

  log('validateTaxonomy() -> OK');
  return { ok: true, sector: t.sector, subsectorName: sub.name, subsectorId: sub._id };
}

/* Accepts a TON of shapes and normalizes to string[] */
function coerceUploadsFromBody(body = {}) {
  log('coerceUploadsFromBody(IN):', s(body));
  const out = [];

  const pushMaybe = (v) => {
    if (v == null) return;

    if (Array.isArray(v)) {
      v.forEach(pushMaybe);
      return;
    }

    if (typeof v === 'object') {
      const id =
        v.uploadId || v.id || v._id || v.upload_id || v.imageId;
      const path =
        v.uploadPath || v.path || v.imagePath || v.url;
      if (id) out.push(String(id));
      if (path) out.push(String(path));
      return;
    }

    if (typeof v === 'string') {
      v.split(',').map(s => s.trim()).filter(Boolean).forEach(sv => out.push(sv));
      return;
    }

    out.push(String(v));
  };

  // common array holders
  pushMaybe(body.uploadIds);
  pushMaybe(body.uploadPaths);
  pushMaybe(body.uploads);
  pushMaybe(body.images);
  pushMaybe(body.ids);
  pushMaybe(body.paths);
  pushMaybe(body.files);

  // singletons
  pushMaybe(body.uploadId);
  pushMaybe(body.uploadPath);
  pushMaybe(body.imageId);
  pushMaybe(body.imagePath);

  const unique = Array.from(new Set(out.filter(Boolean)));
  log('coerceUploadsFromBody(OUT):', s(unique));
  return unique;
}

/* ----------------------- create ----------------------- */
// POST /bp/me/items
exports.createItem = asyncHdl(async (req, res) => {
  log('POST /bp/me/items BODY:', s(req.body));
  const p = await myProfile(req);

  const k = String(req.body?.kind || '').toLowerCase().trim();
  log('createItem() kind:', k);
  if (!['product', 'service'].includes(k)) {
    log('createItem() -> 400 invalid kind');
    return res.status(400).json({ message: 'kind must be product|service' });
  }

  const tax = await validateTaxonomy(req.body?.sector, req.body?.subsectorId, k);
  log('createItem() tax result:', s(tax));
  if (!tax.ok) return res.status(400).json({ message: tax.error });

  const payload = {
    profile: p._id,
    kind: k,
    sector: tax.sector || undefined,
    subsectorId: tax.subsectorId || undefined,
    subsectorName: tax.subsectorName || undefined,
    title: toStr(req.body?.title, 160),
    summary: toStr(req.body?.summary, 600),
    details: toStr(req.body?.details, 8000),
    tags: normTags(req.body?.tags),
    pricingNote: toStr(req.body?.pricingNote, 500),
    thumbnailUpload: req.body?.thumbnailUpload ? String(req.body.thumbnailUpload) : undefined,
    images: Array.isArray(req.body?.images) ? req.body.images.map(String).filter(Boolean).slice(0, 12) : [],
    published: req.body?.published !== false
  };

  log('createItem() INSERT payload:', s(payload));
  const doc = await BPItem.create(payload);
  log('createItem() INSERTED _id:', String(doc._id), 'images:', s(doc.images));

  res.status(201).json({ ok: true, id: doc._id });
});

/* ----------------------- update ----------------------- */
// PATCH /bp/me/items/:itemId
exports.updateItem = asyncHdl(async (req, res) => {
  log('PATCH /bp/me/items/:itemId PARAMS:', s(req.params), 'BODY:', s(req.body));
  const it = await BPItem.findById(req.params.itemId);
  log('updateItem() found item:', it ? { _id: String(it._id) } : null);
  if (!it) return res.status(404).json({ message: 'Not found' });

  const p = await myProfile(req);
  if (String(it.profile) !== String(p._id)) {
    log('updateItem() forbidden: item.profile != user.profile');
    return res.status(403).json({ message: 'Forbidden' });
  }

  const body = req.body || {};

  // Optional taxonomy change
  if ('sector' in body || 'subsectorId' in body) {
    const nextSector = body.sector ?? it.sector;
    const nextSubId = body.subsectorId ?? it.subsectorId;

    log('updateItem() validateTaxonomy with:', { nextSector, nextSubId, kind: it.kind });
    const tax = await validateTaxonomy(nextSector, nextSubId, it.kind);
    log('updateItem() tax result:', s(tax));
    if (!tax.ok) {
      const code = tax.error || 'taxonomy_invalid';
      const map = {
        sector_not_found: 400,
        subsector_not_found: 400,
        subsector_disallows_product: 400,
        subsector_disallows_service: 400
      };
      return res.status(map[code] || 400).json({ message: code });
    }

    it.sector = tax.sector || undefined;
    it.subsectorId = tax.subsectorId || undefined;
    it.subsectorName = tax.subsectorName || undefined;
  }

  if ('title' in body) it.title = toStr(body.title, 160);
  if ('summary' in body) it.summary = toStr(body.summary, 600);
  if ('details' in body) it.details = toStr(body.details, 8000);
  if ('tags' in body) it.tags = normTags(body.tags);
  if ('pricingNote' in body) it.pricingNote = toStr(body.pricingNote, 500);
  if ('published' in body) it.published = !!body.published;

  // media fields — store as strings
  if ('thumbnailUpload' in body) {
    const v = body.thumbnailUpload;
    it.thumbnailUpload = v ? String(v) : undefined;
    log('updateItem() set thumbnailUpload:', it.thumbnailUpload);
  }

  if ('images' in body) {
    const imgs = Array.isArray(body.images) ? body.images : [];
    it.images = imgs.map(String).filter(Boolean).slice(0, 12);
    log('updateItem() set images (overwrite):', s(it.images));
  }

  await it.save();
  log('updateItem() saved. final images:', s(it.images));

  res.json({
    ok: true,
    data: {
      _id: it._id,
      kind: it.kind,
      title: it.title,
      summary: it.summary,
      details: it.details,
      tags: it.tags,
      pricingNote: it.pricingNote,
      sector: it.sector,
      subsectorId: it.subsectorId,
      subsectorName: it.subsectorName,
      thumbnailUpload: it.thumbnailUpload,
      images: it.images,
      published: it.published,
      updatedAt: it.updatedAt
    }
  });
});

/* ----------------------- delete ----------------------- */
// DELETE /bp/me/items/:itemId
exports.deleteItem = asyncHdl(async (req, res) => {
  log('DELETE /bp/me/items/:itemId PARAMS:', s(req.params));
  const it = await BPItem.findById(req.params.itemId);
  log('deleteItem() found item:', it ? { _id: String(it._id) } : null);
  if (!it) return res.status(404).json({ message: 'Not found' });

  const p = await myProfile(req);
  if (String(it.profile) !== String(p._id)) {
    log('deleteItem() forbidden');
    return res.status(403).json({ message: 'Forbidden' });
  }

  await it.deleteOne();
  log('deleteItem() deleted.');
  res.json({ ok: true });
});

/* ----------------------- list (mine) ----------------------- */
// GET /bp/me/items?kind=&sector=&subsectorId=&q=&limit=
exports.listMyItems = asyncHdl(async (req, res) => {
  log('GET /bp/me/items QUERY:', s(req.query));
  const p = await myProfile(req);
  const { kind, sector, subsectorId, q, limit = 20 } = req.query || {};

  const filter = { profile: p._id };
  if (kind) filter.kind = String(kind).toLowerCase().trim();
  if (sector) filter.sector = String(sector).toLowerCase().trim();
  if (subsectorId && isId(subsectorId)) filter.subsectorId = subsectorId;

  log('listMyItems() filter:', s(filter));

  let cursor = BPItem.find(filter);
  if (q && String(q).trim()) {
    const rx = makeRx(q);
    cursor = cursor.find({ $or: [{ title: rx }, { summary: rx }, { details: rx }, { tags: rx }] });
  }

  const lim = toLimit(limit, 20, 100);
  const docs = await cursor
    .sort({ createdAt: -1 })
    .limit(lim)
    .select('kind title summary details tags pricingNote sector subsectorId subsectorName thumbnailUpload images published createdAt')
    .lean();

  log('listMyItems() -> count:', docs.length, 'sample[0]:', docs[0] ? s(docs[0]) : null);
  res.json({ ok: true, count: docs.length, data: docs });
});

/* ----------------------- list (public) ----------------------- */
// GET /bp/:profileId/items?kind=&sector=&subsectorId=&limit=
exports.listProfileItems = asyncHdl(async (req, res) => {
  log('GET /bp/:profileId/items PARAMS:', s(req.params), 'QUERY:', s(req.query));

  const { profileId } = req.params;
  if (!isId(profileId)) {
    log('listProfileItems() bad profileId');
    return res.status(400).json({ message: 'Bad profileId' });
  }

  const { kind, sector, subsectorId, limit = 20 } = req.query || {};
  const filter = { profile: profileId, published: true, 'adminFlags.hidden': { $ne: true } };
  if (kind) filter.kind = String(kind).toLowerCase().trim();
  if (sector) filter.sector = String(sector).toLowerCase().trim();
  if (subsectorId && isId(subsectorId)) filter.subsectorId = subsectorId;

  log('listProfileItems() filter:', s(filter));

  const lim = toLimit(limit, 20, 100);
  const docs = await BPItem.find(filter)
    .sort({ createdAt: -1 })
    .limit(lim)
    .select('kind title summary details tags pricingNote sector subsectorId subsectorName thumbnailUpload images createdAt')
    .lean();

  log('listProfileItems() -> count:', docs.length);
  res.json({ ok: true, count: docs.length, data: docs });
});

/* ----------------------- media ops ----------------------- */
// POST /bp/me/items/:itemId/thumbnail
exports.setItemThumbnail = asyncHdl(async (req, res) => {
  log('POST /bp/me/items/:itemId/thumbnail PARAMS:', s(req.params), 'BODY:', s(req.body));
  const it = await BPItem.findById(req.params.itemId);
  log('setItemThumbnail() found item:', it ? { _id: String(it._id) } : null);
  if (!it) return res.status(404).json({ message: 'Not found' });

  const p = await myProfile(req);
  if (String(it.profile) !== String(p._id)) {
    log('setItemThumbnail() forbidden');
    return res.status(403).json({ message: 'Forbidden' });
  }

  const incoming = coerceUploadsFromBody(req.body);
  const thumb = incoming[0] || req.body?.thumbnailUpload || req.body?.uploadId || req.body?.uploadPath || '';
  it.thumbnailUpload = thumb ? String(thumb) : undefined;

  await it.save();
  log('setItemThumbnail() saved thumbnailUpload:', it.thumbnailUpload);
  res.json({ ok: true, thumbnailUpload: it.thumbnailUpload });
});

// POST /bp/me/items/:itemId/images/add
exports.addItemImages = asyncHdl(async (req, res) => {
  log('POST /bp/me/items/:itemId/images/add PARAMS:', s(req.params), 'BODY:', s(req.body));
  const it = await BPItem.findById(req.params.itemId);
  log('addItemImages() found item:', it ? { _id: String(it._id), imagesCount: (it.images || []).length } : null);
  if (!it) return res.status(404).json({ message: 'Not found' });

  const p = await myProfile(req);
  if (String(it.profile) !== String(p._id)) {
    log('addItemImages() forbidden');
    return res.status(403).json({ message: 'Forbidden' });
  }

  const incoming = coerceUploadsFromBody(req.body); // -> string[]
  log('addItemImages() normalized incoming:', s(incoming));

  if (!incoming.length) {
    log('addItemImages() nothing to add; returning current images');
    return res.json({ ok: true, images: it.images || [] });
  }

  const set = new Set((it.images || []).map(String));
  incoming.forEach(x => set.add(String(x)));
  it.images = Array.from(set).slice(0, 12);

  await it.save();
  log('addItemImages() saved images:', s(it.images));
  res.json({ ok: true, images: it.images });
});

// POST /bp/me/items/:itemId/images/remove
exports.removeItemImage = asyncHdl(async (req, res) => {
  log('POST /bp/me/items/:itemId/images/remove PARAMS:', s(req.params), 'BODY:', s(req.body));
  const it = await BPItem.findById(req.params.itemId);
  log('removeItemImage() found item:', it ? { _id: String(it._id), imagesCount: (it.images || []).length } : null);
  if (!it) return res.status(404).json({ message: 'Not found' });

  const p = await myProfile(req);
  if (String(it.profile) !== String(p._id)) {
    log('removeItemImage() forbidden');
    return res.status(403).json({ message: 'Forbidden' });
  }

  const toRemove = coerceUploadsFromBody(req.body); // could be one or many
  log('removeItemImage() normalized toRemove:', s(toRemove));

  if (!toRemove.length) {
    log('removeItemImage() nothing to remove; returning current images');
    return res.json({ ok: true, images: it.images || [] });
  }

  const drop = new Set(toRemove.map(String));
  it.images = (it.images || []).filter(x => !drop.has(String(x)));

  await it.save();
  log('removeItemImage() saved images:', s(it.images));
  res.json({ ok: true, images: it.images });
});
