// controllers/bpItemController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const BPTaxonomy = require('../models/BPTaxonomy');
const { toStr, normTags, isId, toLimit, makeRx } = require('../utils/bpUtil');
const ObjectId = (v)=> (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);
const mongoose = require('mongoose');

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
const CUR_RX = /^[A-Z]{3}$/;
const toNum = (v) => (v === '' || v === null || typeof v === 'undefined' ? NaN : Number(v));
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

  // Normalize: lower-case, collapse whitespace, strip diacritics
  const normKey = (s='') => String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const sectorKey = normKey(sector);
  log('validateTaxonomy() sectorKey:', sectorKey);

  // Primary exact match against normalized key (schema stores lowercase)
  let t = await BPTaxonomy.findOne({ sector: sectorKey }).lean();
  // Fallback: case-insensitive anchored match (helps during data migration)
  if (!t) {
    const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = await BPTaxonomy.findOne({ sector: new RegExp(`^${esc(sector)}$`, 'i') }).lean();
  }

  log('validateTaxonomy() fetched sector:', t ? { sector: t.sector, subsectors: (t.subsectors||[]).length } : null);
  if (!t) return { ok: false, error: 'sector_not_found' };

  if (!subsectorId) {
    log('validateTaxonomy() -> OK (no subsectorId)');
    return { ok: true, sector: t.sector, subsectorName: null, subsectorId: null };
  }

  const sub = (t.subsectors || []).find(s => String(s._id) === String(subsectorId));
  log('validateTaxonomy() matched subsector:',
      sub ? { _id:String(sub._id), name:sub.name, allowProducts:sub.allowProducts, allowServices:sub.allowServices } : null);
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

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rxEq = v => new RegExp(`^${esc(String(v))}$`, "i");
exports.getMarketFacets = async (req,res,next)=>{
  try{
    const tax = await BPTaxonomy.find({}).select("sector subsectors").lean();
    const industriesAgg = await BusinessProfile.aggregate([
      { $match:{ published:true } },
      { $unwind:"$industries" },
      { $group:{ _id:"$industries", c:{ $sum:1 } } },
      { $sort:{ c:-1, _id:1 } }, { $limit:200 }
    ]);
    const countriesAgg = await BusinessProfile.aggregate([
      { $match:{ published:true } },
      { $unwind:"$countries" },
      { $group:{ _id:"$countries", c:{ $sum:1 } } },
      { $sort:{ c:-1, _id:1 } }, { $limit:200 }
    ]);
    const sizesAgg = await BusinessProfile.aggregate([
      { $match:{ published:true } },
      { $group:{ _id:"$size", c:{ $sum:1 } } },
      { $sort:{ c:-1, _id:1 } }
    ]);
    const badgesAgg = await BusinessProfile.aggregate([
      { $match:{ published:true } },
      { $unwind:"$badges" },
      { $group:{ _id:"$badges", c:{ $sum:1 } } },
      { $sort:{ c:-1, _id:1 } }
    ]);

    res.json({
      success:true,
      sectors:(tax||[]).map(t=>({
        sector:t.sector,
        subsectors:(t.subsectors||[]).map(ss=>({ id:String(ss._id), name:ss.name }))
      })),
      industries:industriesAgg.map(x=>({ name:x._id, count:x.c })),
      countries:countriesAgg.map(x=>({ code:x._id, count:x.c })),
      sizes:sizesAgg.filter(x=>x._id).map(x=>({ size:x._id, count:x.c })),
      badges:badgesAgg.map(x=>({ badge:x._id, count:x.c })),
    });
  }catch(e){ next(e); }
};

const str   = (v) => (typeof v === "string" ? v : "");
const pickUrl = (v) =>
  !v ? null : (typeof v === "string" ? v : (v.url || v.path || v.secure_url || v.src || null));

