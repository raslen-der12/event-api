// controllers/bpAdminController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const mongoose = require('mongoose');
const BPTaxonomy = require('../models/BPTaxonomy');
const BPAuditLog = require('../models/BPAuditLog');
const { paginate, toLimit, makeRx, isId, cleanStr } = require('../utils/bpUtil');

const mustAdmin = (req) => !!req.user?.isAdmin;

// GET /admin/bp/queue
exports.queue = async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page  = toInt(req.query.page, 1, 1, 100000);
  const limit = toInt(req.query.limit, 12, 1, 200);

  const filter = { published: false };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    Object.assign(filter, {
      $or: [{ name: rx }, { slug: rx }, { tagline: rx }, { industries: rx }]
    });
  }

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    BusinessProfile.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit)
      .select('_id name slug published logoUpload createdAt')
      .lean(),
    BusinessProfile.countDocuments(filter),
  ]);

  // return under "unpublished.profiles" as your UI expects
  res.json({
    ok: true,
    unpublished: {
      page, limit, total,
      profiles: rows.map(r => ({
        id: String(r._id),
        name: r.name || '',
        slug: r.slug || '',
        published: !!r.published,                // should be false here
        logoUpload: r.logoUpload || null,
        createdAt: r.createdAt || null,
      }))
    }
  });
};

