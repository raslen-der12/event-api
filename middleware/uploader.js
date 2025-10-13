// middleware/uploader.js
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const fsp     = fs.promises;
const crypto  = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

/* ============================== Paths ============================== */
const ROOT_UPLOAD = path.resolve(__dirname, '../uploads');
const DIRS = Object.freeze({
  images: path.join(ROOT_UPLOAD, 'images'),
  videos: path.join(ROOT_UPLOAD, 'videos'),
  files : path.join(ROOT_UPLOAD, 'files')
});
for (const p of Object.values(DIRS)) fs.mkdirSync(p, { recursive: true });

/* =========================== Env & Limits ========================== */
const ALLOW_SVG   = (process.env.UPLOAD_ALLOW_SVG ?? 'true').toLowerCase() !== 'false';
const DATE_TREE   = (process.env.UPLOAD_DATE_TREE ?? 'true').toLowerCase() !== 'false';
const MAX_IMAGE   = Number(process.env.UPLOAD_MAX_IMAGE_BYTES || 5 * 1024 * 1024);        // 5MB
const MAX_VIDEO   = Number(process.env.UPLOAD_MAX_VIDEO_BYTES || 1 * 1024 * 1024 * 1024); // 1GB
const MAX_FILE    = Number(process.env.UPLOAD_MAX_FILE_BYTES  || 20 * 1024 * 1024);       // 20MB

/* ========================= Type Detection ========================== */
const IMAGE_MIMES = ['image/jpeg','image/jpg','image/png','image/gif','image/webp', ...(ALLOW_SVG ? ['image/svg+xml'] : [])];
const VIDEO_MIMES = ['video/mp4','video/quicktime','video/webm','video/x-matroska','video/ogg','application/octet-stream']; // last is fallback some phones use

const IMAGE_EXTS = ['.jpg','.jpeg','.png','.gif','.webp', ...(ALLOW_SVG ? ['.svg'] : [])];
const VIDEO_EXTS = ['.mp4','.mov','.qt','.webm','.mkv','.ogv'];

const isHttpUrl = s => /^https?:\/\/.+/i.test(String(s||''));

function guessCategory(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const ext  = (path.extname(file.originalname || '') || '').toLowerCase();

  if (IMAGE_MIMES.includes(mime) || IMAGE_EXTS.includes(ext)) return 'images';
  if (VIDEO_MIMES.includes(mime) || VIDEO_EXTS.includes(ext)) return 'videos';
  return 'files';
}

/* ======================= Safe Name Utilities ======================= */
function safeBase(original) {
  const base = path.basename(original || '', path.extname(original || ''));
  return base
    .normalize('NFKD')
    .replace(/[^\w\s.-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'file';
}
function shortRand(n=4){ return crypto.randomBytes(n).toString('hex'); }
function ymd(){ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return {y,m,day}; }

/* ===================== Filename STRATEGIES (built-in) ===================== */
/** strategy: timestampRandom(req, file, cb) */
function timestampRandom(req, file, cb){
  try {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const base = safeBase(file.originalname);
    const name = `${base}-${Date.now()}-${shortRand()}` + ext;
    cb(null, name);
  } catch(e){ cb(e); }
}
/** strategy: cryptoUUID(req, file, cb) */
function cryptoUUID(req, file, cb){
  try {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const name = `${crypto.randomUUID()}${ext}`;
    cb(null, name);
  } catch(e){ cb(e); }
}
/** strategy: dateOrganized(req, file, cb) - embeds yyyymmdd */
function dateOrganized(req, file, cb){
  try {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const base = safeBase(file.originalname);
    const {y,m,day} = ymd();
    const name = `${base}-${y}${m}${day}-${shortRand()}` + ext;
    cb(null, name);
  } catch(e){ cb(e); }
}
/** strategy: combination(req, file, cb) - slug + uuid + ts */
function combinationStrategy(req, file, cb){
  try {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const base = safeBase(file.originalname);
    const name = `${base}-${crypto.randomUUID()}-${Date.now()}` + ext;
    cb(null, name);
  } catch(e){ cb(e); }
}
const STRATEGIES = Object.freeze({
  'timestamp'      : timestampRandom,
  'uuid'           : cryptoUUID,
  'date-organized' : dateOrganized,
  'combination'    : combinationStrategy
});

/* ======================== Storage (dynamic dst) ======================== */
async function ensureDir(dir){ await fsp.mkdir(dir, { recursive:true }); }

function createStorage(strategy='combination'){
  const nameFn = STRATEGIES[strategy] || combinationStrategy;

  return multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        // sanitize name to avoid traversal via originalname
        file.originalname = path.basename(file.originalname || '');
        const cat = guessCategory(file); // images | videos | files
        let baseDir = DIRS[cat];

        // optional date tree: /YYYY/MM[/DD]
        if (DATE_TREE) {
          const { y, m } = ymd();
          baseDir = path.join(baseDir, y.toString(), m.toString());
        }

        await ensureDir(baseDir);
        cb(null, baseDir);
      } catch (e) { cb(e); }
    },
    filename: nameFn
  });
}

/* =========================== File Filter ============================ */
const SUSPICIOUS = ['.php','.js','.mjs','.cjs','.json','.exe','.bat','.cmd','.sh','.ps1','.dll','.so','.dylib'];

