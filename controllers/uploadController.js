// controllers/uploadController.js
const asyncHdl = require('express-async-handler');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuid } = require('uuid');

const UPLOAD_ROOT = path.resolve(__dirname, '../uploads'); // make sure this exists

// storage with date buckets
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, 'bp', new Date().toISOString().slice(0,10)); // YYYY-MM-DD
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${uuid()}${ext}`);
  }
});

// very basic mime whitelist
const ALLOWED = new Set([
  'image/png','image/jpeg','image/jpg','image/webp','image/gif',
  'application/pdf'
]);

function fileFilter(_req, file, cb) {
  if (ALLOWED.has(file.mimetype)) cb(null, true);
  else cb(new Error('Unsupported file type'), false);
}

const uploader = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// POST /uploads/single (field: file) → { url }
exports.uploadSingle = [
  uploader.single('file'),
  asyncHdl(async (req, res) => {
    if (!req.file?.path) return res.status(400).json({ message: 'file is required' });
    // build URL
    const rel = path.relative(UPLOAD_ROOT, req.file.path).replace(/\\/g,'/');
    const url = `/uploads/${rel}`;
    res.status(201).json({ ok:true, url, path: rel });
  })
];

// POST /uploads/multi (field: files[]) → { urls:[] }
exports.uploadMulti = [
  uploader.array('files', 12),
  asyncHdl(async (req, res) => {
    const urls = (req.files || []).map(f => {
      const rel = path.relative(UPLOAD_ROOT, f.path).replace(/\\/g,'/');
      return `/uploads/${rel}`;
    });
    if (!urls.length) return res.status(400).json({ message: 'No files' });
    res.status(201).json({ ok:true, urls });
  })
];
