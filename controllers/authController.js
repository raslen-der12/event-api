/**************************************************************************************************
 *  LOGIN
 *  -----
 *  • Understands the **new schemas**:
 *       – attendee.personal.email
 *       – Exhibitor.identity.email           (and identity.exhibitorName for “username” sign-in)
 *       – Speaker.personal.email
 *  • Still supports Admin login with plain `email` field.
 *  • If the credential typed by the user is *not* an e-mail address, we fall back to the
 *    “display name” fields so someone can sign in with a stand name or full name.
**************************************************************************************************/
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const Admin     = require('../models/admin');
const attendee  = require('../models/attendee');
const Exhibitor = require('../models/exhibitor');
const ActorNotification = require('../models/actorNotification');
const Event = require('../models/event'); // model name is "Event" (capital E); change path if needed

const Speaker   = require('../models/speaker');
const { sendMail } = require('../config/mailer');
const RoleBusinessOwner = require('../models/roles/BusinessOwner');
const RoleInvestor      = require('../models/roles/Investor');
const RoleConsultant    = require('../models/roles/Consultant');
const RoleExpert        = require('../models/roles/Expert');
const RoleEmployee      = require('../models/roles/Employee');
const RoleStudent       = require('../models/roles/Student');
const { makeQrPdf } = require('../utils/qrProfilePdf');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const { randomBytes } = require('crypto');
const Schedule = require('../models/eventModels/schedule');
const programRoom = require('../models/programRoom');
const sessionRegistration = require('../models/sessionRegistration');
require('dotenv').config({ path: '../.env' });
const toStr = (v) => (v == null ? '' : String(v));
const normBool = (v) => ['1','true','yes','y','on'].includes(toStr(v).toLowerCase());
const csvToArr = (v) => toStr(v).split(',').map(s => s.trim()).filter(Boolean);
const isId = (v) => mongoose.isValidObjectId(v);



// ---- Cross-collection email uniqueness helpers ----
function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

// Safe require so missing models don't break the app
function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

// Adjust paths if your model paths differ
const EMAIL_MODELS = {
  Attendee      : safeRequire('../models/attendee'),
  Exhibitor     : safeRequire('../models/exhibitor'),
  Speaker       : safeRequire('../models/speaker'),
  Employee      : safeRequire('../models/Employee'),      // admin/backoffice accounts, if applicable
  Student       : safeRequire('../models/Student'),       // if you allow student login via email
  Expert        : safeRequire('../models/Expert'),
  Investor      : safeRequire('../models/Investor'),
  Consultant    : safeRequire('../models/Consultant'),
  BusinessOwner : safeRequire('../models/BusinessOwner'),
  // add any other account-bearing collections here
};


// pull + set email by role
function getRoleEmail(doc, role){
  switch(role){
    case 'attendee' : return doc.personal?.email;
    case 'speaker'  : return doc.personal?.email;
    case 'exhibitor': return doc.identity?.email;
    case 'admin'    : return doc.email;
    default         : return '';
  }
}
function setRoleEmail(doc, role, newEmail){
  switch(role){
    case 'attendee' : doc.personal.email  = newEmail; break;
    case 'speaker'  : doc.personal.email  = newEmail; break;
    case 'exhibitor': doc.identity.email  = newEmail; break;
    case 'admin'    : doc.email           = newEmail; break;
  }
}

// firstEmail (registration e-mail) — read-only reference address for alerts
function getRoleFirstEmail(doc, role){
  switch(role){
    case 'attendee' : return doc.personal?.firstEmail || doc.personal?.email;
    case 'speaker'  : return doc.personal?.firstEmail || doc.personal?.email;
    case 'exhibitor': return doc.identity?.firstEmail || doc.identity?.email;
    case 'admin'    : return doc.email;
    default         : return '';
  }
}

/**
 * Check if an email exists in ANY of the account models.
 * Optionally exclude one specific document (during profile updates).
 */
async function emailExistsAnywhere(rawEmail, exclude = null) {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;

  const queries = [];
  for (const [name, M] of Object.entries(EMAIL_MODELS)) {
    if (!M) continue;
    const q = { email };
    if (exclude && exclude.model === name && exclude.id) {
      q._id = { $ne: exclude.id };
    }
    queries.push(M.exists(q)); // fast existence check
  }

  const results = await Promise.all(queries);
  return results.some(Boolean);
}

/** Throw HTTP 409 if email is already in use across the platform */
async function assertEmailAvailableEverywhere(rawEmail) {
  const taken = await emailExistsAnywhere(rawEmail);
  if (taken) {
    const err = new Error('EMAIL_TAKEN_GLOBAL');
    err.statusCode = 409;
    throw err;
  }
}


/* ───────────────────────── Helper regexes ─────────────────────────── */
const EMAIL_RX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const publicProfileUrl = (role, id) => `${process.env.FRONTEND_URL}/profile/${id}`;

// seats helpers — tolerate different field names on Schedule, and fallback to room capacity
function readSessionCapacity(schedDoc) {
  const v =
    schedDoc.capacity ??
    schedDoc.seatLimit ??
    schedDoc.maxSeats ??
    (schedDoc.roomId && typeof schedDoc.roomId.capacity === 'number' ? schedDoc.roomId.capacity : undefined);
  return Number.isFinite(v) && v > 0 ? Number(v) : 0; // 0 => unbounded
}

async function loadSeatCounts(sessionIds) {
  if (!sessionIds.length) return new Map();
  const rows = await sessionRegistration.aggregate([
    { $match: { sessionId: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }, status: 'registered' } },
    { $group: { _id: '$sessionId', n: { $sum: 1 } } }
  ]);
  const byId = new Map();
  for (const r of rows) byId.set(String(r._id), r.n);
  return byId;
}

/**
 * Enrich normalized sessions with seats { capacity, taken, remaining }
 * and (optionally) enforce capacity at registration time.
 */
async function attachSeatsAndEnforce({ normSessions, enforce=false }) {
  const ids = normSessions.map(s => s._id);
  const takenMap = await loadSeatCounts(ids);

  // We'll also try to increment Schedule.seatsTaken if your schema has it (best-effort).
  const willInc = [];

  for (const s of normSessions) {
    const cap = readSessionCapacity(s.__raw || {});
    const taken = takenMap.get(String(s._id)) || 0;
    const remaining = cap > 0 ? Math.max(0, cap - taken) : null;

    s.seats = { capacity: cap, taken, remaining }; // <- name it like “other data expect it”

    if (enforce && cap > 0 && remaining === 0) {
      const err = new Error('SESSION_FULL');
      err.sessionId = String(s._id);
      throw err;
    }

    // If your Schedule has seatsTaken, we’ll update it after successful insertMany
    if (cap > 0) willInc.push({ id: s._id });
  }
  return { willInc };
}

// Best-effort: bump seatsTaken on Schedule (if that numeric field exists)
async function bumpScheduleSeatsTaken(sessionIds, delta = 1) {
  if (!sessionIds.length) return;
  try {
    await Schedule.updateMany(
      { _id: { $in: sessionIds } , seatsTaken: { $type: 'number' } },
      { $inc: { seatsTaken: delta } }
    );
  } catch (_) { /* ignore — field may not exist in your schema */ }
}



// --- helpers at top of authController.js ---