// PATCH /admin/bp/:id/publish
exports.setProfilePublished = asyncHdl(async (req, res) => {
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
// controllers/bpAdminController.js

const toInt = (v, d=1, min=1, max=1000) => Math.max(min, Math.min(max, parseInt(v,10) || d));
const s = (x)=>JSON.stringify(x);

function normSectorName(x=''){
  return String(x).trim().toLowerCase();
}
function httpBad(res, msg='Bad request', code=400){ return res.status(code).json({ ok:false, message:msg }); }

/* ===================== OVERVIEW (Global) ===================== */
/** GET /admin/bp/overview
 *  Returns global stats for dashboards.
 */
exports.adminBpOverview = async (req, res) => {
  const highlightsMode = String(req.query.highlights || 'recent').toLowerCase();
  const highlightsLimit = toInt(req.query.highlightsLimit, 5, 1, 50);

  // Top-level counts
  const [totalProfiles, publishedProfiles, totalItems, prodItems, servItems] = await Promise.all([
    BusinessProfile.countDocuments({}),
    BusinessProfile.countDocuments({ published: true }),
    BPItem.countDocuments({}),
    BPItem.countDocuments({ kind: 'product' }),
    BPItem.countDocuments({ kind: 'service' }),
  ]);
  const pendingProfiles = Math.max(0, totalProfiles - publishedProfiles);

  // Coverage by sector (from items)
  const sectorAgg = await BPItem.aggregate([
    { $match: {} },
    { $group: { _id: '$sector', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 100 }
  ]);
  const sectors = sectorAgg
    .filter(r => r._id)
    .map(r => ({ sector: r._id, count: r.count }));

  // Top profiles by #items (global, unchanged; can be used by UI)
  const topProfilesAgg = await BPItem.aggregate([
    { $group: { _id: '$profile', items: { $sum: 1 } } },
    { $sort: { items: -1 } },
    { $limit: 10 }
  ]);
  const topProfileIds = topProfilesAgg.map(r => r._id).filter(Boolean);
  const topProfilesDocs = topProfileIds.length
    ? await BusinessProfile.find({ _id: { $in: topProfileIds } })
        .select('_id name slug published logoUpload event createdAt')
        .lean()
    : [];
  const itemsByProfile = Object.fromEntries(topProfilesAgg.map(r => [String(r._id), r.items]));
  const topProfiles = topProfilesDocs.map(p => ({
    id: String(p._id),
    name: p.name,
    slug: p.slug,
    published: !!p.published,
    logoUpload: p.logoUpload || null,
    event: p.event || null,
    createdAt: p.createdAt,
    items: itemsByProfile[String(p._id)] || 0
  }));

  // === Highlights block (mode: recent|best|trending) ===
  let highlights = [];
  if (highlightsMode === 'best') {
    const agg = await BPItem.aggregate([
      { $group: { _id: '$profile', items: { $sum: 1 } } },
      { $sort: { items: -1 } },
      { $limit: highlightsLimit }
    ]);
    const ids = agg.map(a => a._id).filter(Boolean);
    const docs = ids.length ? await BusinessProfile.find({ _id: { $in: ids } })
      .select('_id name slug published logoUpload createdAt')
      .lean() : [];
    const countById = Object.fromEntries(agg.map(a => [String(a._id), a.items]));
    highlights = docs.map(p => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      published: !!p.published,
      logoUpload: p.logoUpload || null,
      createdAt: p.createdAt,
      items: countById[String(p._id)] || 0
    })).sort((a,b)=> (b.items||0)-(a.items||0));
  } else if (highlightsMode === 'trending') {
    const since = new Date(Date.now() - 30*24*60*60*1000); // last 30 days
    const agg = await BPItem.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$profile', items: { $sum: 1 } } },
      { $sort: { items: -1 } },
      { $limit: highlightsLimit }
    ]);
    const ids = agg.map(a => a._id).filter(Boolean);
    const docs = ids.length ? await BusinessProfile.find({ _id: { $in: ids } })
      .select('_id name slug published logoUpload createdAt')
      .lean() : [];
    const countById = Object.fromEntries(agg.map(a => [String(a._id), a.items]));
    highlights = docs.map(p => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      published: !!p.published,
      logoUpload: p.logoUpload || null,
      createdAt: p.createdAt,
      items: countById[String(p._id)] || 0
    })).sort((a,b)=> (b.items||0)-(a.items||0));
  } else {
    // recent
    const docs = await BusinessProfile.find({})
      .sort({ createdAt: -1 })
      .limit(highlightsLimit)
      .select('_id name slug published logoUpload createdAt')
      .lean();
    highlights = docs.map(p => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      published: !!p.published,
      logoUpload: p.logoUpload || null,
      createdAt: p.createdAt
    }));
  }

  // Back-compat: keep "recentProfiles" but trim to 5 as requested
  const recentProfilesDocs = await BusinessProfile.find({})
    .sort({ createdAt: -1 })
    .limit(5)
    .select('_id name slug published logoUpload createdAt')
    .lean();
  const recentProfiles = recentProfilesDocs.map(p => ({
    id: String(p._id),
    name: p.name, slug: p.slug, published: !!p.published,
    logoUpload: p.logoUpload || null,
    createdAt: p.createdAt
  }));

  res.json({
    ok: true,
    data: {
      totals: {
        profiles: totalProfiles,
        profilesPublished: publishedProfiles,
        profilesPending: pendingProfiles,
        items: totalItems,
        products: prodItems,
        services: servItems,
      },
      sectors,
      topProfiles,
      highlights: { mode: highlightsMode, list: highlights },
      recentProfiles
    }
  });
};

/* ===================== LIST / APPROVALS ===================== */
/** GET /admin/bp
 *  Query: q, published=(yes|no|all), page, limit, eventId?
 */