/** Map an item doc to API shape, embedding minimal business profile */
const mapItem = (d, pmap) => {
  const pid = String(d.profile || "");
  const bp  = pmap.get(pid);

  // prefer images[] first, then thumbnailUpload, then thumb
  const firstImg = Array.isArray(d.images) ? d.images.map(pickUrl).find(Boolean) : null;
  const thumb    = firstImg || pickUrl(d.thumbnailUpload) || pickUrl(d.thumb) || null;

  return {
    type: "item",
    id: String(d._id),
    kind: d.kind,                           // "product" | "service"
    title: d.title,
    summary: d.summary || "",
    priceValue: d.priceValue ?? null,
    priceCurrency: d.priceCurrency || null,
    sector: d.sector || "",
    subsectorId: d.subsectorId || null,
    thumb,
    tags: Array.isArray(d.tags) ? d.tags : [],
    profile: bp
      ? {
          id: String(bp._id),
          name: bp.name || "",
          logoUpload: bp.logoUpload || null, // <- explicit for frontend
          countries: Array.isArray(bp.countries) ? bp.countries : [],
        }
      : null,
  };
};

/** Map a business profile to API shape, include featured items (thumbs) */
const mapBusiness = (bp, featured = [], topTags = []) => ({
  type: "business",
  id: String(bp._id),
  name: bp.name || "",
  tags: topTags.slice(0, 3),               // replaces tagline
  industries: bp.industries || [],
  countries: bp.countries || [],
  size: bp.size || "",
  badges: bp.badges || [],
  logoUpload: bp.logoUpload || null,       // top banner on the card (frontend falls back to featured)
  featuredItems: featured.slice(0, 4).map((it) => ({
    id: String(it._id),
    kind: it.kind,
    title: it.title,
    images: it.images || [],               // frontend will prefer images[] first
    thumbnailUpload: it.thumbnailUpload || null,
    thumb: (Array.isArray(it.images) && it.images[0]) || null,
  })),
});

