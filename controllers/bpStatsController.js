// controllers/bpStatsController.js
const asyncHdl = require('express-async-handler');
const mongoose = require('mongoose');
const BusinessProfile = require('../models/BusinessProfile');
const BPItem = require('../models/BPItem');
const BPProfileRating = require('../models/BPProfileRating');
const { isId } = require('../utils/bpUtil');

function objId(id){ return new mongoose.Types.ObjectId(id); }

// GET /bp/:profileId/overview (public)
exports.getProfileOverview = asyncHdl(async (req, res) => {
  const { profileId } = req.params;
  if (!isId(profileId)) return res.status(400).json({ message: 'Bad profileId' });

  const prof = await BusinessProfile.findById(profileId)
    .select(
      [
        'clients', 'website', 'contacts', 'size', 'sizeRange', 'published',
        // possible sources for innovation/presence/compliance
        'innovation',                     // array of strings (your editor already writes this)
        'innovationStats',               // optional: { patents, rdSpendPct, techStack[] }
        'techStack',                     // optional legacy array of strings
        'countries', 'cities', 'locations', // locations sources
        'certifications',                // array of strings
        'compliance',                    // optional: { certifications: [] }
      ].join(' ')
    )
    .lean();
  if (!prof) return res.status(404).json({ message: 'Profile not found' });

  // counts
  const [prodCount, svcCount, ratingAgg] = await Promise.all([
    BPItem.countDocuments({ profile: profileId, kind: 'product', published: true }),
    BPItem.countDocuments({ profile: profileId, kind: 'service', published: true }),
    BPProfileRating.aggregate([
      { $match: { profile: objId(profileId) } },
      { $group: { _id: '$profile', avg: { $avg: '$value' }, count: { $sum: 1 } } },
    ]),
  ]);

  const clientsLen = Array.isArray(prof.clients) ? prof.clients.length : 0;
  const rating = ratingAgg?.[0]
    ? { avg: Number(ratingAgg[0].avg.toFixed(2)), count: ratingAgg[0].count }
    : { avg: 0, count: 0 };

  // quick facts
  const website =
    prof.website ||
    (prof.contacts && typeof prof.contacts === 'object' && prof.contacts.website) ||
    undefined;
  const employees = prof.sizeRange || prof.size || undefined;

  // ---------- Innovation (flexible: take what exists) ----------
  // Preferred: profile.innovationStats = { patents, rdSpendPct, techStack[] }
  // Fallback:  techStack: profile.techStack || profile.innovation (array of strings)
  const innovationStats = prof.innovationStats || {};
  const techStack =
    Array.isArray(innovationStats.techStack) && innovationStats.techStack.length
      ? innovationStats.techStack
      : Array.isArray(prof.techStack) && prof.techStack.length
      ? prof.techStack
      : Array.isArray(prof.innovation) && prof.innovation.length
      ? prof.innovation
      : [];

  const innovation = {
    patents: innovationStats.patents ?? null,
    rdSpendPct: innovationStats.rdSpendPct ?? null,
    techStack,
  };

  // ---------- Presence & Compliance ----------
  // locations from cities/locations/countries (whichever you have)
  const locations = []
    .concat(Array.isArray(prof.locations) ? prof.locations : [])
    .concat(Array.isArray(prof.cities) ? prof.cities : [])
    .concat(Array.isArray(prof.countries) ? prof.countries : []);
  const uniqLocations = Array.from(new Set(locations.filter(Boolean)));

  // certifications from profile.certifications or compliance.certifications
  const certs1 = Array.isArray(prof.certifications) ? prof.certifications : [];
  const certs2 = Array.isArray(prof.compliance?.certifications) ? prof.compliance.certifications : [];
  const certifications = Array.from(new Set([...certs1, ...certs2].filter(Boolean)));

  // build response
  const data = {
    // visible 0-values (always)
    clients: clientsLen,
    meetings: 0,
    deals: 0,

    // optional (hidden if zero — omitted here when zero)
    ...(prodCount > 0 ? { products: prodCount } : {}),
    ...(svcCount > 0 ? { services: svcCount } : {}),

    // rating + quick facts
    rating,
    facts: { website, employees },

    // new sections
    innovation,            // { patents, rdSpendPct, techStack[] }
    locations: uniqLocations,
    certifications,
  };

  return res.json({ ok: true, data });
});

