// controllers/selectsController.js
const asyncHdl = require('express-async-handler');
const Select   = require('../models/adminSelect');

/* Optional guard: require admin */
function ensureAdmin(req, res, next) {
  const u = req.user || {};
  if (u.isAdmin === true || String(u.role || '').toLowerCase() === 'admin') return next();
  return res.status(403).json({ message: 'Forbidden' });
} 
module.exports.ensureAdmin = ensureAdmin;

/* GET /admin/selects?page= */
module.exports.listSelects = asyncHdl(async (req, res) => {
  const { page } = req.query || {};
  const q = page ? { page } : {};
  const rows = await Select.find(q).sort({ page: 1, name: 1 }).lean();
  res.json({ success: true, count: rows.length, data: rows });
});

/* GET /admin/selects/pages  → unique pages */
module.exports.listPages = asyncHdl(async (_req, res) => {
  const rows = await Select.aggregate([
    { $group: { _id: '$page', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const data = rows.map(r => ({ page: r._id, count: r.count }));
  res.json({ success: true, count: data.length, data });
});

/* POST /admin/selects  { page, name|selectName, options?[] } */
module.exports.addSelect = asyncHdl(async (req, res) => {
  let { page, name, selectName, options } = req.body || {};
  page = String(page || '').trim();
  name = String(name || selectName || '').trim();
  options = Array.isArray(options) ? options : [];

  if (!page || !name) return res.status(400).json({ message: 'page and name are required' });

  // normalize options (drop empties, dedupe by key)
  const seen = new Set();
  const opts = [];
  for (const o of options) {
    const k = String(o?.key || '').trim();
    const v = String(o?.value || '').trim();
    if (!k || !v || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    opts.push({ key: k, value: v });
  }

  // uniqueness guard
  const exists = await Select.exists({ page, name });
  if (exists) return res.status(409).json({ message: 'Select already exists on this page' });

  const doc = await Select.create({ page, name, options: opts });
  res.status(201).json({ success: true, data: doc });
});

/* PATCH /admin/selects/:id
   Body can include:
   - name?: string
   - page?: string
   - optionsAdd?: [{key,value}]
   - optionsRemove?: [key, ...]
   - replaceOptions?: [{key,value}]   (mutually exclusive with optionsAdd/Remove)
*/
module.exports.updateSelect = asyncHdl(async (req, res) => {
  const { id } = req.params || {};
  const { name, page, optionsAdd, optionsRemove, replaceOptions } = req.body || {};
  
  const doc = await Select.findById(id);
  console.log("doc:",doc);
  if (!doc) return res.status(404).json({ message: 'Select not found' });

  if (typeof name === 'string' && name.trim()) doc.name = name.trim();
  if (typeof page === 'string' && page.trim()) doc.page = page.trim();

  if (Array.isArray(replaceOptions)) {
    // replace entirely (normalized)
    const seen = new Set();
    doc.options = [];
    for (const o of replaceOptions) {
      const k = String(o?.key || '').trim();
      const v = String(o?.value || '').trim();
      if (!k || !v || seen.has(k.toLowerCase())) continue;
      seen.add(k.toLowerCase());
      doc.options.push({ key: k, value: v });
    }
  } else {
    if (Array.isArray(optionsRemove) && optionsRemove.length) {
      const drop = new Set(optionsRemove.map(s => String(s || '').trim().toLowerCase()));
      doc.options = doc.options.filter(o => !drop.has(String(o.key).toLowerCase()));
    }
    if (Array.isArray(optionsAdd) && optionsAdd.length) {
      // upsert by key: update value if exists, else push
      const map = new Map(doc.options.map(o => [String(o.key).toLowerCase(), o]));
      for (const o of optionsAdd) {
        const k = String(o?.key || '').trim();
        const v = String(o?.value || '').trim();
        if (!k || !v) continue;
        const kl = k.toLowerCase();
        if (map.has(kl)) {
          map.get(kl).value = v;
        } else {
          const neo = { key: k, value: v };
          doc.options.push(neo);
          map.set(kl, neo);
        }
      }
    }
  }

  await doc.save();
  res.json({ success: true, data: doc });
});

/* DELETE /admin/selects/:id
   - If ?key= is present → remove that option by key.
   - Else delete the whole select.
*/
module.exports.deleteSelect = asyncHdl(async (req, res) => {
  const { id } = req.params || {};
  const { key } = req.query || {};

  const doc = await Select.findById(id);
  if (!doc) return res.status(404).json({ message: 'Select not found' });

  if (typeof key === 'string' && key.trim()) {
    const before = doc.options.length;
    const k = key.trim().toLowerCase();
    doc.options = doc.options.filter(o => String(o.key).toLowerCase() !== k);
    if (doc.options.length === before) return res.status(404).json({ message: 'Option not found' });
    await doc.save();
    return res.json({ success: true, data: doc });
  }

  await Select.deleteOne({ _id: id });
  res.json({ success: true, deleted: 1 });
});
module.exports.getSelectByName = async (req, res) => {
  try {
    let {  name, page, fuzzy } = req.params || req.query ||  {};
    name = name.replace("-"," ");
    const n = String(name || '').trim();
    if (!n) return res.status(400).json({ message: 'name required' });

    // escape regex specials
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const baseName = fuzzy === 'true'
      ? new RegExp(esc(n), 'i')                // contains, case-insensitive
      : new RegExp(`^${esc(n)}$`, 'i');        // exact, case-insensitive

    const q = { name: baseName };
    if (page && String(page).trim()) q.page = String(page).trim();

    if (q.page) {
      const doc = await require('../models/adminSelect').findOne(q).lean();
      if (!doc) return res.status(404).json({ message: 'Select not found' });
      return res.json({ success: true, data: doc });
    }

    const rows = await require('../models/adminSelect').find(q).sort({ page: 1, name: 1 }).lean();
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (e) {
    return res.status(500).json({ message: 'Lookup failed' });
  }
};