/** Top tags per business (from its items) */
async function aggregateTopTagsPerBusiness(profileIds = []) {
  if (!profileIds.length) return new Map();
  const rows = await BPItem.aggregate([
    { $match: { profile: { $in: profileIds }, published: true, tags: { $exists: true, $ne: [] } } },
    { $unwind: "$tags" },
    { $group: { _id: { profile: "$profile", tag: "$tags" }, c: { $sum: 1 } } },
    { $sort: { c: -1, "_id.tag": 1 } },
    { $group: { _id: "$_id.profile", tags: { $push: { tag: "$_id.tag", c: "$c" } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.tags.map((t) => t.tag)]));
}

/** Global tag cloud for the current items query (not paginated) */
async function aggregateGlobalTags(itemsQ) {
  const rows = await BPItem.aggregate([
    { $match: Object.assign({}, itemsQ, { tags: { $exists: true, $ne: [] } }) },
    { $unwind: "$tags" },
    { $group: { _id: "$tags", c: { $sum: 1 } } },
    { $sort: { c: -1, _id: 1 } },
    { $limit: 200 },
  ]);
  return rows.map((r) => ({ name: r._id, count: r.c }));
}
// ===== controller (full replacement) =====
exports.getMarketItems = async (req, res, next) => {
  try {
    // normalize + defaults
    const q            = typeof req.query.q === "string" ? req.query.q : "";
    const kindRaw      = String(req.query.kind || "").toLowerCase();
    // allow business-first pages to show both by default
    const K            = ["product", "service", "all", "business"].includes(kindRaw) ? kindRaw : "all";

    // CSV multi-selects
    const sectorList   = String(req.query.sector || "")
                          .split(",").map((s) => s.trim()).filter(Boolean);
    const sizeList     = String(req.query.size || "")
                          .split(",").map((s) => s.trim()).filter(Boolean);

    const subsectorId  = typeof req.query.subsectorId === "string" ? req.query.subsectorId : "";
    const industry     = typeof req.query.industry === "string" ? req.query.industry : "";
    const country      = typeof req.query.country  === "string" ? req.query.country  : "";
    const badgesCsv    = typeof req.query.badges   === "string" ? req.query.badges   : "";
    const badgeList    = badgesCsv.split(",").map((s) => s.trim()).filter(Boolean);

    // UI removed price/media sorting; keep server support for stability
    const hasImages    = String(req.query.hasImages || "");
    const sort         = String(req.query.sort || "new");
    const page         = Math.max(1, toNum(req.query.page, 1));
    const limit        = Math.max(1, Math.min(100, toNum(req.query.limit, 24)));
    const skip         = Math.max(0, (page - 1) * limit);

    // --- profile filters (STRICT published:true) ---
    const profileQ = { published: true };
    if (industry) profileQ.industries = rxEq(industry);
    if (country)  profileQ.countries  = rxEq(country);
    if (sizeList.length) profileQ.size = sizeList.length === 1 ? rxEq(sizeList[0]) : { $in: sizeList.map(rxEq) };
    if (badgeList.length) profileQ.badges = { $all: badgeList };
    if (q) {
      const r = new RegExp(esc(q), "i");
      Object.assign(profileQ, {
        $or: [
          { name: r }, { tagline: r }, { about: r },
          { industries: r }, { offering: r }, { seeking: r },
        ],
      });
    }

    // --- item filters (STRICT published:true) ---
    const itemsQ = { published: true };
    if (K === "product" || K === "service") itemsQ.kind = K;
    if (sectorList.length) itemsQ.sector = sectorList.length === 1 ? rxEq(sectorList[0]) : { $in: sectorList.map(rxEq) };
    if (subsectorId && mongoose.isValidObjectId(subsectorId)) {
      itemsQ.subsectorId = new mongoose.Types.ObjectId(subsectorId);
    }
    if (hasImages === "1") itemsQ.images = { $exists: true, $ne: [] };
    if (q) {
      const r = new RegExp(esc(q), "i");
      Object.assign(itemsQ, { $or: [{ title: r }, { summary: r }, { details: r }, { tags: r }] });
    }

    // If any profile-only filter present, restrict items to those profiles
    const profileFiltersOn = Boolean(industry || country || sizeList.length || badgeList.length);
    if (profileFiltersOn) {
      const allowedProfiles = await BusinessProfile.find(profileQ).select("_id").lean();
      itemsQ.profile = { $in: allowedProfiles.map((x) => x._id) };
    }

    // sorting
    const sortItems =
      sort === "priceAsc"  ? { priceValue: 1,  createdAt: -1 } :
      sort === "priceDesc" ? { priceValue: -1, createdAt: -1 } :
      sort === "az"        ? { title: 1 } :
                             { createdAt: -1 };
    const sortProfiles = sort === "az" ? { name: 1 } : { createdAt: -1 };

    // what to fetch
    const wantItems      = K === "product" || K === "service" || K === "all";
    const wantBusinesses = K === "business" || K === "all";

    // ----- ITEMS -----
    let items = [], countItems = 0;
    if (wantItems) {
      const [docs, cnt] = await Promise.all([
        BPItem.find(itemsQ).sort(sortItems).skip(skip).limit(limit).lean(),
        BPItem.countDocuments(itemsQ),
      ]);
      const pids = [...new Set(docs.map((d) => String(d.profile)))];
      const pmap = pids.length
        ? new Map(
            (await BusinessProfile.find({ _id: { $in: pids } })
              .select("name logoUpload countries")
              .lean()
            ).map((p) => [String(p._id), p])
          )
        : new Map();
      items = docs.map((d) => mapItem(d, pmap));
      countItems = cnt;
    }

    // ----- BUSINESSES (with featured thumbs + top tags) -----
    let businesses = [], countBusinesses = 0;
    if (wantBusinesses) {
      const [bps, cnt] = await Promise.all([
        BusinessProfile.find(profileQ).sort(sortProfiles).skip(skip).limit(limit).lean(),
        BusinessProfile.countDocuments(profileQ),
      ]);
      const bIds = bps.map((b) => b._id);

      // Featured items per business (for thumbnails)
      const featured = bIds.length
        ? await BPItem.aggregate([
            { $match: { profile: { $in: bIds }, published: true, images: { $ne: [] } } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: "$profile", items: { $push: "$$ROOT" } } },
          ])
        : [];

      // Top tags per business
      const tagsMap = await aggregateTopTagsPerBusiness(bIds);
      const fmap    = new Map(featured.map((g) => [String(g._id), g.items]));
      businesses    = bps.map((bp) => {
        const pid = String(bp._id);
        return mapBusiness(bp, fmap.get(pid) || [], tagsMap.get(pid) || []);
      });
      countBusinesses = cnt;
    }

    // ----- MERGE (businesses first on "all") -----
    const merged =
      wantBusinesses && wantItems ? [...businesses, ...items]
      : wantBusinesses            ? businesses
      :                              items;

    // Global tag cloud for current query
    const tags = await aggregateGlobalTags(itemsQ);

    res.json({
      success: true,
      items: merged,
      total: (wantBusinesses ? countBusinesses : 0) + (wantItems ? countItems : 0),
      counts: { businesses: countBusinesses, productsServices: countItems },
      tags,
    });
  } catch (e) {
    next(e);
  }
};
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
  const pv = toNum(req.body?.priceValue);
  const pc = toStr(req.body?.priceCurrency).toUpperCase();
  const pu = toStr(req.body?.priceUnit).toLowerCase();

  if (pv > 0) {
    if (!CUR_RX.test(pc)) return res.status(400).json({ message: 'invalid_currency' });
   payload.priceValue    = pv;
    payload.priceCurrency = pc;
    payload.priceUnit     = pu || null; // unit is optional free text (e.g., 'per kg','per hour')
  } else {
    payload.priceValue    = null;
    payload.priceCurrency = null;
    payload.priceUnit     = null;
  }
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
const hasPV = Object.prototype.hasOwnProperty.call(body, 'priceValue');
  const hasPC = Object.prototype.hasOwnProperty.call(body, 'priceCurrency');
  const hasPU = Object.prototype.hasOwnProperty.call(body, 'priceUnit');

  if (hasPV || hasPC || hasPU) {
    const pv = hasPV ? toNum(body.priceValue) : it.priceValue;
    const pc = hasPC ? toStr(body.priceCurrency).toUpperCase() : it.priceCurrency;
   const pu = hasPU ? toStr(body.priceUnit).toLowerCase() : it.priceUnit;

    if (pv > 0) {
      if (!CUR_RX.test(pc || '')) return res.status(400).json({ message: 'invalid_currency' });
      it.priceValue    = pv;
      it.priceCurrency = pc;
     it.priceUnit     = pu || null;
    } else {
      // 0 or empty => clear whole price block
      it.priceValue    = null;
      it.priceCurrency = null;
      it.priceUnit     = null;
    }
  }
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
      priceValue: it.priceValue,
      priceCurrency: it.priceCurrency,
      priceUnit: it.priceUnit,
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
    .select('kind title summary details tags pricingNote priceValue priceCurrency priceUnit sector subsectorId subsectorName thumbnailUpload images published createdAt')
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
    .select('kind title summary details tags pricingNote priceValue priceCurrency priceUnit sector subsectorId subsectorName thumbnailUpload images createdAt')
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
exports.marketList = asyncHdl(async (req, res) => {
  // q, kind, sector, subsectorId, tags(csv), hasImages(1), sort=new|az, page, limit
  const {
    q = '', kind = '', sector = '', subsectorId = '',
    tags = '', hasImages = '', sort = 'new',
    page = 1, limit = 20
  } = req.query;

  const lim = toLimit(limit, 50);
  const skip = (Math.max(1, Number(page)) - 1) * lim;

  const match = {
    published: true,
    $or: [{ 'adminFlags.hidden': { $exists: false } }, { 'adminFlags.hidden': false }]
  };

  if (kind === 'product' || kind === 'service') match.kind = kind;
  if (sector) match.sector = String(sector).toLowerCase().trim();
  if (subsectorId && ObjectId(subsectorId)) match.subsectorId = ObjectId(subsectorId);

  const tagList = String(tags || '')
    .split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);
  if (tagList.length) match.tags = { $in: tagList };

  if (hasImages === '1') {
    match.$or = [
      ...(match.$or || []),
      { images: { $exists: true, $ne: [] } },
      { thumbnailUpload: { $exists: true, $ne: null } },
    ];
  }

  if (q && q.trim()) {
    const rx = makeRx(q.trim(), 'i');
    match.$and = [
      ...(match.$and || []),
      { $or: [{ title: rx }, { summary: rx }, { details: rx }, { tags: rx }] }
    ];
  }

  const sortStage =
    sort === 'az' ? { title: 1 }
      : { createdAt: -1 };

  const pipeline = [
    { $match: match },
    { $sort: sortStage },
    { $skip: skip },
    { $limit: lim },
    { $project: {
        profile: 1, kind: 1, sector: 1, subsectorId: 1, subsectorName: 1,
        title: 1, summary: 1, tags: 1, images: 1, thumbnailUpload: 1,
        pricingNote: 1, createdAt: 1
    }},
    { $lookup: {
        from: 'businessprofiles', // ← collection name
        localField: 'profile',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, slug: 1, logoUpload: 1 } }],
        as: 'profileDoc'
    }},
    { $set: { profileDoc: { $first: '$profileDoc' } } }
  ];

  const [rows, total] = await Promise.all([
    BPItem.aggregate(pipeline).allowDiskUse(true),
    BPItem.countDocuments(match)
  ]);

  return res.json({
    success: true,
    page: Number(page),
    limit: lim,
    total,
    items: rows.map(r => ({
      id: String(r._id),
      kind: r.kind,
      sector: r.sector,
      subsectorId: r.subsectorId,
      subsectorName: r.subsectorName,
      title: r.title,
      pricingNote: r.pricingNote || "",
      tags: r.tags || [],
      images: r.images || [],
      thumbnailUpload: r.thumbnailUpload || null,
      profile: r.profileDoc ? {
        id: String(r.profile),
        name: r.profileDoc.name || '',
        slug: r.profileDoc.slug || '',
        logoUpload: r.profileDoc.logoUpload || null,
      } : { id: String(r.profile) }
    }))
  });
});