exports.adminListProfiles = async (req, res) => {
  const q = String(req.query.q || '').trim();
  const publishedQ = String(req.query.published || 'all').toLowerCase(); // yes|no|all
  const page = toInt(req.query.page, 1, 1, 100000);
  const limit = toInt(req.query.limit, 20, 1, 200);
  const eventId = req.query.eventId && isId(req.query.eventId) ? req.query.eventId : null;

  const filter = {};
  if (publishedQ === 'yes') filter.published = true;
  else if (publishedQ === 'no') filter.published = false;

  if (eventId) filter.event = eventId;

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    Object.assign(filter, {
      $or: [{ name: rx }, { tagline: rx }, { about: rx }, { industries: rx }]
    });
  }

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    BusinessProfile.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit)
      .select('_id name slug published featured logoUpload industries countries createdAt updatedAt')
      .lean(),
    BusinessProfile.countDocuments(filter)
  ]);

  res.json({
    ok: true,
    page, limit, total,
    data: rows.map(r => ({
      id: String(r._id),
      name: r.name,
      slug: r.slug,
      published: !!r.published,
      featured: !!r.featured,
      industries: r.industries || [],
      countries: r.countries || [],
      logoUpload: r.logoUpload || null,
      createdAt: r.createdAt, updatedAt: r.updatedAt
    }))
  });
};

/** PATCH /admin/bp/:profileId/publish  body: { published: true|false } */
exports.adminPublishProfile = async (req, res) => {
  const id = req.params.profileId;
  if (!isId(id)) return httpBad(res, 'Bad profileId');
  const flag = !!req.body.published;

  const p = await BusinessProfile.findByIdAndUpdate(
    id, { $set: { published: flag } }, { new: true }
  ).select('_id name slug published').lean();

  if (!p) return httpBad(res, 'Not found', 404);
  return res.json({ ok: true, data: { id: String(p._id), published: !!p.published } });
};

/** PATCH /admin/bp/publish  body: { ids:[...], published:true|false } */
exports.adminBulkPublish = async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(isId) : [];
  if (!ids.length) return httpBad(res, 'ids[] required');
  const flag = !!req.body.published;

  const r = await BusinessProfile.updateMany(
    { _id: { $in: ids } }, { $set: { published: flag } }
  );
  res.json({ ok: true, matched: r.matchedCount || r.n, modified: r.modifiedCount || r.nModified });
};

/** PATCH /admin/bp/:profileId/feature  body: { featured: true|false } */
exports.adminFeatureProfile = async (req, res) => {
  const id = req.params.profileId;
  if (!isId(id)) return httpBad(res, 'Bad profileId');
  const flag = !!req.body.featured;

  const p = await BusinessProfile.findByIdAndUpdate(
    id, { $set: { featured: flag } }, { new: true }
  ).select('_id name slug featured').lean();

  if (!p) return httpBad(res, 'Not found', 404);
  return res.json({ ok: true, data: { id: String(p._id), featured: !!p.featured } });
};

/* ===================== ADMIN TOOLS ===================== */
/** DELETE /admin/bp/:profileId  (cascades items) */
exports.adminDeleteProfile = async (req, res) => {
  const id = req.params.profileId;
  if (!isId(id)) return httpBad(res, 'Bad profileId');

  const p = await BusinessProfile.findById(id).select('_id').lean();
  if (!p) return httpBad(res, 'Not found', 404);

  const delItems = await BPItem.deleteMany({ profile: id });
  await BusinessProfile.findByIdAndDelete(id);

  res.json({ ok: true, deletedProfile: id, deletedItems: delItems?.deletedCount || 0 });
};

/** GET /admin/bp/items?profileId=&kind=&q=&page=&limit= */
exports.adminListItems = async (req, res) => {
  const page  = toInt(req.query.page, 1, 1, 100000);
  const limit = toInt(req.query.limit, 20, 1, 200);
  const q     = String(req.query.q || '').trim();
  const kind  = req.query.kind ? String(req.query.kind).toLowerCase().trim() : null;

  const profileId = req.query.profileId;
  if (!profileId || !isId(profileId)) {
    return res.status(400).json({ ok: false, message: 'profileId required' });
  }

  const filter = { profile: profileId };
  if (kind) filter.kind = kind;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    Object.assign(filter, { $or: [{ title: rx }, { summary: rx }, { details: rx }, { tags: rx }] });
  }

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    BPItem.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit)
      .select('_id profile kind sector subsectorName title summary pricingNote priceValue priceCurrency priceUnit thumbnailUpload published createdAt')
      .lean(),
    BPItem.countDocuments(filter),
  ]);

  res.json({
    ok: true, page, limit, total,
    data: rows.map(r => ({
      id: String(r._id),
      profile: String(r.profile),
      kind: r.kind || 'product',
      sector: r.sector || '',
      subsectorName: r.subsectorName || '',
      title: r.title || '',
      summary: r.summary || '',
      pricingNote: r.pricingNote || '',
      priceValue: typeof r.priceValue === 'number' ? r.priceValue : null,
      priceCurrency: r.priceCurrency || null,
      priceUnit: r.priceUnit || null,
      thumbnailUpload: r.thumbnailUpload || null,
      published: !!r.published,
      createdAt: r.createdAt
    }))
  });
};

