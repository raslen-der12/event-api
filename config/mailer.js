// utils/mailer.js
const nodemailer = require('nodemailer');
require('dotenv').config({ path: '../.env' });

/* ----------------------------------------------------------------------------
 * Transporter
 * ------------------------------------------------------------------------- */
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE !== 'false', // default=true
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/* Optional: quick connection check on server start */
transporter.verify(err => {
  if (err) {
    console.error('❌  SMTP connection failed:', err);
  } else {
    console.log('📧  SMTP server is ready to take our messages');
  }
});

/* ----------------------------------------------------------------------------
 * Normalizers to avoid ESTREAM errors (arrays passed to streams)
 * ------------------------------------------------------------------------- */
function toStringSafe(val, joiner = '') {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (Buffer.isBuffer(val)) return val.toString('utf8');
  if (Array.isArray(val)) return val.map(v => toStringSafe(v, joiner)).join(joiner);
  // objects/numbers/booleans
  try { return String(val); } catch { return ''; }
}

function toBufferSafe(val) {
  if (val == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (Array.isArray(val)) {
    // Array of chunks -> concat to a single Buffer
    const parts = val.map(ch =>
      Buffer.isBuffer(ch) ? ch
      : (ch instanceof Uint8Array) ? Buffer.from(ch)
      : Buffer.from(toStringSafe(ch))
    );
    return Buffer.concat(parts);
  }
  // string/number/object -> to Buffer
  return Buffer.from(toStringSafe(val));
}

/**
 * Ensures nodemailer-compatible options:
 * - html/text become strings (joining arrays)
 * - attachments[].content becomes Buffer (concats arrays of chunks)
 * - flattens nested attachments arrays
 */
function normalizeMailOptions(opts = {}) {
  const out = { ...opts };

  // sender
  out.from = out.from || `"Event Portal" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;

  // recipients: nodemailer accepts string or string[]
  if (Array.isArray(out.to)) {
    out.to = out.to.flat().filter(Boolean);
  }

  // subject/html/text must be strings
  out.subject = toStringSafe(out.subject);
  if (out.html !== undefined) out.html = toStringSafe(out.html, '');
  if (out.text !== undefined) out.text = toStringSafe(out.text, '\n');

  // attachments normalization
  if (out.attachments) {
    out.attachments = []
      .concat(out.attachments)          // ensure array
      .flat(Infinity)                   // flatten nested arrays
      .filter(Boolean)                  // remove falsy
      .map(att => {
        const a = { ...att };
        if (a.content !== undefined) a.content = toBufferSafe(a.content);
        if (a.filename !== undefined) a.filename = toStringSafe(a.filename);
        if (a.contentType !== undefined) a.contentType = toStringSafe(a.contentType);
        return a;
      });
  }

  return out;
}

/* ----------------------------------------------------------------------------
 *  Generic mail helper
 *  sendMail(to, subject, html, text?, attachments?)
 * ------------------------------------------------------------------------- */
/**
 * @param {string|string[]} to
 * @param {string} subject
 * @param {string|array|buffer} html
 * @param {string|array|buffer} [text]
 * @param {Array} [attachments] nodemailer-style attachment objects
 */
async function sendMail(to, subject, html, text = '', attachments = undefined) {
  const mailOpts = normalizeMailOptions({
    from: `"Event Portal" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
    attachments
  });

  return transporter.sendMail(mailOpts);
}

/* ----------------------------------------------------------------------------
 * Convenience helper for 6-digit codes
 * ------------------------------------------------------------------------- */
async function sendCode(to, code, ttlMinutes = 10) {
  const html = `
    <p>Your verification code is:</p>
    <h2 style="letter-spacing:4px">${code}</h2>
    <p>This code expires in ${ttlMinutes} minutes.</p>`;
  return sendMail(to, 'Your verification code', html, `Code: ${code}`);
}

module.exports = { sendMail, sendCode, transporter };