async function buildRegistrationPdf({ event, actor, role, sessions }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 }); // 0.5" margins
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header with logo
    const brandLogoPath = process.env.BRAND_LOGO_PATH && path.resolve(process.env.BRAND_LOGO_PATH);
    if (brandLogoPath && fs.existsSync(brandLogoPath)) {
      doc.image(brandLogoPath, 36, 24, { fit: [120, 40] });
    }
    doc
      .fontSize(18)
      .text(event?.title || 'Event', 36, 78, { align: 'left', continued: false })
      .moveDown(0.5);
    doc
      .fontSize(10)
      .fillColor('#555')
      .text(
        `${new Date(event?.startDate || Date.now()).toLocaleDateString()} → ${new Date(event?.endDate || Date.now()).toLocaleDateString()} • ${event?.city || ''} ${event?.country ? '• ' + event.country : ''}`
      )
      .moveDown(1);

    // ── Actor block
    const who = role === 'exhibitor'
      ? (actor?.identity?.contactName || actor?.identity?.exhibitorName || 'Participant')
      : (actor?.personal?.fullName || 'Participant');

    doc.fillColor('#000').fontSize(14).text(`Registration confirmation — ${who}`);
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor('#333').text(`Role: ${role}`);
    if (role === 'exhibitor') {
      doc.text(`Brand: ${actor?.identity?.exhibitorName || '—'}`);
    }
    doc.moveDown(0.8);

    // ── Sessions table
    doc.fontSize(13).fillColor('#000').text('Registered sessions', { underline: true });
    doc.moveDown(0.5);

    const rows = (sessions || []).map(s => {
      const start = s.startAt || s.startTime || s.startsAt || s.start || s.timeStart;
      const end   = s.endAt   || s.endTime   || s.endsAt   || s.end   || s.timeEnd;
      const startStr = start ? new Date(start).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      const endStr   = end   ? new Date(end).toLocaleString([], { hour: '2-digit', minute: '2-digit' })   : '—';
      return {
        title: s.title || s.sessionTitle || 'Untitled',
        time:  `${startStr} – ${endStr}`,
        room:  (s.room?.name || s.roomName || '—'),
        track: s.track || '—'
      };
    });

    // table header
    doc.fontSize(11).fillColor('#111');
    doc.text('Time', 36, doc.y, { continued: true, width: 110 });
    doc.text('Title', 36 + 110, doc.y, { continued: true, width: 260 });
    doc.text('Room', 36 + 110 + 260, doc.y, { continued: true, width: 90 });
    doc.text('Track', 36 + 110 + 260 + 90, doc.y, { width: 90 });
    doc.moveTo(36, doc.y + 2).lineTo(559, doc.y + 2).strokeColor('#999').lineWidth(0.5).stroke();
    doc.moveDown(0.4);

    rows.forEach(r => {
      doc.fillColor('#222');
      doc.text(r.time, 36, doc.y, { continued: true, width: 110 });
      doc.text(r.title, 36 + 110, doc.y, { continued: true, width: 260 });
      doc.text(r.room, 36 + 110 + 260, doc.y, { continued: true, width: 90 });
      doc.text(r.track, 36 + 110 + 260 + 90, doc.y, { width: 90 });
      doc.moveDown(0.2);
    });

    doc.moveDown(1.2);
    // ── Footer
    doc
      .fontSize(10)
      .fillColor('#555')
      .text('Best regards,', { align: 'left' })
      .text('GITS Team')
      .moveDown(0.2)
      .fillColor('#999')
      .text('This PDF is attached to your confirmation email.');

    doc.end();
  });
}









const ROLE_KIND = Object.freeze({
  BUSINESS_OWNER: 'Business Owner',
  INVESTOR: 'Investor',
  CONSULTANT: 'Consultant',
  EXPERT: 'Expert',
  EMPLOYEE: 'Employee',
  STUDENT: 'Student'
});
function normalizeRoleKind(input){
  const s = String(input||'').trim().toLowerCase();
  if (['business owner','owner','business_owner'].includes(s)) return ROLE_KIND.BUSINESS_OWNER;
  if (['investor'].includes(s)) return ROLE_KIND.INVESTOR;
  if (['consultant'].includes(s)) return ROLE_KIND.CONSULTANT;
  if (['expert'].includes(s)) return ROLE_KIND.EXPERT;
  if (['employee'].includes(s)) return ROLE_KIND.EMPLOYEE;
  if (['student'].includes(s)) return ROLE_KIND.STUDENT;
  return null;
}
async function createRoleDoc({ actorDoc, baseActorType, roleKind, roleData={} }){
  switch(roleKind){
    case ROLE_KIND.BUSINESS_OWNER:
      return await RoleBusinessOwner.create({
        actor: actorDoc._id,
        businessName: roleData.businessName || actorDoc?.identity?.orgName || actorDoc?.organization?.orgName || 'Business',
        email: roleData.email || (baseActorType==='exhibitor' ? actorDoc.identity.email : actorDoc.personal?.email),
        country: roleData.country || (actorDoc.personal?.country || actorDoc.identity?.country),
        shortDescription: roleData.shortDescription || '',
        website: roleData.website || '',
        businessType: roleData.businessType || undefined,
        sector: roleData.sector || undefined,
        subSectors: roleData.subSectors || [],
        businessSize: roleData.businessSize || undefined
      });
    case ROLE_KIND.INVESTOR:
      return await RoleInvestor.create({
        actor: actorDoc._id,
        name: roleData.name || roleData.investorName || 'Investor',
        investorType: roleData.investorType || 'Individual',
        focusSectors: roleData.focusSectors || [],
        ticketMin: roleData.ticketMin || undefined,
        ticketMax: roleData.ticketMax || undefined,
        stagePreference: roleData.stagePreference || [],
        countryPreference: roleData.countryPreference || [],
        website: roleData.website || '',
        linkedin: roleData.linkedin || '',
        contactEmail: roleData.contactEmail || (actorDoc.personal?.email),
        contactPhone: roleData.contactPhone || ''
      });
    case ROLE_KIND.CONSULTANT:
      return await RoleConsultant.create({
        actor: actorDoc._id,
        expertiseArea: roleData.expertiseArea || 'Consulting',
        sectors: roleData.sectors || [],
        experienceYears: roleData.experienceYears || 0,
        certifications: roleData.certifications || [],
        servicesOffered: roleData.servicesOffered || [],
        hourlyRate: roleData.hourlyRate || undefined,
        portfolioLinks: roleData.portfolioLinks || [],
        availability: roleData.availability || 'Available'
      });
    case ROLE_KIND.EXPERT:
      return await RoleExpert.create({
        actor: actorDoc._id,
        expertiseTitle: roleData.expertiseTitle || 'Expert',
        sector: roleData.sector || '',
        experienceYears: roleData.experienceYears || 0,
        skills: roleData.skills || [],
        publications: roleData.publications || [],
        linkedin: roleData.linkedin || '',
        availability: roleData.availability || 'Available'
      });
    case ROLE_KIND.EMPLOYEE:
      return await RoleEmployee.create({
        actor: actorDoc._id,
        currentPosition: roleData.currentPosition || 'Employee',
        companyName: roleData.companyName || '',
        experienceYears: roleData.experienceYears || 0,
        skills: roleData.skills || [],
        careerGoals: roleData.careerGoals || '',
        education: roleData.education || ''
      });
    case ROLE_KIND.STUDENT:
      return await RoleStudent.create({
        actor: actorDoc._id,
        fullName: roleData.fullName || actorDoc.personal?.fullName,
        university: roleData.university || '',
        fieldOfStudy: roleData.fieldOfStudy || '',
        graduationYear: roleData.graduationYear || undefined,
        skills: roleData.skills || [],
        interests: roleData.interests || [],
        portfolio: roleData.portfolio || ''
      });
    default:
      return null;
  }
}
async function buildRegistrationPdf({ event, actor, role, sessions }) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));

  // Optional logo in header
  const logoPath = process.env.BRAND_LOGO_PATH && path.resolve(process.env.BRAND_LOGO_PATH);
  if (logoPath && fs.existsSync(logoPath)) {
    doc.image(logoPath, 36, 24, { fit: [120, 40] });
  }

  // Event title & meta
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#000')
     .text(event?.title || 'Event', 36, 78);
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica').fillColor('#555')
     .text(`${new Date(event?.startDate || Date.now()).toLocaleDateString()} → ${new Date(event?.endDate || Date.now()).toLocaleDateString()}`)
     .text([event?.city, event?.country].filter(Boolean).join(' • '));
  doc.moveDown(0.6);
  doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#ddd').stroke();

  // Two-column header: left (event + actor), right (QR)
  const yTop = doc.y + 12;

  // Left column details
  doc.save();
  doc.font('Helvetica-Bold').fillColor('#000').fontSize(13).text('Registration', 36, yTop);
  doc.moveDown(0.3).font('Helvetica').fontSize(11).fillColor('#111');

  if (role === 'exhibitor') {
    doc.text(`Brand: ${actor?.identity?.exhibitorName || ''}`);
    doc.text(`Contact: ${actor?.identity?.contactName || ''}`);
    doc.text(`Email: ${actor?.identity?.email || ''}`);
    if (actor?.identity?.country) doc.text(`Country: ${actor.identity.country}`);
  } else {
    doc.text(`Participant: ${actor?.personal?.fullName || ''}`);
    doc.text(`Email: ${actor?.personal?.email || ''}`);
    if (actor?.organization?.orgName) doc.text(`Organization: ${actor.organization.orgName}`);
    if (actor?.personal?.country) doc.text(`Country: ${actor.personal.country}`);
  }
  doc.restore();

  // Right column QR
  const qrUrl = publicProfileUrl(role, actor?._id);
  const qrPng = await QRCode.toBuffer(qrUrl, { width: 140, margin: 0 });
  doc.image(qrPng, 559 - 140, yTop, { width: 140 });

  // Sessions table
  doc.moveTo(36, yTop + 140).lineTo(559, yTop + 140).strokeColor('#eee').stroke();
  doc.font('Helvetica-Bold').fillColor('#000').fontSize(12).text('Your selected sessions', 36, yTop + 152);

  const cols = [36, 140, 360, 480]; // Time, Title, Room, Track x-positions
  let y = doc.y + 6;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Time', cols[0], y);
  doc.text('Title', cols[1], y);
  doc.text('Room', cols[2], y);
  doc.text('Track', cols[3], y);
  y += 14;
  doc.moveTo(36, y).lineTo(559, y).strokeColor('#ddd').stroke();
  y += 6;

  doc.font('Helvetica').fillColor('#111');
  (sessions || []).forEach(s => {
    const startStr = s.startAt ? new Date(s.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    const endStr   = s.endAt   ? new Date(s.endAt).toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit' }) : '—';
    doc.text(`${startStr}–${endStr}`, cols[0], y, { width: cols[1]-cols[0]-8 });
    doc.text(s.title || 'Untitled',   cols[1], y, { width: cols[2]-cols[1]-8 });
    doc.text(s.room?.name || '',      cols[2], y, { width: cols[3]-cols[2]-8 });
    doc.text(s.track || '',           cols[3], y, { width: 559-cols[3]-8 });
    y += 16;
    if (y > 770) { doc.addPage(); y = 60; }
  });

  // Footer
  doc.moveDown(1);
  doc.fontSize(10).fillColor('#555')
     .text('Best regards,')
     .text('GITS Team');

  doc.end();
  return done;
}