// POST /bp/:profileId/innovation  (owner only)
exports.postProfileInnovation = asyncHdl(async (req, res) => {
  const { profileId } = req.params;
  if (!isId(profileId)) return res.status(400).json({ message: 'Bad profileId' });

  // simple owner check
  const prof = await BusinessProfile.findById(profileId).select('owner').lean();
  if (!prof) return res.status(404).json({ message: 'Profile not found' });
  const actorId = String(req.user?._id || req.user?.id || '');
  if (!actorId || String(prof.owner?.actor) !== actorId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { patents, rdSpendPct, techStack } = req.body || {};
  const patch = {
    innovationStats: {
      ...(Number.isFinite(patents) ? { patents: Number(patents) } : {}),
      ...(Number.isFinite(rdSpendPct) ? { rdSpendPct: Number(rdSpendPct) } : {}),
      ...(Array.isArray(techStack) ? { techStack: techStack.filter(Boolean).map(String) } : {}),
    },
  };

  await BusinessProfile.updateOne({ _id: profileId }, { $set: patch });
  res.status(201).json({ ok: true });
});

// POST /bp/:profileId/presence  (owner only)
exports.postProfilePresence = asyncHdl(async (req, res) => {
  const { profileId } = req.params;
  if (!isId(profileId)) return res.status(400).json({ message: 'Bad profileId' });

  const prof = await BusinessProfile.findById(profileId).select('owner').lean();
  if (!prof) return res.status(404).json({ message: 'Profile not found' });
  const actorId = String(req.user?._id || req.user?.id || '');
  if (!actorId || String(prof.owner?.actor) !== actorId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { locations = [], certifications = [] } = req.body || {};
  const patch = {
    locations: Array.isArray(locations) ? locations.filter(Boolean).map(String) : [],
    certifications: Array.isArray(certifications) ? certifications.filter(Boolean).map(String) : [],
  };

  await BusinessProfile.updateOne({ _id: profileId }, { $set: patch });
  res.status(201).json({ ok: true });
});

// rating endpoints unchanged from previous message…
exports.getProfileRating = asyncHdl(async (req, res) => {
  const { profileId } = req.params;
  if (!isId(profileId)) return res.status(400).json({ message: 'Bad profileId' });

  const agg = await BPProfileRating.aggregate([
    { $match: { profile: objId(profileId) } },
    { $group: { _id: '$profile', avg: { $avg: '$value' }, count: { $sum: 1 } } },
  ]);
  const rating = agg?.[0]
    ? { avg: Number(agg[0].avg.toFixed(2)), count: agg[0].count }
    : { avg: 0, count: 0 };

  res.json({ ok: true, rating });
});

exports.postProfileRating = asyncHdl(async (req, res) => {
  const { profileId } = req.params;
  const v = Number(req.body?.value);
  if (!isId(profileId)) return res.status(400).json({ message: 'Bad profileId' });
  if (!(v >= 1 && v <= 5)) return res.status(400).json({ message: 'value must be 1..5' });
  const raterId = req.user?._id || req.user?.id;
  if (!raterId) return res.status(401).json({ message: 'Unauthorized' });

  await BPProfileRating.findOneAndUpdate(
    { profile: profileId, rater: raterId },
    { $set: { value: v } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const agg = await BPProfileRating.aggregate([
    { $match: { profile: objId(profileId) } },
    { $group: { _id: '$profile', avg: { $avg: '$value' }, count: { $sum: 1 } } },
  ]);
  const rating = agg?.[0]
    ? { avg: Number(agg[0].avg.toFixed(2)), count: agg[0].count }
    : { avg: 0, count: 0 };

  res.status(201).json({ ok: true, rating });
});
