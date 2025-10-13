// controllers/bpSearchController.js
const asyncHdl = require('express-async-handler');
const mongoose = require('mongoose');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const { toLimit, makeRx } = require('../utils/bpUtil');
const BPFacets = require('../models/BPFacets');

// GET /bp/search?q=&sector=&country=&language=&eventId=&hasItems=&kind=&page=&limit=&sort=
exports.searchProfiles = asyncHdl(async (req, res) => {
  const {
    q = '',
    sector = '',
    country = '',
    language = '',
    eventId = '',
    hasItems = '',
    kind = '',            // 'product' | 'service' | '' (any)
    page = 1,
    limit = 20,
    sort = 'recent'       // 'recent' | 'popular' | 'name'
  } = req.query || {};

  const filters = { published: true };
  if (eventId && mongoose.isValidObjectId(eventId)) filters.event = eventId;
  if (sector) filters.industries = { $in: [String(sector).toLowerCase()] };
  if (country) filters.countries = { $in: [String(country).toLowerCase()] };
  if (language) filters.languages = { $in: [String(language).toLowerCase()] };

  let query = BusinessProfile.find(filters);
  if (q && String(q).trim()) {
    const rx = makeRx(q);
    query = query.find({
      $or: [
        { name: rx }, { tagline: rx }, { about: rx },
        { industries: rx }, { offering: rx }, { seeking: rx }, { innovation: rx }
      ]
    });
  }

  // hasItems & kind filter (join with BPItem via $lookup, but for perf use separate step)
  let idsByKind = null;
  if (hasItems || kind) {
    const itemMatch = {
      published: true,
      'adminFlags.hidden': { $ne: true }
    };
    if (kind) itemMatch.kind = String(kind).toLowerCase();
    if (filters.event) {
      // optional: only profiles from event (already in main filters)
    }
    const it = await BPItem.distinct('profile', itemMatch);
    idsByKind = new Set(it.map(String));
  }

  if (hasItems || kind) {
    query = query.find({ _id: { $in: [...idsByKind] } });
  }

  // sort strategy
  let sortSpec = { createdAt: -1 };
  if (sort === 'popular') sortSpec = { 'stats.views': -1, 'stats.likes': -1 };
  if (sort === 'name') sortSpec = { name: 1 };

  const pageNum = Math.max(1, Number(page) || 1);
  const perPage = toLimit(limit, 20, 100);

  const [rows, total] = await Promise.all([
    query
      .select('name slug tagline industries countries languages logoUpload stats owner role createdAt')
      .sort(sortSpec)
      .skip((pageNum - 1) * perPage)
      .limit(perPage)
      .lean(),
    BusinessProfile.countDocuments(query.getQuery()),
  ]);

  res.json({
    ok: true,
    page: pageNum,
    perPage,
    total,
    data: rows
  });
});

// GET /bp/items/search?q=&kind=&sector=&subsectorId=&eventId=&page=&limit=
exports.searchItems = asyncHdl(async (req, res) => {
  const {
    q = '', kind = '', sector = '', subsectorId = '', eventId = '',
    page = 1, limit = 20
  } = req.query || {};

  const match = {
    published: true,
    'adminFlags.hidden': { $ne: true }
  };
  if (kind) match.kind = String(kind).toLowerCase();
  if (sector) match.sector = String(sector).toLowerCase();
  if (subsectorId && mongoose.isValidObjectId(subsectorId)) match.subsectorId = new mongoose.Types.ObjectId(subsectorId);

  let agg = [
    { $match: match },
    { $lookup: {
        from: 'businessprofiles',
        localField: 'profile',
        foreignField: '_id',
        as: 'profile'
    }},
    { $unwind: '$profile' },
    { $match: { 'profile.published': true } }
  ];

  if (eventId && mongoose.isValidObjectId(eventId)) {
    agg.push({ $match: { 'profile.event': new mongoose.Types.ObjectId(eventId) } });
  }
  if (q && String(q).trim()) {
    const rx = makeRx(q);
    agg.push({ $match: { $or: [{ title: rx }, { summary: rx }, { details: rx }, { tags: rx }] } });
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const perPage = toLimit(limit, 20, 100);

  agg = agg.concat([
    { $sort: { createdAt: -1 } },
    { $facet: {
        data: [{ $skip: (pageNum - 1) * perPage }, { $limit: perPage }],
        meta: [{ $count: 'total' }]
    }}
  ]);

  const [out] = await BPItem.aggregate(agg);
  const data = out?.data || [];
  const total = out?.meta?.[0]?.total || 0;

  res.json({ ok: true, page: pageNum, perPage, total, data });
});

// GET /bp/facets?eventId=
exports.facets = asyncHdl(async (req, res) => {
  const { eventId = '' } = req.query || {};
  const match = { published: true };
  if (eventId && mongoose.isValidObjectId(eventId)) match.event = new mongoose.Types.ObjectId(eventId);

  const agg = await BusinessProfile.aggregate([
    { $match: match },
    { $project: { industries: 1, countries: 1, languages: 1 } },
    { $facet: {
      industries: [
        { $unwind: '$industries' },
        { $group: { _id: '$industries', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ],
      countries: [
        { $unwind: '$countries' },
        { $group: { _id: '$countries', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ],
      languages: [
        { $unwind: '$languages' },
        { $group: { _id: '$languages', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ]
    }}
  ]);

  res.json({ ok: true, data: agg?.[0] || { industries: [], countries: [], languages: [] } });
});
exports.getFacets = asyncHdl(async (req, res) => {
  // Preferred: explicit curated facets
  const fac = await BPFacets.findOne({ key: 'global' }).lean();

  // Fallbacks: infer from existing profiles if curated list missing
  let countries = fac?.countries || [];
  let languages = fac?.languages || [];

  if (!countries.length || !languages.length) {
    const agg = await BusinessProfile.aggregate([
      {
        $project: {
          countries: { $ifNull: ['$countries', []] },
          languages: { $ifNull: ['$languages', []] },
        }
      },
      {
        $group: {
          _id: null,
          countries: { $addToSet: '$countries' },
          languages: { $addToSet: '$languages' },
        }
      },
      {
        $project: {
          _id: 0,
          countries: { $setUnion: '$countries' },
          languages: { $setUnion: '$languages' },
        }
      }
    ]);

    if (agg?.[0]) {
      if (!countries.length) countries = agg[0].countries.filter(Boolean).sort();
      if (!languages.length) languages = agg[0].languages.filter(Boolean).sort();
    }
  }

  res.json({ ok: true, countries, languages });
});