function escapeHtml(s='') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}
// Fetch sessions by ids and ensure they belong to the same event
async function loadAndValidateSessions(eventId, sessionIds = []) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter(isId);
  if (!ids.length) return [];

  const rows = await Schedule.find({ _id: { $in: ids } })
    .select('sessionTitle startTime endTime track roomId id_event capacity seatLimit maxSeats seatsTaken')
    .populate({ path: 'roomId', model: programRoom, select: 'name capacity' })
    .lean();

  if (!rows.length) return [];

  for (const s of rows) {
    if (String(s.id_event) !== String(eventId)) {
      throw new Error('One or more sessions do not belong to this event');
    }
  }

  return rows.map(s => ({
    _id: s._id,
    title: s.sessionTitle || 'Untitled',
    track: s.track || '',
    startAt: s.startTime ? new Date(s.startTime) : null,
    endAt:   s.endTime   ? new Date(s.endTime)   : null,
    room: { name: s.roomId?.name || '' },
    __raw: s, // keep original for capacity reading
  }));
}

// Create SessionRegistration docs in bulk (ignore duplicates gracefully)
async function createSessionRegs({ actorId, actorRole, eventId, sessions=[] }) {
  if (!sessions.length) return;
  const docs = sessions.map(s => ({
    actorId, actorRole, eventId,
    sessionId: s._id,
    status: 'registered'
  }));
  await sessionRegistration.insertMany(docs, { ordered: false }).catch(() => {});
}
/* ───────────────────────── LOGIN HANDLER ──────────────────────────── */
exports.login = asyncHandler(async (req, res) => {
  let {  loginInput, pwd } = req.body;
  if (!loginInput || !pwd){ return res.status(400).json({ message: 'Email/username and password are required' });}

  loginInput = loginInput.trim();
  pwd        = pwd.trim();

  const isEmail = EMAIL_RX.test(loginInput);

  /* 1️⃣  Build search order – admins last */
  const lookups = [
    // attendee
    {
      model : attendee,
      where : isEmail
              ? { 'personal.email' : loginInput.toLowerCase() }
              : { 'personal.fullName': loginInput },
      role  : 'attendee'
    },
    // EXHIBITOR
    {
      model : Exhibitor,
      where : isEmail
              ? { 'identity.email' : loginInput.toLowerCase() }
              : { 'identity.exhibitorName': loginInput },
      role  : 'exhibitor'
    },
    // SPEAKER
    {
      model : Speaker,
      where : isEmail
              ? { 'personal.email': loginInput.toLowerCase() }
              : { 'personal.fullName': loginInput },
      role  : 'speaker'
    },
    // ADMIN
    {
      model : Admin,
      where : { email: loginInput.toLowerCase() },
      role  : 'admin'
    }
  ];

  /* 2️⃣  Find the first matching document */
  let foundUser = null, role = null;
  for (const { model, where, role: r } of lookups) {
    foundUser = await model.findOne(where).select('+pwd').exec();
    if (foundUser) { role = r; break; }
  }

  if (!foundUser)
    return res.status(403).json({ message: 'Incorrect credentials' });

  /* 3️⃣  Password check */
  const ok = await bcrypt.compare(pwd, foundUser.pwd);
  if (!ok)
    return res.status(403).json({ message: 'Incorrect credentials' });

  /* 4️⃣  JWTs */
  const accessToken = jwt.sign(
    { UserInfo: { email: loginInput.toLowerCase(), role ,ActorId: foundUser["_id"]} },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { email: loginInput.toLowerCase(), role ,ActorId: foundUser._id.toString()},
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }
  );

  /* 5️⃣  Cookie + response */
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('jwt', refreshToken, {
    httpOnly : true,
    secure   : isProduction,
    sameSite : isProduction,
    maxAge   : 7 * 24 * 60 * 60 * 1000
  });
  res.json({
    success : true,
    message : 'Login successful',
    data    : {
      accessToken,
      actorId   : foundUser._id,
      tokenType : 'Bearer',
      expiresIn : '15m'
    }
  });
});
exports.refresh = asyncHandler(async (req, res) => {

  /* 0️⃣  Must have cookie */
  const refreshToken = req.cookies?.jwt;
  if (!refreshToken) return res.status(401).json({ message: 'Unauthorized' });

  /* 1️⃣  Verify refresh JWT */
  let payload;
  try {
    payload = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    // payload = { email, role }
  } catch {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { email, role } = payload;
  if (!email || !role) return res.status(400).json({ message: 'Bad token' });

  /* 2️⃣  Look up user in the appropriate collection */
  let foundUser = null;

  switch (role) {
    case 'attendee':
      foundUser = await attendee.findOne({ 'personal.email': email }).exec();
      break;
    case 'exhibitor':
      foundUser = await Exhibitor.findOne({ 'identity.email': email }).exec();
      break;
    case 'speaker':
      foundUser = await Speaker.findOne({ 'personal.email': email }).exec();
      break;
    case 'admin':
      foundUser = await Admin.findOne({ email }).exec();
      break;
    default:
      return res.status(400).json({ message: 'Unknown role' });
  }

  if (!foundUser) return res.status(401).json({ message: 'Unauthorized' });

  /* 3️⃣  Sign new access token */
  const accessToken = jwt.sign(
    { UserInfo: { email, role ,ActorId: foundUser._id.toString() } },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '15m' }
  );

  /* 4️⃣  Send fresh access-token */
  res.json({
    accessToken,
    ActorId: foundUser._id.toString(),
    role
  });
});
/**************************************************************************************************
 *  REGISTRATION + EMAIL-VERIFICATION
 *  -------------------------------------------------------------------
 *  Shared helpers first, then three role-specific handlers.
 **************************************************************************************************/


/* ─── helper: create verification token & e-mail ───────────────────── */
async function issueVerification(userDoc, email, role) {
  const raw  = randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(raw, 12);

  userDoc.verifyToken   = hash;
  userDoc.verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 h
  await userDoc.save();

  const link = `${process.env.FRONTEND_URL}/verify-email?token=${raw}&role=${role}&id=${userDoc._id}`;
  await sendMail(email, 'Verify your e-mail', `
    <p>Hello ${email.split('@')[0]},</p>
    <p>Please verify your e-mail by clicking the link below:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link expires in 24 hours.</p>
  `);
}
function sendDbError(err, res, fallback = 'Registration failed') {
  // Duplicate key (any unique index, not only email)
  if (err && (err.code === 11000 || err.code === 11001)) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    return res.status(409).json({ message: `${field} must be unique`, details: err.keyValue || undefined });
  }
  // Schema validation
  if (err && err.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return res.status(400).json({ message: first?.message || 'Validation error' });
  }
  // Cast errors (e.g., bad ObjectId)
  if (err && err.name === 'CastError') {
    return res.status(400).json({ message: `Bad ${err.path}` });
  }
  // Default
  return res.status(500).json({ message: fallback });
}
function parseSubRoles(body) {
  // Accept: subRole[]=a&subRole[]=b, or subRole: "a,b", or subRole: ["a","b"]
  const list = []
    .concat(body['subRole[]'] || body.subRole || [])
    .flat();
  if (typeof body.subRole === 'string' && list.length === 0) {
    list.push(...csvToArr(body.subRole));
  }
  return list.map(s => String(s).trim()).filter(Boolean);
}

async function incEventSeatsTakenOrThrow(eventId) {
  // Atomic guard: do not exceed capacity
  const updated = await Event.findOneAndUpdate(
    { _id: eventId, $expr: { $lt: ['$seatsTaken', '$capacity'] } },
    { $inc: { seatsTaken: 1 } },
    { new: true }
  );
  if (!updated) throw new Error('Event is full');
  return updated;
}