/** DELETE /admin/bp/items/:itemId */
exports.adminDeleteItem = async (req, res) => {
  const id = req.params.itemId;
  if (!isId(id)) return httpBad(res, 'Bad itemId');
  const del = await BPItem.findByIdAndDelete(id).lean();
  if (!del) return httpBad(res, 'Not found', 404);
  res.json({ ok: true, deleted: id });
};

/** PATCH /admin/bp/items/:itemId/hide  body: { hidden: true|false } */
exports.adminHideItem = async (req, res) => {
  const id = req.params.itemId;
  if (!isId(id)) return httpBad(res, 'Bad itemId');
  const hidden = !!req.body.hidden;
  const it = await BPItem.findByIdAndUpdate(id, { $set: { 'adminFlags.hidden': hidden } }, { new: true })
    .select('_id adminFlags').lean();
  if (!it) return httpBad(res, 'Not found', 404);
  res.json({ ok: true, data: { id: String(it._id), hidden: !!(it.adminFlags && it.adminFlags.hidden) } });
};

/* ===================== TAXONOMY ADMIN ===================== */
/** GET /admin/bp/taxonomy  */
exports.adminTaxonomyList = async (req, res) => {
  const rows = await BPTaxonomy.find({}).sort({ sector: 1 }).lean();
  // Add usage counts from items
  const usage = await BPItem.aggregate([
    { $group: { _id: '$sector', c: { $sum: 1 } } }
  ]);
  const used = Object.fromEntries(usage.map(u => [String(u._id||'').toLowerCase(), u.c]));
  const data = rows.map(se => ({
    id: String(se._id),
    sector: se.sector,
    subsectors: (se.subsectors || []).map(sc => ({
      id: String(sc._id), name: sc.name, allowProducts: !!sc.allowProducts, allowServices: !!sc.allowServices
    })),
    usage: used[se.sector] || 0
  }));
  res.json({ ok: true, data });
};

/** POST /admin/bp/taxonomy/sector  body: { sector } */
exports.adminTaxonomyAddSector = async (req, res) => {
  const sector = normSectorName(req.body?.sector);
  if (!sector) return httpBad(res, 'sector required');
  const ex = await BPTaxonomy.findOne({ sector }).lean();
  if (ex) return httpBad(res, 'sector_exists', 409);
  const row = await BPTaxonomy.create({ sector, subsectors: [] });
  res.status(201).json({ ok: true, id: row._id, sector: row.sector });
};

/** POST /admin/bp/taxonomy/:sector/subsectors  body: { list:[{name,allowProducts,allowServices}] } */
exports.adminTaxonomyAddSubsectors = async (req, res) => {
  const sector = normSectorName(req.params.sector);
  const list = Array.isArray(req.body?.list) ? req.body.list : [];
  if (!sector) return httpBad(res, 'bad sector');
  if (!list.length) return httpBad(res, 'list[] required');

  const cleaned = list
    .map(x => ({
      name: normSectorName(x?.name),
      allowProducts: x?.allowProducts !== false,
      allowServices: x?.allowServices !== false
    }))
    .filter(x => x.name);

  if (!cleaned.length) return httpBad(res, 'no valid names');

  const t = await BPTaxonomy.findOneAndUpdate(
    { sector },
    { $push: { subsectors: { $each: cleaned } } },
    { new: true, upsert: false }
  ).lean();
  if (!t) return httpBad(res, 'sector_not_found', 404);

  res.json({
    ok: true,
    data: t.subsectors.map(s => ({ id: String(s._id), name: s.name, allowProducts: !!s.allowProducts, allowServices: !!s.allowServices }))
  });
};