function buildFileFilter(accept='*'){
  return (_req, file, cb) => {
    const ext  = (path.extname(file.originalname || '') || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    // explicit accept ('image' | 'video' | 'file' | '*')
    const cat = guessCategory(file);
    if (accept !== '*' && cat !== (accept === 'file' ? 'files' : `${accept}s`)) {
      return cb(new Error(`Invalid file type for this endpoint`), false);
    }

    // allow images only from allow list
    if (cat === 'images') {
      if (!IMAGE_MIMES.includes(mime) && !IMAGE_EXTS.includes(ext))
        return cb(new Error('Invalid file type. Only images are allowed.'), false);
    }

    // allow videos (basic)
    if (cat === 'videos') {
      if (!VIDEO_MIMES.includes(mime) && !VIDEO_EXTS.includes(ext))
        return cb(new Error('Invalid video format.'), false);
    }

    // no suspicious double extensions
    const lower = (file.originalname || '').toLowerCase();
    for (const bad of SUSPICIOUS) if (lower.includes(bad)) {
      return cb(new Error('Suspicious file detected.'), false);
    }

    cb(null, true);
  };
}

/* ======================== Uploader Factory =========================
 * accept: '*' | 'image' | 'video' | 'file'
 * limits: per-type defaults; override via options.maxSize
 * strategy: 'combination' | 'timestamp' | 'uuid' | 'date-organized'
 * ==================================================================*/
function createUploadConfig({ accept='*', strategy='combination', maxSize } = {}){
  // choose sensible default per endpoint
  const size =
    maxSize ??
    (accept === 'image' ? MAX_IMAGE :
     accept === 'video' ? MAX_VIDEO :
     accept === 'file'  ? MAX_FILE  :
     Math.max(MAX_VIDEO, MAX_FILE));

  return multer({
    storage: createStorage(strategy),
    fileFilter: buildFileFilter(accept),
    limits: { fileSize: size, files: 10 } // up to 10 files unless you use .single()
  });
}

/* =================== Duplicate Detection (optional) ================== */
const CHUNK_BYTES = 512 * 1024; // 512KB quick hash

async function hashFile(filePath, bytes=0){
  const hash = crypto.createHash('md5');
  const stat = await fsp.stat(filePath);
  if (bytes > 0 && stat.size > bytes) {
    const fd = await fsp.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    await fd.read(buf, 0, bytes, 0);
    await fd.close();
    hash.update(buf);
    return { md5: hash.digest('hex'), size: stat.size };
  }
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', c => hash.update(c));
    stream.on('end',  () => resolve({ md5: hash.digest('hex'), size: stat.size }));
    stream.on('error', reject);
  });
}

async function checkForDuplicates(filePath){
  try {
    const quick = await hashFile(filePath, CHUNK_BYTES);
    const dir   = path.dirname(filePath);
    const files = await fsp.readdir(dir);

    for (const name of files) {
      const p = path.join(dir, name);
      if (p === filePath) continue;
      const st = await fsp.stat(p).catch(()=>null);
      if (!st || !st.isFile() || st.size !== quick.size) continue;

      const otherQuick = await hashFile(p, CHUNK_BYTES);
      if (otherQuick.md5 !== quick.md5) continue;

      const [a,b] = await Promise.all([hashFile(filePath,0), hashFile(p,0)]);
      if (a.md5 === b.md5) return { isDuplicate:true, existingFile:name, existingPath:p };
    }
    return { isDuplicate:false };
  } catch (e) {
    console.error('Duplicate check skipped:', e.message);
    return { isDuplicate:false };
  }
}

/* ====================== Multer Error Handler ======================= */
function handleAdvancedMulterError(err, _req, res, next){
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':      return res.status(400).json({ error:'File too large', message:'File exceeds size limit', code:'FILE_TOO_LARGE' });
      case 'LIMIT_FILE_COUNT':     return res.status(400).json({ error:'Too many files', message:'Reduce file count', code:'TOO_MANY_FILES' });
      case 'LIMIT_UNEXPECTED_FILE':return res.status(400).json({ error:'Unexpected file', message:'Field not allowed', code:'UNEXPECTED_FIELD' });
      default:                     return res.status(400).json({ error:'Upload error', message:err.message, code:'UPLOAD_ERROR' });
    }
  }
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('invalid file type'))  return res.status(400).json({ error:'Invalid type', message:'Not allowed here', code:'INVALID_TYPE' });
  if (msg.includes('invalid video'))      return res.status(400).json({ error:'Invalid video', message:'Unsupported video format', code:'INVALID_VIDEO' });
  if (msg.includes('suspicious'))         return res.status(400).json({ error:'Security violation', message:'Suspicious file detected', code:'SUSPICIOUS_FILE' });
  next(err);
}

/* ============================ Cleanup ============================== */
function cleanupFile(p){
  if (!p) return;
  fs.stat(p, (e, st) => { if (e || !st?.isFile()) return; fs.unlink(p, ()=>{}); });
}

/* ============================ Exports ============================== */
// Generic uploaders
const upload              = createUploadConfig({ accept:'*',     strategy:'combination' });
const timestampUpload     = createUploadConfig({ accept:'*',     strategy:'timestamp' });
const uuidUpload          = createUploadConfig({ accept:'*',     strategy:'uuid' });
const dateOrganizedUpload = createUploadConfig({ accept:'*',     strategy:'date-organized' });

// Specific helpers (single/array)
const imageUploader = createUploadConfig({ accept:'image' });
const videoUploader = createUploadConfig({ accept:'video' });
const fileUploader  = createUploadConfig({ accept:'file'  });

module.exports = {
  // strategy-based, any type
  upload,
  timestampUpload,
  uuidUpload,
  dateOrganizedUpload,

  // type-specific instances
  imageUploader,
  videoUploader,
  fileUploader,

  // factory for custom endpoints
  createUploadConfig,

  // utilities
  checkForDuplicates,
  handleAdvancedMulterError,
  cleanupFile
};