async function notifyRegistrationPending(actorId, role, eventId) {
  // Priority 8 = popup (forced)
  try {
    await ActorNotification.create({
      actorId,
      title: 'Registration submitted',
      body: 'Your account (Level 01) has been confirmed. Please complete your profile so that the administration can validate it and you can start your B2B journey',
      link: `/profile`,
      priority: 8
    });
  } catch (_) {}
}

/* ─────────────────────────── 1. attendee ─────────────────────────── */
exports.registerAttendee = asyncHandler(async (req, res) => {
  const {
    eventId,
    pwd,
    actorType = '',
    actorHeadline = '',
    'personal.fullName': fullName,
    'personal.email': email,
    'personal.phone': phone,
    'personal.country': country,
    'personal.city': city,

    'organization.orgName': orgName,
    'organization.jobTitle': jobTitle,
    'organization.businessRole': businessRole,

    'businessProfile.preferredLanguages': prefLangCsv,

    'matchingIntent.objective': objective,
    'matchingIntent.openToMeetings': openToMeetings,

    'links.website': website,
    'links.linkedin': linkedin,
  } = req.body || {};

  // Sessions
  const sessionIds = []
    .concat(req.body['sessionIds[]'] || req.body.sessionIds || [])
    .flat()
    .filter(Boolean);
  await assertEmailAvailableEverywhere(req.body.email);
  // Basic validation
  if (!isId(eventId)) return res.status(400).json({ message: 'Valid eventId is required' });
  if (!toStr(fullName).trim()) return res.status(400).json({ message: 'Full name is required' });
  if (!EMAIL_RX.test(toStr(email))) return res.status(400).json({ message: 'Valid email is required' });
  if (!toStr(country).trim()) return res.status(400).json({ message: 'Country is required' });
  if (!req.file?.path) return res.status(400).json({ message: 'Profile photo is required' });
  if (!sessionIds.length) return res.status(400).json({ message: 'Please select at least one session' });
  const PASSWORD_MIN = 8;
  if (!toStr(pwd)) return res.status(400).json({ message: 'Password is required' });
  if (toStr(pwd).length < PASSWORD_MIN)
    return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN} characters` });

  // Uniqueness
  if (await attendee.exists({ 'personal.email': toStr(email).toLowerCase() })) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const subRole = parseSubRoles(req.body);
  const actorTypeNorm = toStr(actorType).trim();
const finalSubRole = actorTypeNorm === 'BusinessOwner' ? [] : subRole;
  const preferredLanguages = csvToArr(prefLangCsv).slice(0, 3);
  const openFlag = normBool(openToMeetings);
  const salt    = await bcrypt.genSalt(12);
  const pwdHash = await bcrypt.hash(toStr(pwd), salt);
  // Persist
  const created = await attendee.create({
    personal: {
      fullName: toStr(fullName).trim(),
      email: toStr(email).toLowerCase().trim(),
      firstEmail : toStr(email).toLowerCase().trim(), 
      phone: toStr(phone).trim(),
      country: toStr(country).toUpperCase(),
      city: toStr(city).trim(),
      profilePic: localPathToWebUrl(req.file.path),
      preferredLanguages
    },
    organization: {
      orgName: toStr(orgName).trim(),
      jobTitle: toStr(jobTitle).trim(),
      businessRole: toStr(businessRole).trim()
    },
    matchingIntent: {
      objectives: csvToArr(objective).length ? csvToArr(objective) : (toStr(objective) ? [toStr(objective)] : []),
      openToMeetings: openFlag
    },
    links: { website: toStr(website).trim(), linkedin: toStr(linkedin).trim() },
    id_event: eventId,

    actorType: toStr(actorType).trim(),
    role: toStr(actorType).trim(),
    actorHeadline: toStr(actorHeadline).trim(),
    pwd: pwdHash,
    subRole: finalSubRole,
    verified: false,
    adminVerified: 'pending'
  });

  // Verify link
  const raw = randomBytes(32).toString('hex');
  created.verifyToken   = await bcrypt.hash(raw, 12);
  created.verifyExpires = Date.now() + 24 * 60 * 60 * 1000;
  await created.save();
  const verifyLink = `${process.env.FRONTEND_URL}/verify-email?token=${raw}&role=attendee&id=${created._id}`;

  // Sessions (normalized)
  const normSessions = await loadAndValidateSessions(eventId, sessionIds);
  try {
    await attachSeatsAndEnforce({ normSessions, enforce: true }); // throws if any session is full
  } catch (e) {
    if (e && e.message === 'SESSION_FULL') {
      return res.status(409).json({
        message: 'One or more sessions are full',
        fullSessionId: e.sessionId
      });
    }
    throw e;
  }
  // Create registrations
  await createSessionRegs({ actorId: created._id, actorRole: 'attendee', eventId, sessions: normSessions });
  await bumpScheduleSeatsTaken(normSessions.map(s => s._id), +1);
  normSessions.forEach(s => { delete s.__raw; });

  // Event doc for header/PDF
  const eventDoc = await Event.findById(eventId).lean().catch(() => null) || {
    _id: eventId, title: 'Event', startDate: new Date(), endDate: new Date(), city: '', country: ''
  };

  // PDF
  const pdf = await buildRegistrationPdf({ event: eventDoc, actor: created, role: 'attendee', sessions: normSessions });

  // Email + verify link
  const brandLogoPath = process.env.BRAND_LOGO_PATH;
  const who = created?.personal?.fullName || 'there';

  const rowsHtml = normSessions.map(s => {
    const startStr = s.startAt ? s.startAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    const endStr   = s.endAt   ? s.endAt.toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit' }) : '—';
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${startStr}–${endStr}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-weight:600">${escapeHtml(s.title)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.room.name || '')}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#64748b">${escapeHtml(s.track || '')}</td>
    </tr>`;
  }).join('');

  const logoImg = brandLogoPath ? `<img src="cid:brandlogo@cid" alt="Logo" style="max-height:40px;vertical-align:middle;margin-right:8px"/>` : '';
  const hdr = `
    <div style="padding:14px 0;border-bottom:1px solid #e5e7eb;margin-bottom:12px">
      ${logoImg}
      <div style="font:700 18px/1.2 system-ui,Segoe UI,Roboto;display:inline-block;vertical-align:middle">
        ${escapeHtml(eventDoc.title || 'Event')}
      </div>
      <div style="font:600 12px/1.4 system-ui;color:#64748b">
        ${new Date(eventDoc.startDate||Date.now()).toLocaleDateString()} → ${new Date(eventDoc.endDate||Date.now()).toLocaleDateString()}
        ${eventDoc.city ? `• ${escapeHtml(eventDoc.city)}` : ''} ${eventDoc.country ? `• ${escapeHtml(eventDoc.country)}` : ''}
      </div>
    </div>`;

  const sessionsHtml = normSessions.length ? `
    <h3 style="font:800 14px system-ui;margin:12px 0 8px">Your selected sessions</h3>
    <table style="border-collapse:collapse;width:100%;font:600 12px system-ui">
      <thead>
        <tr>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Time</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Title</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Room</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Track</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : '';

  const html = `
    ${hdr}
    <p style="font:600 14px system-ui">Hello ${escapeHtml(who)},</p>
    <p style="font:600 13px system-ui">
      Thank you for registering to <b>${escapeHtml(eventDoc.title || 'the event')}</b>.
      We attached your confirmation PDF below (with your sessions and QR).
    </p>
    <p style="font:600 13px system-ui;margin:12px 0">
      Please verify your email to activate your account:
      <br/><a href="${verifyLink}" style="font-weight:700;color:#2563eb">${verifyLink}</a>
    </p>
    ${sessionsHtml}
    <p style="font:600 13px system-ui;margin-top:14px">Best regards,<br/>GITS Team</p>
  `;

  const attachments = [{ filename: 'registration.pdf', content: pdf, contentType: 'application/pdf' }];
  if (brandLogoPath) attachments.push({ filename: path.basename(brandLogoPath), path: brandLogoPath, cid: 'brandlogo@cid' });

  await sendMail(
    created.personal.email,
    'GITS: Confirm your registration',
    html,
    'Please see the attached PDF for your registration details. Verify your email using the link inside.',
    attachments
  );

  try {
    await incEventSeatsTakenOrThrow(eventId);
  } catch (e) {
    try { await attendee.findByIdAndDelete(created._id); } catch {}
    return res.status(409).json({ message: 'Event is full' });
  }

  await notifyRegistrationPending(created._id, 'attendee', eventId);
  return res.status(201).json({ success: true, data: { id: created._id, role: 'attendee' } });
});





// local file path -> web URL (same idea you used in uploadProfilePic)
function localPathToWebUrl(absPath) {
  try {
    const uploadsRoot = path.resolve(__dirname, '../uploads');
    const rel = path.relative(uploadsRoot, absPath).replace(/\\/g, '/');
    return `/uploads/${rel}`;
  } catch { return ''; }
}


/* ─────────────────────────── 2) REGISTER EXHIBITOR ──────────────────────────
   INPUT (near-unchanged; we accept your old keys and map them):
     { exhibitorName, orgName, email, pwd, country, eventId }

   Maps to new model paths:
     profile.exhibitorName, profile.organizationName, profile.email, profile.country
     verified=false, pwd, id_event
-----------------------------------------------------------------------------*/
exports.registerExhibitor = asyncHandler(async (req, res) => {
  const {
    eventId,
    pwd,
    actorType = '',
    actorHeadline = '',

    'identity.exhibitorName': exhibitorName,
    'identity.contactName': contactName,
    'identity.email': email,
    'identity.phone': phone,
    'identity.country': country,
    'identity.city': city,
    'identity.orgName': orgName,
    'identity.preferredLanguages': prefLangCsv,

    'business.industry': industry,
    'commercial.availableMeetings': availableMeetings,

    'links.website': website,
    'links.linkedin': linkedin,
  } = req.body || {};
  await assertEmailAvailableEverywhere(req.body.email);
  const sessionIds = []
    .concat(req.body['sessionIds[]'] || req.body.sessionIds || [])
    .flat()
    .filter(Boolean);

  // Basic validation
  if (!isId(eventId)) return res.status(400).json({ message: 'Valid eventId is required' });
  if (!toStr(exhibitorName).trim()) return res.status(400).json({ message: 'Exhibitor/Brand name is required' });
  if (!toStr(contactName).trim()) return res.status(400).json({ message: 'Contact person is required' });
  if (!EMAIL_RX.test(toStr(email))) return res.status(400).json({ message: 'Valid email is required' });
  if (!toStr(country).trim()) return res.status(400).json({ message: 'Country is required' });
  if (!req.file?.path) return res.status(400).json({ message: 'Logo is required' });
  if (!sessionIds.length) return res.status(400).json({ message: 'Please select at least one session' });
  const PASSWORD_MIN = 8;
  if (!toStr(pwd)) return res.status(400).json({ message: 'Password is required' });
  if (toStr(pwd).length < PASSWORD_MIN)
    return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN} characters` });

  if (await Exhibitor.exists({ 'identity.email': toStr(email).toLowerCase() })) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const subRole = parseSubRoles(req.body);
  const actorTypeNorm = toStr(actorType).trim();