exports.marketGetOne = asyncHdl(async (req, res) => {
  const id = req.params.itemId;
  if (!ObjectId(id)) return res.status(400).json({ message: 'Bad item id' });

  const item = await BPItem.findOne({ _id: id, published: true, 'adminFlags.hidden': { $ne: true } })
    .select('profile kind sector subsectorId subsectorName title summary details tags images thumbnailUpload pricingNote createdAt')
    .lean();

  if (!item) return res.status(404).json({ message: 'Item not found' });

  const prof = await BusinessProfile.findById(item.profile)
    .select('name slug logoUpload industries countries languages')
    .lean();

  return res.json({
    success: true,
    item: {
      id: String(item._id),
      ...item,
      profile: prof ? {
        id: String(prof._id), name: prof.name, slug: prof.slug,
        logoUpload: prof.logoUpload, industries: prof.industries,
        countries: prof.countries, languages: prof.languages
      } : { id: String(item.profile) }
    }
  });
});

exports.marketFacets = asyncHdl(async (_req, res) => {
  // sectors & subsectors (taxonomy)
  const tax = await BPTaxonomy.find({})
    .select('sector subsectors')
    .lean();

  // counts per sector & kind + top tags
  const match = { published: true, $or: [{ 'adminFlags.hidden': { $exists: false } }, { 'adminFlags.hidden': false }] };

  const [countsBySector, countsByKind, topTags] = await Promise.all([
    BPItem.aggregate([
      { $match: match },
      { $group: { _id: '$sector', n: { $sum: 1 } } },
      { $sort: { n: -1 } }
    ]),
    BPItem.aggregate([
      { $match: match },
      { $group: { _id: '$kind', n: { $sum: 1 } } }
    ]),
    BPItem.aggregate([
      { $match: match },
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$tags', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 50 }
    ])
  ]);

  return res.json({
    success: true,
    sectors: tax.map(t => ({
      sector: t.sector,
      subsectors: (t.subsectors || []).map(s => ({
        id: String(s._id), name: s.name, allowProducts: !!s.allowProducts, allowServices: !!s.allowServices
      }))
    })),
    counts: {
      bySector: countsBySector.map(x => ({ sector: x._id || '', n: x.n })),
      byKind  : countsByKind.map(x => ({ kind: x._id || '', n: x.n })),
    },
    tagsTop: topTags.map(x => ({ tag: x._id, n: x.n }))
  });
});
exports.getMarketItem = asyncHdl(async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ message: "Bad productId" });
  }

  // pull only the fields we actually need
  const doc = await BPItem.findById(productId)
    .select(
      "kind sector subsectorId subsectorName title summary details tags pricingNote priceValue priceCurrency priceUnit images thumbnailUpload profile createdAt"
    )
    .lean();

  if (!doc) return res.status(404).json({ message: "Item not found" });

  // --- normalize minimal BusinessProfile payload (MATCHES YOUR HOOK SAMPLE) ---
  let profile = null;
  if (doc.profile && mongoose.isValidObjectId(doc.profile)) {
    const p = await BusinessProfile.findById(doc.profile)
      .select("name slug logoUpload industries countries languages")
      .lean();

    if (p) {
      profile = {
        id: String(p._id),
        name: p.name || "",
        slug: p.slug || "",
        logoUpload: p.logoUpload || "",
        industries: Array.isArray(p.industries) ? p.industries : [],
        countries: Array.isArray(p.countries) ? p.countries : [],
        languages: Array.isArray(p.languages) ? p.languages : [],
      };
    }
  }

  // --- response shape (includes _id + id, price fields, images) ---
  return res.json({
    id: String(doc._id),
    _id: String(doc._id),
    profile,

    kind: doc.kind || "product",
    sector: doc.sector || "",
    subsectorId: doc.subsectorId || "",
    subsectorName: doc.subsectorName || "",

    title: doc.title || "",
    summary: doc.summary || "",
    details: doc.details || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],

    images: Array.isArray(doc.images) ? doc.images : [],
    thumbnailUpload: doc.thumbnailUpload || "",

    pricingNote: doc.pricingNote || "",
    priceValue:
      typeof doc.priceValue === "number"
        ? doc.priceValue
        : (doc.priceValue ? Number(doc.priceValue) : null),
    priceCurrency: doc.priceCurrency || "",
    priceUnit: doc.priceUnit || "",

    createdAt: doc.createdAt,
  });
});

