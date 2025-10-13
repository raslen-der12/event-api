// controllers/bpMediaController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const { isId } = require('../utils/bpUtil');

async function myProfile(req){
  const p = await BusinessProfile.findOne({ 'owner.actor': req.user?._id || req.user?.id });
  if (!p) { const e = new Error('Profile not found'); e.status = 404; throw e; }
  return p;
}

function pickMediaPayload(req) {
  const id  = req.body?.uploadId;
  const url = (req.body?.url || '').trim();
  const pth = (req.body?.path || '').trim();

  // prefer a valid ObjectId if present
  if (isId(id)) return { type: 'id', value: id };

  // otherwise accept url or path string
  const v = url || pth;
  if (v) return { type: 'url', value: v };

  return { type: null, value: null };
}
function pickUploadPath(body = {}) {
  const p = body.uploadPath || body.path || body.url || body.uploadId; // be liberal
  return (typeof p === 'string' && p.trim()) ? p.trim() : null;
}

// POST /bp/me/logo   { uploadPath | path | url | uploadId }
exports.setLogo = asyncHdl(async (req, res) => {
  const p = await myProfile(req);
  const up = pickUploadPath(req.body);
  if (!up) return res.status(400).json({ message: 'uploadPath (string) required' });
  p.logoUpload = up;                // string path
  await p.save();
  res.json({ ok: true, logoUpload: p.logoUpload });
});

// POST /bp/me/banner { uploadPath | path | url | uploadId }
exports.setBanner = asyncHdl(async (req, res) => {
  const p = await myProfile(req);
  const up = pickUploadPath(req.body);
  if (!up) return res.status(400).json({ message: 'uploadPath (string) required' });
  p.bannerUpload = up;              // string path
  await p.save();
  res.json({ ok: true, bannerUpload: p.bannerUpload });
});

// POST /bp/me/gallery/add   { uploadPaths: string[], OR uploadIds: string[], OR uploadPath/path/url: string }
exports.addToGallery = asyncHdl(async (req, res) => {
  const p = await myProfile(req);

  let list = [];
  if (Array.isArray(req.body.uploadPaths)) list = req.body.uploadPaths;
  else if (Array.isArray(req.body.uploadIds)) list = req.body.uploadIds; // accept legacy key
  else {
    const one = pickUploadPath(req.body);
    if (one) list = [one];
  }

  // keep only non-empty strings
  list = list.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());

  const set = new Set((p.gallery || []).map(String));
  list.forEach(v => set.add(v));
  p.gallery = Array.from(set);
  await p.save();
  res.json({ ok: true, gallery: p.gallery });
});

// POST /bp/me/gallery/remove  { uploadPath | path | url | uploadId }
exports.removeFromGallery = asyncHdl(async (req, res) => {
  const p = await myProfile(req);
  const up = pickUploadPath(req.body);
  if (!up) return res.status(400).json({ message: 'uploadPath (string) required' });
  p.gallery = (p.gallery || []).filter(x => String(x) !== String(up));
  await p.save();
  res.json({ ok: true, gallery: p.gallery });
});
exports.setLegalDoc = asyncHdl(async (req, res) => {
  const { path } = req.body || {};
  if (!path) return res.status(400).json({ message: 'path is required' });
  console.log(req.user._id );
  const prof = await BusinessProfile.findOne({ 'owner.actor' : req.user._id });
  if (!prof) return res.status(404).json({ message: 'Profile not found' });

  // store as string path (same strategy we used for logo/banner)
  prof.legalDocPath = path;
  await prof.save();

  res.json({ ok: true, data: { legalDocPath: prof.legalDocPath } });
});