const finalSubRole = actorTypeNorm === 'BusinessOwner' ? [] : subRole;

  const preferredLanguages = csvToArr(prefLangCsv).slice(0, 3);
  const openFlag = normBool(availableMeetings);
  const salt    = await bcrypt.genSalt(12);
  const pwdHash = await bcrypt.hash(toStr(pwd), salt);
  const created = await Exhibitor.create({
    identity: {
      exhibitorName: toStr(exhibitorName).trim(),
      contactName: toStr(contactName).trim(),
      email: toStr(email).toLowerCase().trim(),
      firstEmail : toStr(email).toLowerCase().trim(), 
      phone: toStr(phone).trim(),
      country: toStr(country).toUpperCase(),
      city: toStr(city).trim(),
      orgName: toStr(orgName).trim(),
      logo: localPathToWebUrl(req.file.path),
      preferredLanguages
    },
    business: { industry: toStr(industry).trim() },
    commercial: { availableMeetings: openFlag },
    links: { website: toStr(website).trim(), linkedin: toStr(linkedin).trim() },
    id_event: eventId,

    actorType: toStr(actorType).trim(),
    role: toStr(actorType).trim(),
    actorHeadline: toStr(actorHeadline).trim(),
    pwd: pwdHash,
    subRole: finalSubRole,
    verified: false,
    adminVerified: 'pending'
  });

  // Verify link
  const raw = randomBytes(32).toString('hex');
  created.verifyToken   = await bcrypt.hash(raw, 12);
  created.verifyExpires = Date.now() + 24 * 60 * 60 * 1000;
  await created.save();
  const verifyLink = `${process.env.FRONTEND_URL}/verify-email?token=${raw}&role=exhibitor&id=${created._id}`;

  // Sessions (normalized)
  const normSessions = await loadAndValidateSessions(eventId, sessionIds);
