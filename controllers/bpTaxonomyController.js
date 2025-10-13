// controllers/bpTaxonomyController.js
const asyncHdl = require('express-async-handler');
const BPTaxonomy = require('../models/BPTaxonomy');
const { toStr } = require('../utils/bpUtil');

const mustAdmin = (req) => !!req.user?.isAdmin;
// GET /bp/taxonomy
exports.listTaxonomy = asyncHdl(async (_req, res) => {
  const docs = await BPTaxonomy.find({}).sort({ sector: 1 }).lean();
  res.json({ ok: true, data: docs });
});

// POST /bp/taxonomy/sector  { sector }
exports.upsertSector = asyncHdl(async (req, res) => {
  if (!mustAdmin(req)) return res.status(403).json({ message: 'Forbidden' });

  const sector = toStr(req.body?.sector, 60).toLowerCase();
  if (!sector) return res.status(400).json({ message: 'sector required' });

  const doc = await BPTaxonomy.findOneAndUpdate(
    { sector },
    { $setOnInsert: { sector } },
    { new: true, upsert: true }
  );

  res.status(201).json({ ok: true, data: doc });
});

// POST /bp/taxonomy/subsector
// body: { sector, subsectorId?, name, allowProducts=true, allowServices=true }
exports.upsertSubsector = asyncHdl(async (req, res) => {
  if (!mustAdmin(req)) return res.status(403).json({ message: 'Forbidden' });

  const sector = toStr(req.body?.sector, 60).toLowerCase();
  const name = toStr(req.body?.name, 60).toLowerCase();
  const allowProducts = req.body?.allowProducts !== false;
  const allowServices = req.body?.allowServices !== false;
  const subsectorId = req.body?.subsectorId;

  if (!sector) return res.status(400).json({ message: 'sector required' });
  if (!name && !subsectorId) return res.status(400).json({ message: 'name required' });

  const s = await BPTaxonomy.findOne({ sector });
  if (!s) return res.status(404).json({ message: 'Sector not found' });

  if (subsectorId) {
    const sub = s.subsectors.id(subsectorId);
    if (!sub) return res.status(404).json({ message: 'Subsector not found' });
    if (name) sub.name = name;
    sub.allowProducts = !!allowProducts;
    sub.allowServices = !!allowServices;
    await s.save();
    return res.json({ ok: true, data: s });
  }

  s.subsectors.push({ name, allowProducts: !!allowProducts, allowServices: !!allowServices });
  await s.save();
  res.status(201).json({ ok: true, data: s });
});