/** DELETE /admin/bp/taxonomy/:sector */
exports.adminTaxonomyDeleteSector = async (req, res) => {
  const sector = normSectorName(req.params.sector);
  if (!sector) return httpBad(res, 'bad sector');

  const inUse = await BPItem.exists({ sector });
  if (inUse) return httpBad(res, 'sector_in_use', 409);

  const r = await BPTaxonomy.findOneAndDelete({ sector }).lean();
  if (!r) return httpBad(res, 'not_found', 404);
  res.json({ ok: true, deleted: sector });
};

/** DELETE /admin/bp/taxonomy/:sector/subsectors/:subId */
exports.adminTaxonomyDeleteSubsector = async (req, res) => {
  const sector = normSectorName(req.params.sector);
  const subId = req.params.subId;
  if (!sector || !isId(subId)) return httpBad(res, 'bad request');

  const inUse = await BPItem.exists({ sector, subsectorId: subId });
  if (inUse) return httpBad(res, 'subsector_in_use', 409);

  const r = await BPTaxonomy.findOneAndUpdate(
    { sector },
    { $pull: { subsectors: { _id: subId } } },
    { new: true }
  ).lean();
  if (!r) return httpBad(res, 'not_found', 404);

  res.json({ ok: true, deleted: subId });
};
exports.adminGetProfile = async (req, res) => {
  const id = req.params.id;
  if (!isId(id)) return res.status(400).json({ ok:false, message: "Bad profileId" });

  const p = await BusinessProfile.findById(id)
    .select([
      '_id','name','slug','tagline','about','size','industries','countries','languages',
      'offering','seeking','innovation','logoUpload','bannerUpload','gallery','contacts',
      'socials','published','featured','createdAt','updatedAt','event'
    ].join(' '))
    .lean();

  if (!p) return res.status(404).json({ ok:false, message: 'Not found' });

  // quick item counts
  const [totalItems, prodItems, servItems] = await Promise.all([
    BPItem.countDocuments({ profile: id }),
    BPItem.countDocuments({ profile: id, kind: 'product' }),
    BPItem.countDocuments({ profile: id, kind: 'service' }),
  ]);

  return res.json({
    ok: true,
    data: {
      id: String(p._id),
      name: p.name || '',
      slug: p.slug || '',
      tagline: p.tagline || '',
      about: p.about || '',
      size: p.size || '',
      industries: Array.isArray(p.industries) ? p.industries : [],
      countries: Array.isArray(p.countries) ? p.countries : [],
      languages: Array.isArray(p.languages) ? p.languages : [],
      offering: Array.isArray(p.offering) ? p.offering : [],
      seeking: Array.isArray(p.seeking) ? p.seeking : [],
      innovation: Array.isArray(p.innovation) ? p.innovation : [],
      logoUpload: p.logoUpload || null,
      bannerUpload: p.bannerUpload || null,
      gallery: Array.isArray(p.gallery) ? p.gallery : [],
      contacts: Array.isArray(p.contacts) ? p.contacts : [],
      socials: Array.isArray(p.socials) ? p.socials : [],
      published: !!p.published,
      featured: !!p.featured,
      createdAt: p.createdAt || null,
      updatedAt: p.updatedAt || null,
      event: p.event || null,
      itemsSummary: { total: totalItems, products: prodItems, services: servItems }
    }
  });
};