try {
  await attachSeatsAndEnforce({ normSessions, enforce: true }); // throws if any session is full
} catch (e) {
  if (e && e.message === 'SESSION_FULL') {
    return res.status(409).json({
      message: 'One or more sessions are full',
      fullSessionId: e.sessionId
    });
  }
  throw e;
}
  // Create registrations
  await createSessionRegs({ actorId: created._id, actorRole: 'exhibitor', eventId, sessions: normSessions });
  await bumpScheduleSeatsTaken(normSessions.map(s => s._id), +1);
  normSessions.forEach(s => { delete s.__raw; });

  // Event doc for header/PDF
  const eventDoc = await Event.findById(eventId).lean().catch(() => null) || {
    _id: eventId, title: 'Event', startDate: new Date(), endDate: new Date(), city: '', country: ''
  };

  // PDF
  const pdf = await buildRegistrationPdf({ event: eventDoc, actor: created, role: 'exhibitor', sessions: normSessions });

  // Email
  const brandLogoPath = process.env.BRAND_LOGO_PATH;
  const who = created?.identity?.contactName || created?.identity?.exhibitorName || 'there';

 const rowsHtml = normSessions.map(s => {
  const startStr = s.startAt ? s.startAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  const endStr   = s.endAt   ? s.endAt.toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit' }) : '—';
  const seatNote = s.seats && s.seats.capacity > 0
    ? ` (${Math.max(0, s.seats.capacity - s.seats.taken)} left / ${s.seats.capacity})`
    : '';
  return `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${startStr}–${endStr}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;font-weight:600">${escapeHtml(s.title)}${seatNote}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.room.name || '')}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;color:#64748b">${escapeHtml(s.track || '')}</td>
  </tr>`;
}).join('');

  const logoImg = brandLogoPath ? `<img src="cid:brandlogo@cid" alt="Logo" style="max-height:40px;vertical-align:middle;margin-right:8px"/>` : '';
  const hdr = `
    <div style="padding:14px 0;border-bottom:1px solid #e5e7eb;margin-bottom:12px">
      ${logoImg}
      <div style="font:700 18px/1.2 system-ui,Segoe UI,Roboto;display:inline-block;vertical-align:middle">
        ${escapeHtml(eventDoc.title || 'Event')}
      </div>
      <div style="font:600 12px/1.4 system-ui;color:#64748b">
        ${new Date(eventDoc.startDate||Date.now()).toLocaleDateString()} → ${new Date(eventDoc.endDate||Date.now()).toLocaleDateString()}
        ${eventDoc.city ? `• ${escapeHtml(eventDoc.city)}` : ''} ${eventDoc.country ? `• ${escapeHtml(eventDoc.country)}` : ''}
      </div>
    </div>`;

  const sessionsHtml = normSessions.length ? `
    <h3 style="font:800 14px system-ui;margin:12px 0 8px">Your selected sessions</h3>
    <table style="border-collapse:collapse;width:100%;font:600 12px system-ui">
      <thead>
        <tr>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Time</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Title</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Room</th>
          <th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb">Track</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : '';

  const html = `
    ${hdr}
    <p style="font:600 14px system-ui">Hello ${escapeHtml(who)},</p>
    <p style="font:600 13px system-ui">
      Thank you for registering to <b>${escapeHtml(eventDoc.title || 'the event')}</b>.
      We attached your confirmation PDF below (with your sessions and QR).
    </p>
    <p style="font:600 13px system-ui;margin:12px 0">
      Please verify your email to activate your account:
      <br/><a href="${verifyLink}" style="font-weight:700;color:#2563eb">${verifyLink}</a>
    </p>
    ${sessionsHtml}
    <p style="font:600 13px system-ui;margin-top:14px">Best regards,<br/>GITS Team</p>
  `;

  const attachments = [{ filename: 'registration.pdf', content: pdf, contentType: 'application/pdf' }];
  if (brandLogoPath) attachments.push({ filename: path.basename(brandLogoPath), path: brandLogoPath, cid: 'brandlogo@cid' });

  await sendMail(
    created.identity.email,
    'GITS: Confirm your registration',
    html,
    'Please see the attached PDF for your registration details. Verify your email using the link inside.',
    attachments
  );

  try {
    await incEventSeatsTakenOrThrow(eventId);
  } catch (e) {
    try { await Exhibitor.findByIdAndDelete(created._id); } catch {}
    return res.status(409).json({ message: 'Event is full' });
  }

  await notifyRegistrationPending(created._id, 'exhibitor', eventId);
  return res.status(201).json({ success: true, data: { id: created._id, role: 'exhibitor' } });
});






/* ─────────────────────────── 3. Speaker ───────────────────────────── */
exports.registerSpeaker = asyncHandler(async (req,res)=>{ 
  const { fullName, email, pwd, country, jobTitle, talkTitle, abstract, eventId, roleKind, roleData } = req.body || {};
  if (!fullName || !email || !pwd || !country || !jobTitle || !talkTitle || !abstract || !eventId)
    return res.status(400).json({ message:'Missing required fields' });

  const exists = await Speaker.findOne({ 'personal.email': email.toLowerCase() });
  if (exists) return res.status(409).json({ message:'Email already registered' });

  const doc = await Speaker.create({
    personal : { fullName, email: email.toLowerCase(),firstEmail: email.toLowerCase() ,country },
    organization:{ jobTitle },
    talk:{ title: talkTitle, abstract },
    role:normalized,
    verified:false,
    pwd,
    id_event:eventId
  });

  const normalized = normalizeRoleKind(roleKind);
  let roleDoc = null;
  if (normalized) {
    roleDoc = await createRoleDoc({ actorDoc: doc, baseActorType:'speaker', roleKind: normalized, roleData });
  }

  await issueVerification(doc, email, 'speaker', { qrAttachment: { roleKind: normalized, roleDoc } });
  res.status(201).json({ success:true, message:'Registration successful; verify e-mail.' });
});


const ROLE_MODEL = {
  attendee : attendee,
  exhibitor: Exhibitor,
  speaker  : Speaker,
  admin    : Admin
};

async function issueVerification(userDoc, email, role, opts = {}) {
  const raw  = randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(raw, 12);

  userDoc.verifyToken   = hash;
  userDoc.verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 h
  await userDoc.save();

  const link = `${process.env.FRONTEND_URL}/verify-email?token=${raw}&role=${role}&id=${userDoc._id}`;

  // Build public profile URL (you can change to your final route)
  const publicUrl = `${process.env.FRONTEND_URL}/public/${role}/${userDoc._id}`;

  // Optional QR PDF attachment
  let attachments = [];
  if (opts?.qrAttachment) {
    const header = { title: 'GITS Registration', subtitle: 'Scan to view your public profile' };
    const fields = {
      'Role': opts.qrAttachment.roleKind || 'N/A',
      'Email': email,
      'ActorId': String(userDoc._id)
    };
    const pdf = await makeQrPdf({ publicUrl, header, fields });
    attachments.push({
      filename: 'GITS-Profile.pdf',
      content: pdf,
      contentType: 'application/pdf'
    });
  }

  await sendMail(email, 'Verify your e-mail', `
    <p>Hello ${email.split('@')[0]},</p>
    <p>Please verify your e-mail by clicking the link below:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link expires in 24 hours.</p>
  `, attachments);
}


/* ───────────────────────── VERIFY EMAIL ───────────────────────────── */
exports.verifyEmail = asyncHandler(async (req, res) => {
  // accept POST body OR GET query seamlessly
  const role  = String((req.body?.role || req.query?.role || '')).trim().toLowerCase();
  const id    = (req.body?.id || req.query?.id || '').trim();
  const token = String((req.body?.token || req.query?.token || '')).trim();

  if (!role || !id || !token) return res.status(400).json({ message: 'Missing role, id or token' });
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad user id' });

  const Model = ROLE_MODEL[role];
  if (!Model) return res.status(400).json({ message: 'Unsupported role' });

  // verify fields are often select:false → include them explicitly
  const user = await Model.findById(id)
    .select('+verifyToken +verifyExpires +verified')
    .exec();

  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.verified) return res.json({ success: true, message: 'Already verified' });
  if (!user.verifyToken || !user.verifyExpires) {
    return res.status(400).json({ message: 'No verification token set' });
  }

  // tolerate Date or Number in DB
  const expiresMs = Number(user.verifyExpires);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return res.status(400).json({ message: 'Verification link expired' });
  }

  const ok = await bcrypt.compare(token, user.verifyToken);
  if (!ok) return res.status(400).json({ message: 'Invalid verification token' });

  user.verified = true;
  user.verifyToken = undefined;
  user.verifyExpires = undefined;
  await user.save();

  return res.json({ success: true, message: `E-mail verified for ${role}` });
});

/* helper to pull the email field depending on schema */
function getEmail(doc, role){
  switch(role){
    case 'attendee' : return doc.personal.email;
    case 'speaker'  : return doc.personal.email;
    case 'exhibitor': return doc.identity.email;
    default         : return doc.email;
  }
}

exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email || !EMAIL_RX.test(email))
    return res.status(400).json({ message:'Valid e-mail required' });

  const mailLower = email.toLowerCase();
  /* Search all 3 user collections (admins too) */
  const lookOrder = [
    { role:'attendee' , query:{ 'personal.email' : mailLower } },
    { role:'exhibitor', query:{ 'identity.email': mailLower } },
    { role:'speaker'  , query:{ 'personal.email' : mailLower } },
    { role:'admin'    , query:{ email: mailLower } }
  ];

  let user, role;
  for (const { role:r, query } of lookOrder) {
    user = await ROLE_MODEL[r].findOne(query).exec();
    if (user) { role = r; break; }
  }
  if (!user)
    return res.status(200).json({ success:true, message:'If that e-mail exists we have sent instructions.' });

  /* Create reset token */
  const raw  = randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(raw, 12);
  user.resetToken   = hash;
  user.resetExpires = Date.now() + 60*60*1000;  // 1 h
  await user.save();
  const link = `${process.env.FRONTEND_URL}/reset-password?token=${raw}&role=${role}&id=${user._id}`;
  await sendMail(email, 'Password reset', `
    <p>You requested a password reset.</p>
    <p><a href="${link}">Click here to set a new password</a> (valid 1 hour).</p>`
  );

  res.status(200).json({ success:true, message:'If the e-mail exists, a reset link has been sent.' });
});

// POST /api/auth/set-password
exports.setPassword = asyncHandler(async (req, res) => {
  const { id, role, pwd } = req.body || {};
  if (!id || !role || !pwd) return res.status(400).json({ message:'id, role, pwd required' });

  const Model = ROLE_MODEL[role];
  if (!Model) return res.status(400).json({ message:'Unknown role' });

  const user = await Model.findById(id).select('+pwd +resetToken +resetExpires +resetTokenPrev +resetPrevExpires').exec();
  if (!user) return res.status(404).json({ message:'User not found' });

  // set password
  const salt = await bcrypt.genSalt(12);
  user.pwd = await bcrypt.hash(String(pwd), salt);

  // create a fresh reset token (safety link to firstEmail) using rotation
  const raw = randomBytes(32).toString('hex');
  user.resetTokenPrev   = user.resetToken;
  user.resetPrevExpires = user.resetExpires;
  user.resetToken   = await bcrypt.hash(raw, 12);
  user.resetExpires = Date.now() + 60*60*1000;

  await user.save();

  const firstEmail = getRoleFirstEmail(user, role);
  const link = `${process.env.FRONTEND_URL}/reset-password?token=${raw}&role=${role}&id=${user._id}`;

  // notify firstEmail
  try {
    await sendMail(firstEmail, 'Your password was changed', `
      <p>Your password was just changed. If this wasn’t you, you can set a new one:</p>
      <p><a href="${link}">Reset your password</a> (valid 1 hour)</p>
    `);
  } catch (_) {}

  res.json({ success:true, message:'Password updated' });
});



/* ───────────────────────── 2. Reset-password ──────────────────────── */
exports.resetPassword = asyncHandler(async (req, res) => {
  const role  = String((req.body?.role || req.query?.role || '')).trim().toLowerCase();
  const id    = (req.body?.id || req.query?.id || '').trim();
  const token = String((req.body?.token || req.query?.token || '')).trim();
  const pwd   = String(req.body?.pwd || req.query?.pwd || '');

  if (!role || !id || !token || !pwd) {
    return res.status(400).json({ message: 'Missing role, id, token or pwd' });
  }
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: 'Bad user id' });
  }
  if (pwd.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' });
  }

  const Model = ROLE_MODEL[role];
  if (!Model) return res.status(400).json({ message: 'Unsupported role' });

  // include hidden token fields
  const user = await Model.findById(id)
    .select('+resetToken +resetExpires +resetTokenPrev +resetPrevExpires +pwd')
    .exec();

  if (!user) return res.status(404).json({ message: 'User not found' });

  const now = Date.now();

  const currentValid = user.resetToken && user.resetExpires && Number(user.resetExpires) > now;
  const prevValid    = user.resetTokenPrev && user.resetPrevExpires && Number(user.resetPrevExpires) > now;

  let matched = false;

  if (currentValid) {
    matched = await bcrypt.compare(token, user.resetToken);
  }
  if (!matched && prevValid) {
    matched = await bcrypt.compare(token, user.resetTokenPrev);
  }

  if (!matched) {
    return res.status(400).json({ message: 'Invalid reset token' });
  }

  const salt = await bcrypt.genSalt(12);
  user.pwd = await bcrypt.hash(pwd, salt);

  // clear both tokens after success
  user.resetToken = undefined;
  user.resetExpires = undefined;
  user.resetTokenPrev = undefined;
  user.resetPrevExpires = undefined;

  await user.save();

  try {
    const firstEmail = getRoleFirstEmail(user, role);
    if (firstEmail) {
      await sendMail(
        firstEmail,
        'Your password has been reset',
        `<p>Your password was just reset using a reset link. If this wasn’t you, run “Forgot password” again and contact support.</p>`
      );
    }
  } catch (_) {}

  return res.json({ success: true, message: 'Password updated.' });
});

/* helper reused from Part 4 */
function getEmail(doc, role){
  switch(role){
    case 'attendee' : return doc.personal.email;
    case 'speaker'  : return doc.personal.email;
    case 'exhibitor': return doc.identity.email;
    default         : return doc.email;
  }
}


/* ───────────────────────── 1. LOGOUT ─────────────────────────────── */
exports.logout = asyncHandler(async (req, res) => {
  // Simply wipe the cookie
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie('jwt', { httpOnly:true, sameSite:isProduction, secure:isProduction });
  res.json({ success:true, message:'Logged out' });
});

/* ───────────────────────── 2. RESEND VERIFICATION ────────────────── */
exports.resendVerification = asyncHandler(async (req, res) => {
  const emailRaw = req.body?.email;
  if (!emailRaw || !EMAIL_RX.test(emailRaw)) {
    return res.status(400).json({ message:'Valid e-mail required' });
  }
  const email = emailRaw.toLowerCase().trim();

  // locate by role
  let user, role;
  for (const [r, M] of Object.entries(ROLE_MODEL)) {
    const path = r === 'exhibitor' ? 'identity.email' : (r === 'admin' ? 'email' : 'personal.email');
    user = await M.findOne({ [path]: email }).select('+verifyToken +verifyExpires +verified').exec();
    if (user) { role = r; break; }
  }

  // soft success for unknown email
  if (!user) {
    return res.status(200).json({ success:true, message:'If the e-mail exists, a new link was sent.' });
  }

  if (user.verified) {
    return res.status(200).json({ success:true, message:'Account already verified.' });
  }

  // fresh token (same as inscription)
  const raw  = randomBytes(32).toString('hex');
  user.verifyToken   = await bcrypt.hash(raw, 12);
  user.verifyExpires = Date.now() + 24*60*60*1000;
  await user.save();

  const link = `${process.env.FRONTEND_URL}/verify-email?token=${raw}&role=${role}&id=${user._id}`;
  await sendMail(email, 'Verify your e-mail (new link)', `
    <p>Hello ${email.split('@')[0]},</p>
    <p>Here is your new verification link (valid 24 h):</p>
    <p><a href="${link}">${link}</a></p>
  `);

  return res.json({ success:true, message:'Verification e-mail re-sent.' });
});

// controllers/authController.js (replace the whole handler)
exports.resendVerificationById = asyncHandler(async (req, res) => {
  const { actorId } = req.params;
  if (!mongoose.isValidObjectId(actorId)) {
    return res.status(400).json({ message: 'Bad actor id' });
  }

  // Helpers
  const getAccountEmail = (doc, role) => {
    if (doc.email) return String(doc.email).trim(); // root email (new model)
    switch (role) {
      case 'exhibitor': return doc.identity?.email || '';
      case 'speaker'  : return doc.personal?.email || '';
      default         : return doc.personal?.email || '';
    }
  };
  const pickEventId = (doc) => doc.id_event || doc.eventId || doc.event || null;

  // 1) Find the user deterministically (avoid async || short-circuit bug)
  const Models = [
    ['attendee',  require('../models/attendee')],
    ['exhibitor', require('../models/exhibitor')],
    ['speaker',   require('../models/speaker')],
  ];

  let role = null, user = null, email = null, eventId = null;
  for (const [r, Model] of Models) {
    const doc = await Model.findById(actorId).lean();
    if (doc) {
      role = r;
      user = doc;
      eventId = pickEventId(doc);
      email = getAccountEmail(doc, r);
      break;
    }
  }

  if (!user || !role) return res.status(404).json({ message: 'User not found' });
  if (!email)         return res.status(422).json({ message: 'User has no email to send to' });
  if (user.verified)  return res.json({ success: true, message: 'Account already verified' });

  // 2) Issue a fresh verify token
  const raw  = randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(raw, 12);

  const Model = role === 'exhibitor'
    ? require('../models/exhibitor')
    : role === 'speaker'
      ? require('../models/speaker')
      : require('../models/attendee');

  const docForUpdate = await Model.findById(actorId).exec();
  if (!docForUpdate) return res.status(404).json({ message: 'User not found' });

  docForUpdate.verifyToken   = hash;
  docForUpdate.verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
  await docForUpdate.save();

  // 3) Build verification link
  const FE = process.env.FRONTEND_URL || '';
  if (!/^https?:\/\//i.test(FE)) {
    return res.status(500).json({ message: 'FRONTEND_URL is not set to a valid URL' });
  }
  const verifyLink = `${FE}/verify-email?token=${raw}&role=${role}&id=${actorId}`;

  // 4) Load registrations/sessions
  const regs = await require('../models/sessionRegistration')
    .find({ actorId, status: 'registered' })
    .select('sessionId eventId actorRole')
    .lean();

  const sessionIds = regs.map(r => r.sessionId);

  const normSessions = await (async () => {
    if (!sessionIds.length) return [];
    const Schedule = require('../models/eventModels/schedule');
    const ProgramRoom = require('../models/programRoom');
    const rows = await Schedule.find({ _id: { $in: sessionIds } })
      .select('sessionTitle startTime endTime track roomId id_event capacity seatLimit maxSeats seatsTaken')
      .populate({ path: 'roomId', model: ProgramRoom, select: 'name capacity' })
      .lean();

    return rows.map(s => ({
      _id: s._id,
      title: s.sessionTitle || 'Untitled',
      track: s.track || '',
      startAt: s.startTime ? new Date(s.startTime) : null,
      endAt  : s.endTime   ? new Date(s.endTime)   : null,
      room: { name: s.roomId?.name || '' },
      __raw: s,
    }));
  })();

  // 5) Event header
  const Event = require('../models/event');
  const eventDoc = eventId
    ? await Event.findById(eventId).lean().catch(() => null)
    : null;

  // 6) Build the registration-style PDF (with QR + actor block + sessions)
  const actorPlain = docForUpdate.toObject ? docForUpdate.toObject() : docForUpdate;

  // prefer in-file builder; fall back to util if needed
  let localBuilder = (typeof buildRegistrationPdf === 'function') ? buildRegistrationPdf : null;
  if (!localBuilder) {
    try {
      const utilBuilder = require('../utils/qrProfilePdf')?.buildRegistrationPdf;
      if (typeof utilBuilder === 'function') localBuilder = utilBuilder;
    } catch (_) { /* ignore */ }
  }
  if (!localBuilder) {
    return res.status(500).json({ message: 'PDF builder (buildRegistrationPdf) is not available' });
  }

  const pdf = await localBuilder({
    event: eventDoc || {},
    actor: actorPlain,
    role,
    sessions: normSessions
  });

  // 7) Also render program in the email body (HTML table)
  const rowsHtml = (normSessions || []).map(s => {
    const start = s.startAt;
    const end   = s.endAt;
    const st = start ? new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    const en = end   ? new Date(end).toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit' }) : '—';
    const title = s.title || 'Untitled';
    const room  = (s.room?.name || '—');
    const track = s.track || '—';
    return `<tr>
      <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${st} – ${en}</td>
      <td style="padding:6px 8px;border:1px solid #eee">${title}</td>
      <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${room}</td>
      <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${track}</td>
    </tr>`;
  }).join('');

  const programHtml = rowsHtml
    ? `<h3 style="font-family:system-ui,Segoe UI,Roboto,Arial;margin:18px 0 8px">Your selected sessions</h3>
       <table style="border-collapse:collapse;font-family:system-ui,Segoe UI,Roboto,Arial;font-size:14px">
         <thead>
           <tr>
             <th align="left" style="padding:6px 8px;border:1px solid #eee">Time</th>
             <th align="left" style="padding:6px 8px;border:1px solid #eee">Title</th>
             <th align="left" style="padding:6px 8px;border:1px solid #eee">Room</th>
             <th align="left" style="padding:6px 8px;border:1px solid #eee">Track</th>
           </tr>
         </thead>
         <tbody>${rowsHtml}</tbody>
       </table>`
    : `<p style="color:#666">No sessions selected yet.</p>`;

  // 8) Send email with PDF attached
  const { sendMail } = require('../config/mailer');
  try {
    await sendMail(
      email,
      'Verify your e-mail (new link)',
      `
        <div style="font-family:system-ui,Segoe UI,Roboto,Arial;font-size:14px;color:#111">
          <p>Hello ${email.split('@')[0]},</p>
          <p>We’re sending you a fresh verification link (valid 24h):</p>
          <p><a href="${verifyLink}">${verifyLink}</a></p>

          ${programHtml}

          <p style="margin-top:16px">Your registration PDF (with QR code) is attached.</p>
        </div>
      `,
      'Open this email in HTML to view the link and your sessions. PDF attached.',
      [{ filename: 'registration.pdf', content: pdf, contentType: 'application/pdf' }]
    );
  } catch (err) {
    console.error('sendMail failed:', err);
    return res.status(502).json({ message: 'Failed to send verification email', detail: String(err?.message || err) });
  }

  return res.json({ success: true, message: 'Verification e-mail re-sent.' });
});

async function issueResetToken(userDoc, ttlMs = 60 * 60 * 1000) {
  const raw = randomBytes(32).toString('hex');

  // rotate: keep previous token also valid until its original expiry
  userDoc.resetTokenPrev   = userDoc.resetToken;
  userDoc.resetPrevExpires = userDoc.resetExpires;

  userDoc.resetToken   = await bcrypt.hash(raw, 12);
  userDoc.resetExpires = Date.now() + ttlMs;

  await userDoc.save();
  return raw; // you email this
}

// POST /api/auth/reset-password   (also accepts GET with query for manual tests)



// controllers/authController.js
exports.changeEmail = asyncHandler(async (req, res) => {
  const { id, role, newEmail } = req.body || {};
  if (!id || !role || !newEmail) return res.status(400).json({ message: 'id, role, newEmail required' });
  if (!EMAIL_RX.test(String(newEmail))) return res.status(400).json({ message: 'Valid e-mail required' });

  const Model = ROLE_MODEL[role];
  if (!Model) return res.status(400).json({ message: 'Unknown role' });

  // ---- helpers ----
  const norm = (s) => String(s || '').trim().toLowerCase();
  const equalsI = (a, b) => norm(a) === norm(b);

  // Check availability across all collections, both root & legacy fields (case-insensitive)
  const ensureAvailableEverywhere = async (email, { model, id }) => {
    const E = norm(email);
    const coll = [
      ['attendee',  require('../models/attendee'),  [{ email: E }, { 'personal.email': E }]],
      ['exhibitor', require('../models/exhibitor'), [{ email: E }, { 'identity.email': E }]],
      ['speaker',   require('../models/speaker'),   [{ email: E }, { 'personal.email': E }]],
    ];

    for (const [r, M, ors] of coll) {
      const doc = await M.findOne({
        $or: ors.map(o => {
          const k = Object.keys(o)[0];
          return { [k]: E };
        }),
      })
      .collation({ locale: 'en', strength: 2 }) // case-insensitive match
      .lean();

      if (doc && !(r === model && String(doc._id) === String(id))) {
        throw Object.assign(new Error('Email already in use'), { status: 409 });
      }
    }
  };

  // Resolve the user
  const user = await Model.findById(id).exec();
  if (!user) return res.status(404).json({ message: 'User not found' });

  // Current email (root preferred, then role-scoped)
  const getRoleEmail = (doc, r) => {
    if (doc.email) return String(doc.email);
    if (r === 'exhibitor') return doc.identity?.email || '';
    if (r === 'speaker')   return doc.personal?.email || '';
    return doc.personal?.email || '';
  };
  const setRoleEmail = (doc, r, val) => {
    // Always set root email
    doc.email = val;
    // Mirror legacy path to satisfy unique indexes that may still exist
    if (r === 'exhibitor') {
      doc.identity = doc.identity || {};
      doc.identity.email = val;
    } else {
      doc.personal = doc.personal || {};
      doc.personal.email = val;
    }
  };
  const getRoleFirstEmail = (doc, r) => {
    if (r === 'exhibitor') return doc.identity?.firstEmail || doc.identity?.email || doc.email || '';
    if (r === 'speaker')   return doc.personal?.firstEmail || doc.personal?.email || doc.email || '';
    return doc.personal?.firstEmail || doc.personal?.email || doc.email || '';
  };

  const prev = getRoleEmail(user, role);
  const next = norm(newEmail);
  if (equalsI(prev, next)) {
    return res.json({ success: true, message: 'E-mail unchanged' });
  }

  // Ensure unique everywhere (root + legacy for all roles)
  try {
    await ensureAvailableEverywhere(next, { model: role, id });
  } catch (e) {
    const status = e.status || 409;
    return res.status(status).json({ message: 'Email already in use' });
  }

  // Flip verified to false and issue a new verify token for the NEW email
  const rawVerify = randomBytes(32).toString('hex');
  const hashVerify = await bcrypt.hash(rawVerify, 12);
  user.verifyToken = hashVerify;
  user.verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
  user.verified = false;

  // Prepare restore data for security email to firstEmail
  const prevEmail = norm(prev);
  const firstEmail = getRoleFirstEmail(user, role);
  const rawRestore = randomBytes(32).toString('hex');
  user.emailChangePrev = prevEmail;
  user.emailChangeToken = await bcrypt.hash(rawRestore, 12);
  user.emailChangeExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h

  // Apply the change (root + legacy field mirror)
  setRoleEmail(user, role, next);

  // Persist with dup-key guard
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'Email already in use' });
    }
    throw err;
  }

  // Links
  const FE = process.env.FRONTEND_URL || '';
  if (!/^https?:\/\//i.test(FE)) {
    return res.status(500).json({ message: 'FRONTEND_URL is not set to a valid URL' });
  }
  const verifyLink  = `${FE}/verify-email?token=${rawVerify}&role=${role}&id=${user._id}`;
  const restoreLink = `${FE}/restore-email?token=${rawRestore}&role=${role}&id=${user._id}`;

  // Send emails
  const { sendMail } = require('../config/mailer');

  // 1) Send verification to the NEW email
  try {
    await sendMail(
      next,
      'Verify your new e-mail',
      `
        <p>Hello,</p>
        <p>You updated your account email to <b>${next}</b>. Please verify it using the link below (valid 24h):</p>
        <p><a href="${verifyLink}">${verifyLink}</a></p>
      `,
      'Verify your new email using the provided link.'
    );
  } catch (e) {
    // Don’t fail the request; user can request resend. But log it.
    console.error('sendMail new-email verification failed:', e);
  }

  // 2) Send security alert + restore link to firstEmail
  try {
    await sendMail(
      firstEmail,
      'Your account e-mail was changed',
      `
        <p>Your account e-mail was changed to <b>${next}</b>.</p>
        <p>If this wasn’t you, you can restore the previous e-mail:</p>
        <p><a href="${restoreLink}">Restore previous e-mail</a> (valid 24 hours)</p>
      `,
      'If this wasn’t you, use the restore link inside this email to revert the change.'
    );
  } catch (e) {
    console.error('sendMail firstEmail alert failed:', e);
  }

  return res.json({
    success: true,
    message: 'Email updated. Verification sent to new email; security alert sent to firstEmail.',
  });
});


exports.restoreEmail = asyncHandler(async (req, res) => {
  const { id, role, token } = req.body || {};
  if (!id || !role || !token) {
    return res.status(400).json({ message: 'id, role, token required' });
  }

  const Model = ROLE_MODEL[role];
  if (!Model) return res.status(400).json({ message: 'Unknown role' });

  // NOTE: emailChange* are often defined with select:false → explicitly include them
  const user = await Model.findById(id)
    .select('+emailChangeToken +emailChangePrev +emailChangeExpires +verifyToken +verifyExpires +verified +email +personal.email +identity.email')
    .exec();

  if (!user || !user.emailChangeToken || !user.emailChangePrev) {
    return res.status(400).json({ message: 'Nothing to restore' });
  }
  if (!(user.emailChangeExpires && user.emailChangeExpires > Date.now())) {
    return res.status(400).json({ message: 'Restore link expired' });
  }

  const ok = await bcrypt.compare(String(token), user.emailChangeToken);
  if (!ok) return res.status(400).json({ message: 'Invalid token' });

  // Ensure the previous email is still globally available (excluding this user)
  await assertEmailAvailableEverywhere(user.emailChangePrev, { model: role, id });

  // Restore: put previous email back to BOTH root + legacy path to satisfy unique indexes
  setRoleEmail(user, role, String(user.emailChangePrev).trim().toLowerCase());

  // Since we restored the original verified email, mark as verified and clear any pending verify token
  user.verified = true;
  user.verifyToken = undefined;
  user.verifyExpires = undefined;

  // Clear change tokens
  user.emailChangePrev    = undefined;
  user.emailChangeToken   = undefined;
  user.emailChangeExpires = undefined;

  // Persist (guard for dupe just in case)
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'Email already in use' });
    }
    throw err;
  }

  return res.json({ success: true, message: 'Previous e-mail restored' });
});