// NEW: business-first endpoint
exports.getMarketBusinesses = async (req, res, next) => {
  try {
    const esc   = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rxEq  = (v) => new RegExp(`^${esc(String(v))}$`, "i");
    const pick  = (v) => !v ? null : (typeof v === "string" ? v : (v.url || v.path || v.secure_url || v.src || null));
    const toNum = (v, d=0) => (Number.isFinite(+v) ? +v : d);

    const str = (v) => (typeof v === "string" ? v : "");
    const q           = str(req.query.q);
    const industry    = str(req.query.industry);
    const country     = str(req.query.country);

    // multi-selects (CSV)
    const sizeList    = str(req.query.size).split(",").map(s=>s.trim()).filter(Boolean);
    const badgeList   = str(req.query.badges).split(",").map(s=>s.trim()).filter(Boolean);
    const sectorList  = str(req.query.sector).split(",").map(s=>s.trim()).filter(Boolean);

    const page        = Math.max(1, toNum(req.query.page, 1));
    const limit       = Math.max(1, Math.min(100, toNum(req.query.limit, 24)));
    const skip        = Math.max(0, (page - 1) * limit);
    const sort        = str(req.query.sort) || "new";
    const sortProfiles= sort === "az" ? { name: 1 } : { createdAt: -1 };

    // ---- Build BusinessProfile filter (STRICT published:true)
    const profileQ = { published: true };
    if (industry) profileQ.industries = rxEq(industry);
    if (country)  profileQ.countries  = rxEq(country);
    if (sizeList.length) profileQ.size = sizeList.length === 1 ? rxEq(sizeList[0]) : { $in: sizeList.map(rxEq) };
    if (badgeList.length) profileQ.badges = { $all: badgeList };
    if (q) {
      const r = new RegExp(esc(q), "i");
      Object.assign(profileQ, { $or:[
        { name:r }, { tagline:r }, { about:r }, { industries:r }, { offering:r }, { seeking:r }
      ]});
    }

    // sector constraint: only businesses that have at least one published item in those sectors
    if (sectorList.length) {
      const profIds = await BPItem.distinct("profile", {
        published: true,
        sector: sectorList.length === 1 ? rxEq(sectorList[0]) : { $in: sectorList.map(rxEq) }
      });
      profileQ._id = { $in: profIds };
    }

    const [bps, total] = await Promise.all([
      BusinessProfile.find(profileQ).sort(sortProfiles).skip(skip).limit(limit).lean(),
      BusinessProfile.countDocuments(profileQ),
    ]);
    const bIds = bps.map(b => b._id);

    // fetch recent items per business for thumbnails
    const featured = bIds.length
      ? await BPItem.aggregate([
          { $match: { profile: { $in: bIds }, published: true } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: "$profile", items: { $push: "$$ROOT" } } }
        ])
      : [];
    const fmap    = new Map(featured.map(g => [String(g._id), g.items]));

    // top tags per business (from its items)
    const tagRows = await BPItem.aggregate([
      { $match: { profile: { $in: bIds }, published: true, tags: { $exists: true, $ne: [] } } },
      { $unwind: "$tags" },
      { $group: { _id: { profile: "$profile", tag: "$tags" }, c: { $sum: 1 } } },
      { $sort: { c: -1, "_id.tag": 1 } },
      { $group: { _id: "$_id.profile", tags: { $push: { tag: "$_id.tag", c: "$c" } } } }
    ]);
    const tagsMap = new Map(tagRows.map(r => [String(r._id), r.tags.map(t => t.tag)]));

    // map businesses
    const items = bps.map(bp => {
      const pid   = String(bp._id);
      const feats = (fmap.get(pid) || []).slice(0, 4).map(it => ({
        id: String(it._id),
        kind: it.kind,
        title: it.title,
        // prefer images[] first, then thumbnailUpload, then thumb
        thumb: (Array.isArray(it.images) && it.images.map(pick).find(Boolean)) ||
               pick(it.thumbnailUpload) || pick(it.thumb) || null,
      }));
      return {
        type: "business",
        id: pid,
        name: bp.name || "",
        logoUpload: bp.logoUpload || null,   // used by UI as top hero
        industries: bp.industries || [],
        countries: bp.countries  || [],
        size: bp.size || "",
        badges: bp.badges || [],
        tags: (tagsMap.get(pid) || []).slice(0,3),
        featuredItems: feats,
      };
    });

    res.json({ success:true, items, total, counts:{ businesses: total, productsServices: 0 } });
  } catch (e) { next(e); }
};