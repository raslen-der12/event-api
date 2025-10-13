/**************************************************************************************************
- ACTOR CONTROLLER (Consolidated)
  • Keeps all REST endpoints you already use
  • Replaces old socket with a single new actor↔actor socket: initActorSockets(app)
**************************************************************************************************/
const mongoose   = require('mongoose');
const asyncHdl   = require('express-async-handler');
const dayjs      = require('dayjs');

const ChatRoom   = require('../models/actorChatRoom');
const ChatMsg    = require('../models/actorChatMessage');
const Comment    = require('../models/eventComment');
const Ticket     = require('../models/actorSupportTicket');
const Report     = require('../models/actorReport');
const Bookmark   = require('../models/actorBookmark');
const Follow     = require('../models/actorFollow');
const Notif      = require('../models/actorNotification');
const Event      = require('../models/event');
const Sanction   = require('../models/actorSanction');
const Block      = require('../models/actorBlock');
const Upload     = require('../models/actorUpload');
const Reaction   = require('../models/actorMessageReaction');
const Pref       = require('../models/actorPreference');

const attendee   = require('../models/attendee');
const Exhibitor  = require('../models/exhibitor');
const Speaker    = require('../models/speaker');

const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const mime       = require('mime-types');

const { randomBytes } = require('crypto');
const { sendMail }   = require('../config/mailer');
const {
  imageUploader,
  handleAdvancedMulterError,
  cleanupFile,
} = require('../middleware/uploader');
// roles (same models you used in auth)
const RoleBusinessOwner = require('../models/roles/BusinessOwner');
const RoleInvestor      = require('../models/roles/Investor');
const RoleConsultant    = require('../models/roles/Consultant');
const RoleExpert        = require('../models/roles/Expert');
const RoleEmployee      = require('../models/roles/Employee');
const RoleStudent       = require('../models/roles/Student');
// === BP sync helpers ===
const BusinessProfileData = require('../models/BusinessProfile'); // adjust path if different

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

// "Fintech, SaaS\nAI" -> ["Fintech","SaaS","AI"]
const splitList = (s) =>
  String(s || '')
    .split(/[\n,]+/g)
    .map(t => t.trim())
    .filter(Boolean);

// ["Fintech","SaaS"] -> "Fintech, SaaS"
const joinList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');

// Find ONE BP owned by this actor
async function findActorBP(actorId) {
  return BusinessProfileData
    .findOne({ 'owner.actor': actorId })
    .select('_id offering seeking name slug published owner role')
    .lean()
    .exec();
}

const ROLE_KIND = Object.freeze({
  BUSINESS_OWNER: 'Business Owner',
  INVESTOR: 'Investor',
  CONSULTANT: 'Consultant',
  EXPERT: 'Expert',
  EMPLOYEE: 'Employee',
  STUDENT: 'Student'
});
const ROLE_MODELS = {
  [ROLE_KIND.BUSINESS_OWNER]: RoleBusinessOwner,
  [ROLE_KIND.INVESTOR]: RoleInvestor,
  [ROLE_KIND.CONSULTANT]: RoleConsultant,
  [ROLE_KIND.EXPERT]: RoleExpert,
  [ROLE_KIND.EMPLOYEE]: RoleEmployee,
  [ROLE_KIND.STUDENT]: RoleStudent
};
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
      return RoleBusinessOwner.create({
        actor: actorDoc._id,
        businessName: roleData.businessName || actorDoc?.identity?.orgName || actorDoc?.organization?.orgName || 'Business',
        email: roleData.email || (baseActorType==='exhibitor' ? actorDoc.identity.email : actorDoc.personal?.email),
        country: roleData.country || (actorDoc.personal?.country || actorDoc.identity?.country),
        shortDescription: roleData.shortDescription || '',
        website: roleData.website || '',
        businessType: roleData.businessType,
        sector: roleData.sector,
        subSectors: roleData.subSectors || [],
        businessSize: roleData.businessSize
      });
    case ROLE_KIND.INVESTOR:
      return RoleInvestor.create({
        actor: actorDoc._id,
        name: roleData.name || roleData.investorName || 'Investor',
        investorType: roleData.investorType || 'Individual',
        focusSectors: roleData.focusSectors || [],
        ticketMin: roleData.ticketMin,
        ticketMax: roleData.ticketMax,
        stagePreference: roleData.stagePreference || [],
        countryPreference: roleData.countryPreference || [],
        website: roleData.website || '',
        linkedin: roleData.linkedin || '',
        contactEmail: roleData.contactEmail || (actorDoc.personal?.email),
        contactPhone: roleData.contactPhone || ''
      });
    case ROLE_KIND.CONSULTANT:
      return RoleConsultant.create({
        actor: actorDoc._id,
        expertiseArea: roleData.expertiseArea || 'Consulting',
        sectors: roleData.sectors || [],
        experienceYears: roleData.experienceYears || 0,
        certifications: roleData.certifications || [],
        servicesOffered: roleData.servicesOffered || [],
        hourlyRate: roleData.hourlyRate,
        portfolioLinks: roleData.portfolioLinks || [],
        availability: roleData.availability || 'Available'
      });
    case ROLE_KIND.EXPERT:
      return RoleExpert.create({
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
      return RoleEmployee.create({
        actor: actorDoc._id,
        currentPosition: roleData.currentPosition || 'Employee',
        companyName: roleData.companyName || '',
        experienceYears: roleData.experienceYears || 0,
        skills: roleData.skills || [],
        careerGoals: roleData.careerGoals || '',
        education: roleData.education || ''
      });
    case ROLE_KIND.STUDENT:
      return RoleStudent.create({
        actor: actorDoc._id,
        fullName: roleData.fullName || actorDoc.personal?.fullName,
        university: roleData.university || '',
        fieldOfStudy: roleData.fieldOfStudy || '',
        graduationYear: roleData.graduationYear,
        skills: roleData.skills || [],
        interests: roleData.interests || [],
        portfolio: roleData.portfolio || ''
      });
    default:
      return null;
  }
}

/* ──────────────────────────── Small utils ──────────────────────────── */
const EMAIL_RX = /^[\w.-]+@[\w.-]+.\w{2,}$/;
const isId = (v) => mongoose.isValidObjectId(v);
const escapeRx = (s='') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const get = (obj, path) => path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);

function genPassword(){
  const base = randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0,11);
  const symbols = '!@#$%^&*';
  return base + symbols[randomBytes(1)[0] % symbols.length];
}

async function emailExists(email) {
  const [a, e, s] = await Promise.all([
    attendee.exists({ 'personal.email': email }),
    Exhibitor.exists({ 'identity.email': email }),
    Speaker.exists({ 'personal.email': email }),
  ]);
  return !!(a || e || s);
}

/* ───────────────────────── Actor creation (admin) ───────────────────── */
exports.createActorSimple = asyncHdl(async (req, res) => {
  let { role, eventId, roleKind, roleData } = req.body || {};
  role = String(role || '').toLowerCase().trim();
  roleKind = String(roleKind || '').trim();

  // normalize roleKind to canonical labels used in your new workflow
  const normKind = (() => {
    const s = roleKind.toLowerCase();
    if (['business owner','business_owner','owner'].includes(s)) return 'Business Owner';
    if (['investor'].includes(s)) return 'Investor';
    if (['consultant'].includes(s)) return 'Consultant';
    if (['expert'].includes(s)) return 'Expert';
    if (['employee'].includes(s)) return 'Employee';
    if (['student'].includes(s)) return 'Student';
    return roleKind ? roleKind : null; // accept already-canonical value if sent
  })();

  const name    = String(req.body?.personal?.fullName || req.body?.identity?.exhibitorName || '').trim();
  const email   = String(req.body?.personal?.email || req.body?.identity?.email || '').toLowerCase().trim();
  const country = String(req.body?.personal?.country || req.body?.identity?.country || 'Unknown').trim();

  if (!['attendee', 'exhibitor', 'speaker'].includes(role))
    return res.status(400).json({ message: 'role must be attendee | exhibitor | speaker' });
  if (!name || !email || !EMAIL_RX.test(email))
    return res.status(400).json({ message: 'Valid name and email are required' });
  if (!eventId || !mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: 'Valid eventId is required' });
  if (await emailExists(email))
    return res.status(409).json({ message: 'Email already registered' });

  const pwdPlain = genPassword();
  let created, roleOut = role;

  try {
    if (role === 'attendee') {
      created = await attendee.create({
        personal: { fullName: name, email, country, profilePic: '/default/photodef.png' },
        organization: { orgName: 'Unknown', businessRole: 'Unknown' },
        businessProfile: { primaryIndustry: 'Unknown', businessModel: 'B2B' },
        matchingIntent: { objectives: ['Unknown'], openToMeetings: false },
        verified: false, adminVerified: 'yes',
        role: normKind || undefined,            // ⬅ base doc stores selected role-kind
        pwd: pwdPlain, id_event: eventId
      });
    } else if (role === 'exhibitor') {
      created = await Exhibitor.create({
        identity: {
          exhibitorName: name, orgName: 'Unknown', country,
          contactName: 'Unknown', email, logo: '/default/logodef.png'
        },
        business: { industry: 'Unknown', businessModel: 'B2B' },
        commercial: {
          offering: 'Unknown', lookingFor: 'Unknown',
          lookingPartners: false, regionInterest: ['Unknown'],
          availableMeetings: false
        },
        verified: false, adminVerified: 'yes',
        role: normKind || undefined,            // ⬅ base doc stores selected role-kind
        pwd: pwdPlain, id_event: eventId
      });
    } else {
      created = await Speaker.create({
        personal: { fullName: name, email, country, profilePic: '/default/photodef.png' },
        organization: { orgName: 'Unknown', jobTitle: 'NM', businessRole: 'Expert' },
        talk: {
          title: 'Unknown', abstract: 'Unknown',
          topicCategory: 'Unknown', targetAudience: 'Unknown', language: 'en'
        },
        b2bIntent: { openMeetings: false, representingBiz: false },
        verified: false, adminVerified: 'yes',
        role: normKind || undefined,            // ⬅ base doc stores selected role-kind
        pwd: pwdPlain, id_event: eventId
      });
    }
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 11001)) {
      return res.status(409).json({ message: 'Email must be unique' });
    }
    if (err?.name === 'ValidationError') {
      const first = Object.values(err.errors || {})[0];
      return res.status(400).json({ message: first?.message || 'Validation error' });
    }
    return res.status(500).json({ message: 'Creation failed' });
  }

  // Best-effort: create role-kind document tied to the actor
  // We try dynamic requires so you don’t have to add imports elsewhere.
  if (normKind) {
    try {
      const map = {
        'Business Owner': 'BusinessOwner',
        'Investor': 'Investor',
        'Consultant': 'Consultant',
        'Expert': 'Expert',
        'Employee': 'Employee',
        'Student': 'Student'
      };
      const file = map[normKind];
      if (file) {
        // try ../models first; fallback to ./models if structure differs
        let RoleModel;
        try { RoleModel = require(`../models/${file}`); }
        catch { try { RoleModel = require(`./models/${file}`); } catch { RoleModel = null; } }
        if (RoleModel?.create) {
          const baseEmail = role === 'exhibitor' ? created?.identity?.email : created?.personal?.email;
          const baseCountry = created?.personal?.country || created?.identity?.country;
          await RoleModel.create({
            actor: created._id,
            // put some sensible defaults; incoming roleData overrides them
            email: baseEmail,
            country: baseCountry,
            ...((roleData && typeof roleData === 'object') ? roleData : {})
          });
        }
      }
    } catch (e) {
      // do not fail the main flow for role document issues
      console.warn('[createActorSimple] role document create failed:', e?.message);
    }
  }

  try {
    await sendMail(
      email,
      'Your account has been created',
      `<p>Hello ${name},</p>
       <p>An account was created for you on GITS.</p>
       <p><b>Role:</b> ${roleOut}${normKind ? ` — ${normKind}` : ''}</p>
       <p><b>Temporary password:</b> <code>${pwdPlain}</code></p>
       <p>Please log in and change your password immediately.</p>`
    );
  } catch {
    return res.status(201).json({
      success: true,
      message: 'Actor created, but email failed to send. Resend from admin panel.',
      data: { id: created._id, role: roleOut, roleKind: normKind || null }
    });
  }

  return res.status(201).json({
    success: true,
    message: 'Actor created and credentials sent by email',
    data: { id: created._id, role: roleOut, roleKind: normKind || null }
  });
});


/* ───────────────────────── Actor list (admin UI) ───────────────────── */
const ROLE_MAPAD = {
  attendee: {
    Model: attendee,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    profilePic: ['personal.profilePic'],
    logo: []
  },
  exhibitor: {
    Model: Exhibitor,
    name: ['identity.exhibitorName'],
    email: ['identity.email'],
    country: ['identity.country'],
    profilePic: [],
    logo: ['identity.logo','logo','valueAdds.logo']
  },
  speaker: {
    Model: Speaker,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    profilePic: ['personal.profilePic'],
    logo: []
  }
};

function buildSearch(paths, term) {
  if (!term) return null;
  const rx = new RegExp(escapeRx(term), 'i');
  return { $or: paths.map(p => ({ [p]: rx })) };
}
function pickFirst(doc, paths) {
  for (const p of paths || []) {
    const v = get(doc, p);
    if (v != null && v !== '') return v;
  }
  return null;
}

exports.getActorsList = asyncHdl(async (req, res) => {
  let { role, limit, search } = req.body || {};
  role = (role || '').toString().toLowerCase();

  const conf = ROLE_MAPAD[role];
  if (!conf) return res.status(400).json({ message: 'role must be attendee | exhibitor | speaker' });

  const k = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 10;

  const base = (role === 'speaker')
    ? {}
    : { $or: [{ adminVerified: 'yes' }, { adminVerified: true }] };

  const sFilter = buildSearch([...conf.name, ...conf.email], search);
  const query   = sFilter ? { $and: [base, sFilter] } : base;

  const proj = {};
  [...conf.name, ...conf.email, ...conf.country, ...conf.profilePic, ...conf.logo].forEach(p => (proj[p] = 1));
  proj.verified = 1;
  proj.createdAt = 1;
  proj.role = 1; // ⬅ include roleKind field from base doc

  const rows = await conf.Model.find(query, proj).sort({ createdAt: -1 }).limit(k).lean().exec();

  const data = rows.map(d => ({
    id: d._id,
    name      : pickFirst(d, conf.name)      || '',
    email     : pickFirst(d, conf.email)     || '',
    country   : pickFirst(d, conf.country)   || '',
    profilePic: pickFirst(d, conf.profilePic) || null,
    logo      : pickFirst(d, conf.logo)       || null,
    verified  : !!d.verified,
    roleKind  : d.role || null               // ⬅ expose roleKind in list
  }));

  return res.json({ success: true, count: data.length, data });
});


exports.getActorFullById = asyncHdl(async (req, res) => {
  const { id } = req.params || {};
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid id' });

  const proj = { pwd: 0 };

  // helper to collect role-kind subdocs across all role models
  async function collectRoleDocs(actorId){
    const files = ['BusinessOwner','Investor','Consultant','Expert','Employee','Student'];
    const found = [];
    for (const f of files){
      try {
        let M;
        try { M = require(`../models/${f}`); }
        catch { try { M = require(`./models/${f}`); } catch { M = null; } }
        if (M?.findOne) {
          const doc = await M.findOne({ actor: actorId }).lean();
          if (doc) found.push({ kind: f.replace(/([A-Z])/g, ' $1').trim(), data: doc });
        }
      } catch (_) { /* ignore missing model */ }
    }
    return found;
  }

  let data = await Exhibitor.findById(id, proj).lean().exec();
  if (data) {
    const roles = await collectRoleDocs(id);
    return res.json({ success: true, role: 'exhibitor', roleKind: data.role || null, data, roles });
  }

  data = await attendee.findById(id, proj).lean().exec();
  if (data) {
    const roles = await collectRoleDocs(id);
    return res.json({ success: true, role: 'attendee', roleKind: data.role || null, data, roles });
  }

  data = await Speaker.findById(id, proj).lean().exec();
  if (data) {
    const roles = await collectRoleDocs(id);
    return res.json({ success: true, role: 'speaker', roleKind: data.role || null, data, roles });
  }

  return res.status(404).json({ message: 'Actor not found' });
});


/* ───────────────────────── Requests panel (admin) ───────────────────── */
const MAP = {
  attendee : { Model: attendee,  select: 'personal organization businessProfile matchingIntent id_event createdAt actorType subRole adminVerified verified' },
  exhibitor: { Model: Exhibitor, select: 'identity business commercial id_event createdAt actorType subRole adminVerified verified' },
  speaker  : { Model: Speaker,   select: 'profile organization talk businessIntent id_event createdAt' }
};

const STATUSES = ['no', 'yes', 'pending'];
const escapeRegExp = (s='') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const projattendee = (a) => ({
  _id  : a._id,
  role : 'attendee',
  verifiedEmail: a.verified,
  adminVerified: a.adminVerified,
  profilePic: a.personal?.profilePic || '',
  name : a.personal?.fullName || '',
  email: a.personal?.email || '',
  country: a.personal?.country || '',
  createdAt: a.createdAt
});
const projExhibitor = (e) => ({
  _id  : e._id,
  role : 'exhibitor',
  logo : e.identity?.logo || '',
  verifiedEmail: e.verified,
  adminVerified: e.adminVerified,
  name : e.identity?.contactName || e.identity?.exhibitorName || '',
  email: e.identity?.email || '',
  country: e.identity?.country || '',
  createdAt: e.createdAt
});

async function fetchBucket(status, limit, search) {
  const qA = { adminVerified: status };
  const qE = { adminVerified: status };
  if (search) {
    const rx = new RegExp(escapeRegExp(search), 'i');
    qA.$or = [{ 'personal.email': rx }, { 'personal.fullName': rx }];
    qE.$or = [{ 'identity.email': rx }, { 'identity.contactName': rx }];
  }
  const k = Math.max(1, Number(limit) || 5);
  const [att, ex] = await Promise.all([
    attendee.find(qA).sort({ createdAt: -1 }).limit(k).lean().exec(),
    Exhibitor.find(qE).sort({ createdAt: -1 }).limit(k).lean().exec()
  ]);
  const merged = [...att.map(projattendee), ...ex.map(projExhibitor)]
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, k);
  return merged;
}

exports.getRequests = asyncHdl(async (req, res) => {
  let { adminVerify, limit, search } = req.body || {};
  adminVerify = typeof adminVerify === 'string' ? adminVerify.trim().toLowerCase() : undefined;
  search      = typeof search === 'string' ? search.trim() : undefined;
  limit       = limit != null ? Number(limit) : undefined;

  const hasType   = !!adminVerify;
  const hasLimit  = Number.isFinite(limit);
  const hasSearch = !!search;

  if (hasType && !STATUSES.includes(adminVerify)) {
    return res.status(400).json({ message: 'adminVerify must be one of: no | yes | pending' });
  }

  if (
       (hasLimit && !hasType && !hasSearch)
    || (hasSearch && !hasType && !hasLimit)
    || (hasType && !hasLimit && !hasSearch)
    || (hasLimit && hasSearch && !hasType)
    || (hasLimit && hasSearch && hasType)
  ) {
    return res.status(400).json({ message: 'Invalid parameter combination' });
  }

  const MAIN_LIMIT  = hasLimit ? Math.min(Math.max(1, limit), 100) : 5;
  const OTHER_LIMIT = 5;

  let data = { no: [], yes: [], pending: [] };

  if (!hasType && !hasLimit && !hasSearch) {
    const [no, yes, pending] = await Promise.all(
      STATUSES.map(s => fetchBucket(s, OTHER_LIMIT, undefined))
    );
    data = { no, yes, pending };
  } else if (hasType && hasLimit && !hasSearch) {
    const others = STATUSES.filter(s => s !== adminVerify);
    const [main, o1, o2] = await Promise.all([
      fetchBucket(adminVerify, MAIN_LIMIT, undefined),
      fetchBucket(others[0], OTHER_LIMIT, undefined),
      fetchBucket(others[1], OTHER_LIMIT, undefined),
    ]);
    data[adminVerify] = main;
    data[others[0]]   = o1;
    data[others[1]]   = o2;
  } else if (hasType && hasSearch && !hasLimit) {
    const others = STATUSES.filter(s => s !== adminVerify);
    const [main, o1, o2] = await Promise.all([
      fetchBucket(adminVerify, OTHER_LIMIT, search),
      fetchBucket(others[0], OTHER_LIMIT, undefined),
      fetchBucket(others[1], OTHER_LIMIT, undefined),
    ]);
    data[adminVerify] = main;
    data[others[0]]   = o1;
    data[others[1]]   = o2;
  } else {
    return res.status(400).json({ message: 'Invalid parameter combination' });
  }

  // ===== NEW: attach assignedRoles to every item across buckets =====
  const allItems = [...data.no, ...data.yes, ...data.pending];
  const ids = Array.from(new Set(allItems.map(i => String(i._id))));

  if (ids.length) {
    const fetchSet = async (Model) => {
      const rows = await Model.find({ actor: { $in: ids } }).select('actor').lean();
      return new Set(rows.map(r => String(r.actor)));
    };

    const [
      sBO, sCO, sEM, sEX, sIN, sST
    ] = await Promise.all([
      fetchSet(RoleBusinessOwner),
      fetchSet(RoleConsultant),
      fetchSet(RoleEmployee),
      fetchSet(RoleExpert),
      fetchSet(RoleInvestor),
      fetchSet(RoleStudent),
    ]);

    const rolesFor = (id) => {
      const k = String(id);
      const out = [];
      if (sBO.has(k)) out.push('businessOwner');
      if (sCO.has(k)) out.push('consultant');
      if (sEM.has(k)) out.push('employee');
      if (sEX.has(k)) out.push('expert');
      if (sIN.has(k)) out.push('investor');
      if (sST.has(k)) out.push('student');
      return out;
    };

    data.no      = data.no.map(i => ({ ...i, assignedRoles: rolesFor(i._id) }));
    data.yes     = data.yes.map(i => ({ ...i, assignedRoles: rolesFor(i._id) }));
    data.pending = data.pending.map(i => ({ ...i, assignedRoles: rolesFor(i._id) }));
  }

  return res.json({
    success: true,
    criteria: { adminVerify: adminVerify || null, limit: hasLimit ? MAIN_LIMIT : null, search: hasSearch ? search : null },
    data
  });
});


exports.setAdminVerify = asyncHdl(async (req, res) => {
  let { id, adminVerified } = req.body || {};
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid id' });

  adminVerified = String(adminVerified || '').toLowerCase();
  if (!['yes', 'no'].includes(adminVerified))
    return res.status(400).json({ message: 'adminVerified must be "yes" or "no"' });

  const update = { adminVerified, updatedAt: new Date() };

  let role = null;
  let doc = await Exhibitor.findOneAndUpdate(
    { _id: id },
    { $set: update },
    { new: true, projection: { pwd: 0, verifyToken: 0, verifyExpires: 0 } }
  ).lean();
  if (doc) role = 'exhibitor';

  if (!doc) {
    doc = await attendee.findOneAndUpdate(
      { _id: id },
      { $set: update },
      { new: true, projection: { pwd: 0, verifyToken: 0, verifyExpires: 0 } }
    ).lean();
    if (doc) role = 'attendee';
  }

  // NEW: allow speakers too
  if (!doc) {
    doc = await Speaker.findOneAndUpdate(
      { _id: id },
      { $set: update },
      { new: true, projection: { pwd: 0, verifyToken: 0, verifyExpires: 0 } }
    ).lean();
    if (doc) role = 'speaker';
  }

  if (!doc) return res.status(404).json({ message: 'Actor not found (exhibitor/attendee/speaker)' });

  try { req.app?.locals?.io?.emit('adminVerified:changed', { id, role, adminVerified }); } catch(_) {}

  return res.json({
    success: true,
    message: `Actor ${role} updated`,
    data: { id: doc._id, role, adminVerified: doc.adminVerified }
  });
});

exports.getActorProfile = asyncHdl(async (req, res) => {
  const { role, id } = req.body;
  const conf = MAP[role];
  if (!conf) return res.status(400).json({ message: 'Unsupported role' });
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Bad id' });

  const doc = await conf.Model.findById(id).select(conf.select).lean().exec();
  if (!doc) return res.status(404).json({ message: 'Not found' });

  // ─── Mirror BusinessProfile -> role blocks (view only) ───
  try {
    const bp = await findActorBP(id);
    if (bp) {
      const bpOffering = Array.isArray(bp.offering) ? bp.offering : [];
      const bpSeeking  = Array.isArray(bp.seeking)  ? bp.seeking  : [];
      const R = (role || '').toLowerCase();

      if (R === 'attendee') {
        const mi = isObj(doc.matchingIntent) ? { ...doc.matchingIntent } : {};
        if (!mi.offering && bpOffering.length) mi.offering = joinList(bpOffering);
        if (!mi.needs    && bpSeeking.length)  mi.needs    = joinList(bpSeeking);
        doc.matchingIntent = mi;
      }
      if (R === 'exhibitor') {
        const cm = isObj(doc.commercial) ? { ...doc.commercial } : {};
        if (!cm.offering   && bpOffering.length) cm.offering   = joinList(bpOffering);
        if (!cm.lookingFor && bpSeeking.length)  cm.lookingFor = joinList(bpSeeking);
        doc.commercial = cm;
      }
      if (R === 'speaker') {
        const b2b = isObj(doc.b2bIntent) ? { ...doc.b2bIntent } : {};
        if (!b2b.offering   && bpOffering.length) b2b.offering   = joinList(bpOffering);
        if (!b2b.lookingFor && bpSeeking.length)  b2b.lookingFor = joinList(bpSeeking);
        doc.b2bIntent = b2b;
        doc.verified = doc.verified ? doc.verified : true ;
      }
    }
  } catch {}

  // ===== NEW: include assignedRoles for this actor =====
  const [
    isBO, isCO, isEM, isEX, isIN, isST
  ] = await Promise.all([
    RoleBusinessOwner.exists({ actor: id }),
    RoleConsultant.exists({ actor: id }),
    RoleEmployee.exists({ actor: id }),
    RoleExpert.exists({ actor: id }),
    RoleInvestor.exists({ actor: id }),
    RoleStudent.exists({ actor: id }),
  ]);

  const assignedRoles = []
    .concat(isBO ? ['businessOwner'] : [])
    .concat(isCO ? ['consultant']    : [])
    .concat(isEM ? ['employee']      : [])
    .concat(isEX ? ['expert']        : [])
    .concat(isIN ? ['investor']      : [])
    .concat(isST ? ['student']       : []);

  const bps = await BusinessProfileData.find({ 'owner.actor': id })
    .select('_id slug published name logoUpload event owner.role')
    .lean()
    .exec();
  doc.bp = bps.length;

  res.json({ success: true, role, data: doc, assignedRoles });
});



/* ───────────────────────── Chat (REST) ───────────────────── */
/* 1) Ensure / create DM  POST /actors/chat { peerId } */
exports.getOrCreateDM = asyncHdl(async (req, res) => {
  const { peerId } = req.body;
  const meId = req.user._id;
  if (!isId(peerId) || String(peerId) === String(meId))
    return res.status(400).json({ message:'Bad peerId' });

  let room = await ChatRoom.findOne({ members: { $all: [meId, peerId], $size: 2 }, isGroup: { $ne: true } });
  if (!room) room = await ChatRoom.create({ members:[ meId, peerId ], isGroup:false });

  // attach roles for both sides
  const loadRoles = async (actorId) => {
    const [bo, co, em, ex, inv, st] = await Promise.all([
      RoleBusinessOwner.exists({ actor: actorId }),
      RoleConsultant.exists({ actor: actorId }),
      RoleEmployee.exists({ actor: actorId }),
      RoleExpert.exists({ actor: actorId }),
      RoleInvestor.exists({ actor: actorId }),
      RoleStudent.exists({ actor: actorId }),
    ]);
    const r = [];
    if (bo) r.push('businessOwner');
    if (co) r.push('consultant');
    if (em) r.push('employee');
    if (ex) r.push('expert');
    if (inv) r.push('investor');
    if (st) r.push('student');
    return r;
  };

  const [meRoles, peerRoles] = await Promise.all([loadRoles(meId), loadRoles(peerId)]);

  res.status(201).json({ success:true, data:{ roomId: room._id, meRoles, peerRoles } });
});


/* 2) Send message (HTTP fallback) POST /actors/chat/:roomId */
exports.sendChatMessage = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { text = '', files = [] } = req.body || {};
  const senderId = req.user._id;

  const room = await ChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Room not found' });
  if (!room.members.some(id => String(id) === String(senderId)))
    return res.status(403).json({ message:'Not in room' });

  const msg = await ChatMsg.create({
    roomId, senderId, text: text || '', files: Array.isArray(files) ? files : [], seenBy: [senderId]
  });

  // sender roles on the event payloads
  const [bo, co, em, ex, inv, st] = await Promise.all([
    RoleBusinessOwner.exists({ actor: senderId }),
    RoleConsultant.exists({ actor: senderId }),
    RoleEmployee.exists({ actor: senderId }),
    RoleExpert.exists({ actor: senderId }),
    RoleInvestor.exists({ actor: senderId }),
    RoleStudent.exists({ actor: senderId }),
  ]);
  const senderRoles = []
    .concat(bo ? ['businessOwner'] : [])
    .concat(co ? ['consultant']    : [])
    .concat(em ? ['employee']      : [])
    .concat(ex ? ['expert']        : [])
    .concat(inv ? ['investor']     : [])
    .concat(st ? ['student']       : []);

  const payload = {
    roomId,
    msg: { _id: msg._id, senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt, senderRoles }
  };

  req.app.locals.io.to(String(roomId)).emit('chat:new', payload);
  req.app.locals.io.of('/admin').to(String(roomId)).emit('chat:new', payload);

  res.status(201).json({ success:true, data:{ messageId: msg._id } });
});

/* 3) List messages GET /actors/chat/:roomId/messages?before=&limit=40 */
exports.listChat = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { before, limit = 40 } = req.query;

  const meId = req.user._id;
  const room = await ChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Room not found' });
  if (!room.members.some(id => String(id) === String(meId)))
    return res.status(403).json({ message:'Not in room' });

  const q = { roomId };
  if (before && isId(before)) q._id = { $lt: before };

  const msgs = await ChatMsg.find(q).sort({ _id: -1 }).limit(Number(limit)).lean();

  // build rolesByUser for all senders in this page
  const senderIds = Array.from(new Set(msgs.map(m => String(m.senderId)).filter(Boolean)));
  const rolesByUser = {};
  if (senderIds.length) {
    const has = async (Model) => {
      const rows = await Model.find({ actor: { $in: senderIds } }).select('actor').lean();
      return new Set(rows.map(r => String(r.actor)));
    };
    const [sBO, sCO, sEM, sEX, sIN, sST] = await Promise.all([
      has(RoleBusinessOwner), has(RoleConsultant), has(RoleEmployee),
      has(RoleExpert), has(RoleInvestor), has(RoleStudent),
    ]);

    for (const id of senderIds) {
      const r = [];
      if (sBO.has(id)) r.push('businessOwner');
      if (sCO.has(id)) r.push('consultant');
      if (sEM.has(id)) r.push('employee');
      if (sEX.has(id)) r.push('expert');
      if (sIN.has(id)) r.push('investor');
      if (sST.has(id)) r.push('student');
      rolesByUser[id] = r;
    }
  }

  res.json({ success:true, count: msgs.length, data: msgs.reverse(), rolesByUser });
});


/* 4) Mark seen PATCH /actors/chat/:roomId/seen { msgIds:[] } */
exports.markSeen = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { msgIds = [] } = req.body;
  const meId = req.user._id;

  await ChatMsg.updateMany(
    { _id: { $in: msgIds.filter(isId) }, roomId },
    { $addToSet: { seenBy: meId } }
  );

  // include the roles of the user who just saw the messages
  const [bo, co, em, ex, inv, st] = await Promise.all([
    RoleBusinessOwner.exists({ actor: meId }),
    RoleConsultant.exists({ actor: meId }),
    RoleEmployee.exists({ actor: meId }),
    RoleExpert.exists({ actor: meId }),
    RoleInvestor.exists({ actor: meId }),
    RoleStudent.exists({ actor: meId }),
  ]);
  const userRoles = []
    .concat(bo ? ['businessOwner'] : [])
    .concat(co ? ['consultant']    : [])
    .concat(em ? ['employee']      : [])
    .concat(ex ? ['expert']        : [])
    .concat(inv ? ['investor']     : [])
    .concat(st ? ['student']       : []);

  req.app.locals.io.to(String(roomId)).emit('chat:seen', { roomId, msgIds, userId: meId, userRoles });
  res.json({ success:true });
});


/* ───────────────────────── Comments (public) ───────────────────── */
exports.createComment = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  const { text = '', parentId = null } = req.body;
  if (!text.trim()) return res.status(400).json({ message:'Text required' });

  // capture all current roles of the author
  const actorId = req.user._id;
  const [bo, co, em, ex, inv, st] = await Promise.all([
    RoleBusinessOwner.exists({ actor: actorId }),
    RoleConsultant.exists({ actor: actorId }),
    RoleEmployee.exists({ actor: actorId }),
    RoleExpert.exists({ actor: actorId }),
    RoleInvestor.exists({ actor: actorId }),
    RoleStudent.exists({ actor: actorId }),
  ]);
  const actorRoles = []
    .concat(bo ? ['businessOwner'] : [])
    .concat(co ? ['consultant']    : [])
    .concat(em ? ['employee']      : [])
    .concat(ex ? ['expert']        : [])
    .concat(inv ? ['investor']     : [])
    .concat(st ? ['student']       : []);

  const comment = await Comment.create({
    eventId,
    actorId,
    actorRole: req.user.role,     // keep legacy single-role if you still use it
    actorRoles,                   // NEW multi-role snapshot
    parentId : parentId || null,
    text,
    verified : false
  });

  res.status(201).json({ success:true, pending:true, data:{ commentId: comment._id, actorRoles } });
});


exports.listComments = asyncHdl(async (req, res) => {
  const { eventId } = req.params;
  const { after, limit=30 } = req.query;
  const q = { eventId, verified:true };
  if (after) q.createdAt = { $gt: new Date(after) };

  const rows = await Comment.find(q).sort({ createdAt: 1 }).limit(Number(limit)).lean();

  // hydrate roles for authors (for old comments that may not have actorRoles saved)
  const authorIds = Array.from(new Set(rows.map(r => String(r.actorId))));
  const rolesByUser = {};
  if (authorIds.length) {
    const fetchSet = async (Model) => {
      const docs = await Model.find({ actor: { $in: authorIds } }).select('actor').lean();
      return new Set(docs.map(d => String(d.actor)));
    };
    const [sBO, sCO, sEM, sEX, sIN, sST] = await Promise.all([
      fetchSet(RoleBusinessOwner),
      fetchSet(RoleConsultant),
      fetchSet(RoleEmployee),
      fetchSet(RoleExpert),
      fetchSet(RoleInvestor),
      fetchSet(RoleStudent),
    ]);

    for (const id of authorIds) {
      const r = [];
      if (sBO.has(id)) r.push('businessOwner');
      if (sCO.has(id)) r.push('consultant');
      if (sEM.has(id)) r.push('employee');
      if (sEX.has(id)) r.push('expert');
      if (sIN.has(id)) r.push('investor');
      if (sST.has(id)) r.push('student');
      rolesByUser[id] = r;
    }
  }

  // attach roles to each returned comment (prefer stored actorRoles if present)
  const data = rows.map(r => ({
    ...r,
    actorRoles: Array.isArray(r.actorRoles) && r.actorRoles.length ? r.actorRoles : (rolesByUser[String(r.actorId)] || [])
  }));

  res.json({ success:true, count: data.length, data });
});


/* ───────────────────────── Support ───────────────────── */
exports.openTicket = asyncHdl(async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ message:'subject & message required' });

  const t = await Ticket.create({ actorId: req.user._id, subject, message });
  res.status(201).json({ success:true, data:{ ticketId: t._id } });
});

exports.myTickets = asyncHdl(async (req, res) => {
  const rows = await Ticket.find({ actorId: req.user._id }).sort({ createdAt:-1 }).lean();
  res.json({ success:true, data: rows });
});

/* ───────────────────────── Reports ───────────────────── */
exports.reportActor = asyncHdl(async (req, res) => {
  const { reportedId, reason } = req.body;
  if (!isId(reportedId) || !reason?.trim())
    return res.status(400).json({ message:'reportedId & reason required' });

  const rpt = await Report.create({ reporterId: req.user._id, reportedId, reason });
  res.status(201).json({ success:true, data:{ reportId: rpt._id } });
});

exports.editComment = asyncHdl(async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message:'text required' });

  const c = await Comment.findOne({ _id: id, actorId: req.user._id });
  if (!c) return res.status(404).json({ message:'Not found' });
  if (c.verified) return res.status(409).json({ message:'Already approved – cannot edit' });

  c.text = text;
  await c.save();
  res.json({ success:true });
});

exports.deleteComment = asyncHdl(async (req, res) => {
  const { id } = req.params;
  await Comment.deleteOne({ _id: id, actorId: req.user._id, verified: false });
  res.json({ success:true });
});

/* ───────────────────────── Group chat mgmt ───────────────────── */
exports.createGroupChat = asyncHdl(async (req, res) => {
  const { title, memberIds = [] } = req.body;
  const me = req.user._id;
  const members = [...new Set([...memberIds, me.toString()])].filter(isId);
  if (members.length < 3) return res.status(400).json({ message:'Need ≥3 members' });

  const room = await ChatRoom.create({ members, isGroup: true, title });
  res.status(201).json({ success:true, data:{ roomId: room._id } });
});

exports.inviteMembers = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const { userIds = [] } = req.body;
  const me = req.user._id;

  const room = await ChatRoom.findById(roomId);
  if (!room || !room.isGroup) return res.status(404).json({ message:'Group not found' });
  if (!room.members.some(id => String(id) === String(me)))
    return res.status(403).json({ message:'Not in group' });

  const added = userIds.filter(isId);
  await ChatRoom.updateOne({ _id: roomId }, { $addToSet: { members: { $each: added } } });
  req.app.locals.io.to(String(roomId)).emit('chat:membersAdded', { roomId, added });
  res.json({ success:true });
});

exports.leaveGroup = asyncHdl(async (req, res) => {
  const { roomId } = req.params;
  const me = req.user._id;

  await ChatRoom.updateOne({ _id: roomId }, { $pull: { members: me } });
  req.app.locals.io.to(String(roomId)).emit('chat:left', { roomId, userId: me });
  res.json({ success:true });
});

exports.listMyRooms = asyncHdl(async (req, res) => {
  const me = req.user._id;
  const rooms = await ChatRoom.aggregate([
    { $match: { members: me } },
    { $lookup: {
        from: 'actorchatmessages',
        let: { roomId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$roomId', '$$roomId'] } } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 }
        ],
        as: 'last'
    }},
    { $addFields: { lastMessage: { $arrayElemAt: ['$last', 0] } } },
    { $project: { last: 0 } },
    { $sort: { 'lastMessage.createdAt': -1 } }
  ]);
  res.json({ success:true, data: rooms });
});

exports.updateTicket = asyncHdl(async (req, res) => {
  const { id } = req.params;
  const { message, close } = req.body;

  const t = await Ticket.findOne({ _id: id, actorId: req.user._id });
  if (!t) return res.status(404).json({ message:'Ticket not found' });
  if (t.status === 'closed') return res.status(409).json({ message:'Closed' });

  if (close) t.status = 'closed';
  if (message) t.message += '\n\n' + message;
  t.updatedAt = new Date();
  await t.save();
  res.json({ success:true });
});

/* ───────────────────────── Unread counts ───────────────────── */
exports.unreadCounts = asyncHdl(async (req,res)=>{
  const me = req.user._id;
  const rooms = await ChatRoom.find({ members: me }).select('_id').lean();
  const roomIds = rooms.map(r => r._id);

  const agg = await ChatMsg.aggregate([
    { $match: { roomId: { $in: roomIds }, seenBy: { $ne: me } } },
    { $group: { _id: '$roomId', count: { $sum: 1 } } }
  ]);
  const table = Object.fromEntries(agg.map(a => [ a._id, a.count ]));
  res.json({ success:true, data: table });
});

/* ───────────────────────── File upload (actor) ───────────────────── */
const uploadDir = path.join(__dirname, '../uploads/chat');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_,_f,cb)=> cb(null, uploadDir),
  filename   : (_req, file, cb)=>{
    const ext = mime.extension(file.mimetype) || 'bin';
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + '.' + ext);
  }
});
const upload = multer({ storage, limits:{ fileSize: 10 * 1024 * 1024 } }).array('files', 5);

exports.uploadFiles = [
  upload,
  asyncHdl(async (req,res)=>{
    const { roomId } = req.params;
    const me = req.user._id;

    const room = await ChatRoom.findById(roomId);
    if (!room || !room.members.some(id=> String(id) === String(me)))
      return res.status(404).json({ message:'Room not found / access' });

    const filesMeta = (req.files || []).map(f => ({
      url : `/uploads/chat/${path.basename(f.path)}`,
      mime: f.mimetype,
      size: f.size
    }));

    await Upload.insertMany(filesMeta.map(m => ({ actorId: me, roomId, ...m })));

    const msg = await ChatMsg.create({
      roomId, senderId: me, text:'', files: filesMeta.map(f => f.url), seenBy: [me]
    });

    req.app.locals.io.to(String(roomId)).emit('chat:new', {
      roomId,
      msg:{ _id: msg._id, senderId: me, files: filesMeta.map(f=>f.url), createdAt: msg.createdAt }
    });

    res.status(201).json({ success:true, data:{ messageId: msg._id, files: filesMeta } });
  })
];

/* ───────────────────────── Block / Unblock ───────────────────── */
exports.blockActor = asyncHdl(async (req,res)=>{
  const { peerId } = req.body;
  const me = req.user._id;
  if (!isId(peerId) || String(peerId) === String(me))
    return res.status(400).json({ message:'Bad peerId' });

  await Block.updateOne(
    { blockerId: me, blockedId: peerId },
    { $set: { blockerId: me, blockedId: peerId } },
    { upsert: true }
  );
  res.json({ success:true });
});

exports.unblockActor = asyncHdl(async (req,res)=>{
  const { peerId } = req.params;
  const me = req.user._id;
  await Block.deleteOne({ blockerId: me, blockedId: peerId });
  res.json({ success:true });
});

/* ───────────────────────── Chat block guard (REST) ───────────────────── */
exports.chatBlockGuard = async (req,res,next)=>{
  const { roomId } = req.params;
  const me = req.user._id;

  const room = await ChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Room not found' });

  const blocks = await Block.find({ blockerId:{ $in: room.members }, blockedId: me }).countDocuments();
  if (blocks) return res.status(403).json({ message:'Blocked by user' });
  next();
};

/* ───────────────────────── Bookmarks ───────────────────── */
exports.bookmarkEvent = asyncHdl(async (req,res)=>{
  const { id: eventId } = req.params;
  await Bookmark.updateOne(
    { actorId: req.user._id, eventId },
    { $set: { actorId: req.user._id, eventId } },
    { upsert: true }
  );
  res.json({ success:true });
});

exports.unbookmarkEvent = asyncHdl(async (req,res)=>{
  await Bookmark.deleteOne({ actorId: req.user._id, eventId: req.params.id });
  res.json({ success:true });
});

exports.listBookmarks = asyncHdl(async (req,res)=>{
  const rows = await Bookmark.find({ actorId: req.user._id })
    .populate('eventId','title startDate endDate banner').lean();
  res.json({ success:true, data: rows.map(r => r.eventId) });
});

/* ───────────────────────── Follow ───────────────────── */
exports.followActor = asyncHdl(async (req,res)=>{
  const { peerId } = req.body;
  if (!isId(peerId) || String(peerId) === String(req.user._id))
    return res.status(400).json({ message:'Bad peerId' });

  await Follow.updateOne(
    { followerId: req.user._id, followeeId: peerId },
    { $set: { followerId: req.user._id, followeeId: peerId } },
    { upsert: true }
  );

  await Notif.create({
    actorId: peerId, title: 'New follower', body: `${req.user.role} followed you`, link: ''
  });

  res.json({ success:true });
});

exports.unfollowActor = asyncHdl(async (req,res)=>{
  const { peerId } = req.params;
  await Follow.deleteOne({ followerId: req.user._id, followeeId: peerId });
  res.json({ success:true });
});

exports.myFollowers = asyncHdl(async (req,res)=>{
  const rows = await Follow.find({ followeeId: req.user._id })
    .populate('followerId','personal.fullName identity.exhibitorName').lean();
  res.json({ success:true, count: rows.length, data: rows.map(r => r.followerId) });
});

/* ───────────────────────── Notifications ───────────────────── */
exports.listNotifs = asyncHdl(async (req,res)=>{
  const rows = await Notif.find({ actorId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success:true, data: rows });
});

exports.markNotifRead = asyncHdl(async (req,res)=>{
  await Notif.updateOne({ _id: req.params.id, actorId: req.user._id }, { read: true });
  res.json({ success:true });
});

/* ───────────────────────── Reactions & Delete message ───────────────────── */
exports.reactMessage = asyncHdl(async (req,res)=>{
  const { msgId } = req.params;
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ message:'emoji required' });

  await Reaction.updateOne(
    { msgId, userId: req.user._id },
    { $set: { msgId, userId: req.user._id, emoji } },
    { upsert: true }
  );
  req.app.locals.io.to(req.params.roomId || '').emit('chat:reaction', { msgId, userId: req.user._id, emoji });
  res.json({ success:true });
});

exports.unReactMessage = asyncHdl(async (req,res)=>{
  const { msgId, emoji } = req.params;
  await Reaction.deleteOne({ msgId, userId: req.user._id, emoji });
  req.app.locals.io.to(req.params.roomId || '').emit('chat:unreaction', { msgId, userId: req.user._id, emoji });
  res.json({ success:true });
});

exports.deleteMessageGlobal = asyncHdl(async (req,res)=>{
  const { msgId } = req.params;
  const msg = await ChatMsg.findById(msgId);
  if (!msg) return res.status(404).json({ message:'Not found' });

  const twoMinAgo = Date.now() - 120_000;
  if (!msg.senderId.equals(req.user._id) || msg.createdAt < twoMinAgo)
    return res.status(403).json({ message:'Too late to delete' });

  await ChatMsg.deleteOne({ _id: msgId });
  req.app.locals.io.to(String(msg.roomId)).emit('chat:deleted', { msgId });
  res.json({ success:true });
});

/* ───────────────────────── Search chat ───────────────────── */
exports.searchChat = asyncHdl(async (req,res)=>{
  const { q = '', limit = 50 } = req.query;
  if (q.trim().length < 2) return res.status(400).json({ message:'Query too short' });

  const me = req.user._id;
  const rooms = await ChatRoom.find({ members: me }).select('_id').lean();

  let rows = await ChatMsg.find(
    { roomId: { $in: rooms.map(r => r._id) }, $text: { $search: q } },
    { score: { $meta: 'textScore' } }
  ).sort({ score: { $meta: 'textScore' } }).limit(Number(limit)).lean();

  if (!rows.length) {
    const rx = new RegExp(escapeRx(q), 'i');
    rows = await ChatMsg.find({ roomId: { $in: rooms.map(r => r._id) }, text: rx })
      .sort({ createdAt: -1 }).limit(Number(limit)).lean();
  }

  res.json({ success:true, count: rows.length, data: rows });
});

/* ───────────────────────── Preferences ───────────────────── */
exports.getPrefs = asyncHdl(async (req, res) => {
  const actorId = req.user._id;
  const [p, roles] = await Promise.all([
    Pref.findOne({ actorId }).lean(),
    getRolesFor(actorId)
  ]);
  res.json({ success: true, data: p || {}, roles });
});


exports.updatePrefs = asyncHdl(async (req, res) => {
  const allowed = ['language', 'darkMode', 'muteDMs'];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

  const actorId = req.user._id;
  const pref = await Pref.findOneAndUpdate(
    { actorId },
    { ...patch, actorId, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  const roles = await getRolesFor(actorId);
  res.json({ success: true, data: pref, roles });
});


/* ───────────────────────── Profile update ───────────────────── */
const ROLE_MAP = { attendee, exhibitor: Exhibitor, speaker: Speaker };

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === '_proto_' || k === 'constructor' || k === 'prototype') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      flatten(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

const BLOCK_PREFIXES = [
  '_id','id_event','pwd','verified','verifyToken','verifyExpires','createdAt','matchingMeta.matchScore'
];
async function getRolesFor(actorId) {
  const [bo, co, em, ex, inv, st] = await Promise.all([
    RoleBusinessOwner.exists({ actor: actorId }),
    RoleConsultant.exists({ actor: actorId }),
    RoleEmployee.exists({ actor: actorId }),
    RoleExpert.exists({ actor: actorId }),
    RoleInvestor.exists({ actor: actorId }),
    RoleStudent.exists({ actor: actorId }),
  ]);
  const roles = [];
  if (bo) roles.push('businessOwner');
  if (co) roles.push('consultant');
  if (em) roles.push('employee');
  if (ex) roles.push('expert');
  if (inv) roles.push('investor');
  if (st) roles.push('student');
  return roles;
}
// === APPEND (helpers/consts) =========================================
const IMMUTABLE_PREFIXES = [
  'personal.country',
  'identity.country',
  'personal.firstEmail',
  'identity.firstEmail',
  'personal.email',       // nested email now immutable (use root email)
  'identity.email'        // nested email now immutable (use root email)
];

// simple guard

const rx = (q) => new RegExp(esc(q), 'i');
function mapRow(x, entityType) {
  const name = x.name || x.displayName || [x.firstName, x.lastName].filter(Boolean).join(' ') || 'Unnamed';
  const title = x.title || x.position || x.role || '';
  const avatarUpload =
    x.avatarUpload || x.photoUpload || x.logoUpload ||
    (Array.isArray(x.images) && x.images[0]) || null;
  return {
    entityType,
    entityId: String(x._id),
    name,
    title,
    avatarUpload,
  };
}

exports.updateActorProfile = asyncHdl(async (req, res) => {
  const { role, id, data } = req.body || {};
  if (!role || !id || !isObj(data))
    return res.status(400).json({ message: 'Missing role, id or data' });
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: 'Bad id' });

  const R = String(role || '').toLowerCase();
  const Model = ROLE_MAP[role];
  if (!Model) return res.status(400).json({ message: 'Unsupported role' });

  // 1) Load existing doc once (we need current email & firstEmail)
  const existing = await Model.findById(id)
    .select('email personal.firstEmail identity.firstEmail')
    .lean()
    .exec();
  if (!existing) return res.status(404).json({ message: 'Actor not found' });

  // 2) Build flat set from incoming data, but strip immutable keys
  const flat = flatten(data);
  for (const key of Object.keys(flat)) {
    // block your global blocklist first (if you already had it)
    if (BLOCK_PREFIXES?.some?.(p => key === p || key.startsWith(p + '.'))) {
      delete flat[key];
      continue;
    }
    // and block new immutable fields we declared
    if (IMMUTABLE_PREFIXES.some(p => key === p || key.startsWith(p + '.'))) {
      delete flat[key];
    }
  }

  // 3) Root email change handling
  //    - Only root `email` is allowed to change.
  //    - If `firstEmail` is not set yet, set it ONCE to the *previous* email.
  //    - Ignore nested personal/identity emails (were removed above).
  const wantsEmailChange = Object.prototype.hasOwnProperty.call(data, 'email');
  if (wantsEmailChange) {
    const newEmail = (data.email || '').trim();
    if (newEmail) {
      // always set root email
      flat['email'] = newEmail;

      // if firstEmail is missing, set it once to previous email
      const hasFirst =
        (existing.personal && existing.personal.firstEmail) ||
        (existing.identity && existing.identity.firstEmail);

      if (!hasFirst) {
        const prevEmail = (existing.email || '').trim();
        if (prevEmail) {
          if (R === 'exhibitor') {
            flat['identity.firstEmail'] = prevEmail;
          } else {
            // attendee & speaker default
            flat['personal.firstEmail'] = prevEmail;
          }
        }
      }
    } else {
      // empty email is not acceptable; do not allow clearing root email
      delete flat['email'];
    }
  }

  // 4) Nothing left?
  if (!Object.keys(flat).length) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  try {
    // 5) Perform the update
    const updated = await Model.findByIdAndUpdate(
      id,
      { $set: flat, $currentDate: { updatedAt: true } },
      { new: true, runValidators: true, context: 'query' }
    ).lean();

    if (!updated) return res.status(404).json({ message: 'Actor not found' });

    // 6) Dual-write BusinessProfile.offering/seeking (unchanged logic, just wrapped)
    try {
      let offeringStr = null;
      let seekingStr  = null;

      if (R === 'attendee'  && isObj(data.matchingIntent)) {
        offeringStr = data.matchingIntent.offering;
        seekingStr  = data.matchingIntent.needs;
      }
      if (R === 'exhibitor' && isObj(data.commercial)) {
        offeringStr = data.commercial.offering;
        seekingStr  = data.commercial.lookingFor;
      }
      if (R === 'speaker'   && isObj(data.b2bIntent)) {
        offeringStr = data.b2bIntent.offering;
        seekingStr  = data.b2bIntent.lookingFor;
      }

      const bpPatch = {};
      if (typeof offeringStr === 'string') bpPatch.offering = splitList(offeringStr);
      if (typeof seekingStr  === 'string') bpPatch.seeking  = splitList(seekingStr);

      if (Object.keys(bpPatch).length) {
        await BusinessProfileData.findOneAndUpdate(
          { 'owner.actor': id },
          { $set: bpPatch },
          { new: true, upsert: true }
        ).lean().exec();
      }
    } catch { /* soft-fail */ }

    const currentRoles = await getRolesFor(id);
    return res.json({ success: true, role, data: updated, currentRoles });
  } catch (err) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
      return res.status(409).json({ message: `${field} must be unique` });
    }
    if (err?.name === 'ValidationError') {
      const first = Object.values(err.errors || {})[0];
      return res.status(400).json({ message: first?.message || 'Validation error' });
    }
    if (err?.name === 'CastError') {
      return res.status(400).json({ message: `Bad ${err.path}` });
    }
    return res.status(500).json({ message: 'Update failed' });
  }
});

function buildBpSummary(rows = []) {
  const list = (rows || []).map(r => ({
    id: String(r._id),
    slug: r.slug || null,
    name: r.name || null,
    published: !!r.published,
    url: r.slug ? `/bp/${r.slug}` : null,
  }));

  const primary = list[0] || null;

  return {
    exists: list.length > 0,
    count: list.length,
    primary, // { id, slug, name, published, url } | null
    list,    // compact list for future use
  };
}
exports.getActorProfileById = asyncHdl(async (req, res) => {
  const { id } = req.body || {};
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: 'Bad id' });

  // try each role model
  const tries = [
    { role: 'attendee',  Model: attendee },
    { role: 'exhibitor', Model: Exhibitor },
    { role: 'speaker',   Model: Speaker },
  ];

  let found = null, legacyRole = null;
  for (const t of tries) {
    const doc = await t.Model.findById(id).lean().exec();
    if (doc) { found = doc; legacyRole = t.role; break; }
  }
  if (!found) return res.status(404).json({ message: 'Actor not found' });

  // hard-privacy scrub
  delete found.pwd;

  // multi-roles
  const roles = await getRolesFor(id);

  // BusinessProfile summary (primary + list)
  const bpRows = await BusinessProfileData.find({ 'owner.actor': id })
    .select('_id slug published name')
    .lean().exec();
  const bp = buildBpSummary(bpRows);

  return res.json({
    success: true,
    role: legacyRole,   // legacy single role
    roles,              // multi-role flags
    data: {...found,bp, legacyRole},        // original actor document (scrubbed)
  });
});

exports.searchPeople = async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    if (!q) return res.json({ ok: true, data: [] });
    const pattern = rx(q);

    const nameOrMeta = {
      $or: [
        { name: pattern }, { displayName: pattern },
        { firstName: pattern }, { lastName: pattern },
        { email: pattern }, { phone: pattern }, { title: pattern }, { position: pattern }, { role: pattern },
      ],
    };

    const [exs, sps, ats] = await Promise.all([
      Exhibitor.find(nameOrMeta).limit(limit).lean(),
      Speaker.find(nameOrMeta).limit(limit).lean(),
      Attendee.find(nameOrMeta).limit(limit).lean(),
    ]);

    const merged = [
      ...exs.map(x => mapRow(x, 'exhibitor')),
      ...sps.map(x => mapRow(x, 'speaker')),
      ...ats.map(x => mapRow(x, 'attendee')),
    ].slice(0, limit);

    res.json({ ok: true, data: merged });
  } catch (e) { next(e); }
};
/* =========================================================================================
   ───────────────────────────────  NEW ACTOR SOCKET ONLY  ────────────────────────────────
   This replaces the old initActorChatSockets. Do NOT keep the old one.
   server.js must have socket auth middleware that sets socket.user.ActorId (already done).
========================================================================================= */

// ───────────────────────── helpers kept as-is ─────────────────────────
async function isMember(roomId, actorId) {
  if (!isId(roomId) || !isId(actorId)) return false;
  const r = await ChatRoom.findById(roomId).select('members').lean();
  return !!(r && r.members && r.members.some(m => String(m) === String(actorId)));
}
async function hasActiveSanction(actorId, roomId) {
  const now = new Date();
  const rows = await Sanction.find({
    actorId,
    $and: [
      { $or: [{ scopeGlobal: true }, { roomId }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }
    ]
  }).select('type').lean();
  return {
    banned: rows.some(s => s.type === 'ban'),
    muted : rows.some(s => s.type === 'mute'),
  };
}
async function blockedByPeer(actorId, roomId) {
  const r = await ChatRoom.findById(roomId).select('members').lean();
  if (!r) return true;
  const cnt = await Block.countDocuments({ blockerId: { $in: r.members }, blockedId: actorId });
  return cnt > 0;
}

// ───────────────────────── sockets (unchanged flow) ─────────────────────────
function initActorSockets(app) {
  const io = app.locals.io;
  if (!io) return;

  io.on('connection', (socket) => {
    const me = socket.user?.ActorId ? String(socket.user.ActorId) : null;
    console.log('[actor-socket] connected', socket.id, 'as', me || 'guest');

    socket.on('joinRoom', async (roomId, ack) => {
      try {
        if (!isId(roomId)) return ack && ack({ ok:false, error:'bad_roomId' });
        if (!me)          return ack && ack({ ok:false, error:'unauthorized' });
        const allowed = await isMember(roomId, me);
        if (!allowed)     return ack && ack({ ok:false, error:'not_member' });
        socket.join(String(roomId));
        console.log('[actor-socket] join', roomId, 'by', me);
        ack && ack({ ok:true });
      } catch (e) { ack && ack({ ok:false, error:'server' }); }
    });

    socket.on('leaveRoom', (roomId, ack) => {
      try { if (roomId) socket.leave(String(roomId)); ack && ack({ ok:true }); }
      catch { ack && ack({ ok:false, error:'server' }); }
    });

    socket.on('chat:typing', ({ roomId, isTyping }, _ack) => {
      if (!isId(roomId) || !me) return;
      socket.to(String(roomId)).emit('chat:typing', { roomId, isTyping: !!isTyping, user: me });
    });

    socket.on('chat:seen', async ({ roomId, msgIds = [] }, ack) => {
      try {
        if (!isId(roomId) || !me) return ack && ack({ ok:false, error:'bad_input' });
        await ChatMsg.updateMany(
          { _id: { $in: msgIds.filter(isId) }, roomId },
          { $addToSet: { seenBy: me } }
        );
        io.to(String(roomId)).emit('chat:seen', { roomId, msgIds, userId: me });
        ack && ack({ ok:true });
      } catch { ack && ack({ ok:false, error:'server' }); }
    });

    socket.on('actor:send', async ({ roomId, text = '', files = [] }, ack) => {
      try {
        if (!isId(roomId) || !me) return ack && ack({ ok:false, error:'bad_input' });
        if (!text.trim() && !Array.isArray(files)) return ack && ack({ ok:false, error:'empty' });

        if (!(await isMember(roomId, me))) return ack && ack({ ok:false, error:'not_member' });
        const { banned, muted } = await hasActiveSanction(me, roomId);
        if (banned) return ack && ack({ ok:false, error:'banned' });
        if (muted)  return ack && ack({ ok:false, error:'muted' });
        if (await blockedByPeer(me, roomId)) return ack && ack({ ok:false, error:'blocked' });

        const msg = await ChatMsg.create({
          roomId,
          senderId: me,
          text: text.trim(),
          files: Array.isArray(files) ? files.filter(Boolean) : [],
          seenBy: [me]
        });

        io.to(String(roomId)).emit('chat:new', {
          roomId,
          msg: { _id: msg._id, senderId: msg.senderId, text: msg.text, files: msg.files, createdAt: msg.createdAt }
        });
        ack && ack({ ok:true, id: msg._id });
      } catch (e) {
        console.error('[actor-socket] send error', e.message);
        ack && ack({ ok:false, error:'server' });
      }
    });

    socket.on('disconnect', () => {
      console.log('[actor-socket] disconnected', socket.id);
    });
  });
}
module.exports.initActorSockets = initActorSockets;

// ───────────────────────── role registry (NEW) ─────────────────────────
// Make sure these models are required at top of the file, e.g.:
// const BusinessOwner = require('../models/BusinessOwner'); ... etc.
const ROLE_REG = {
  attendee: {
    Model: attendee,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['businessProfile.primaryIndustry'],
    offering: ['businessProfile.offering'],          // optional in your schema
    looking:  ['matchingIntent.objectives'],
    regions:  [],                                    // none by default
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  exhibitor: {
    Model: Exhibitor,
    name: ['identity.contactName','identity.exhibitorName'],
    email: ['identity.email'],
    country: ['identity.country'],
    avatar: ['identity.logo'],
    langs: ['identity.preferredLanguages'],
    industry: ['business.industry'],
    offering: ['commercial.offering'],
    looking:  ['commercial.lookingFor'],
    regions:  ['commercial.regionInterest'],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  speaker: {
    Model: Speaker,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages','talk.language'],
    industry: ['b2bIntent.businessSector'],
    offering: ['b2bIntent.offering'],
    looking:  ['b2bIntent.lookingFor'],
    regions:  ['b2bIntent.regionsInterest'],
    event:    ['id_event'],
    adminVerified: [], // speakers not filtered by adminVerified in your original code
  },

  // New roles — mapped like attendee (personal.*). Adjust fields if your schemas differ.
  businessOwner: {
    Model: RoleBusinessOwner,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['business.industry','businessProfile.primaryIndustry'],
    offering: ['business.offering','b2bIntent.offering'],
    looking:  ['business.lookingFor','b2bIntent.lookingFor'],
    regions:  ['business.regionInterest','b2bIntent.regionsInterest'],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  consultant: {
    Model: RoleConsultant,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['businessProfile.primaryIndustry','expertise.industry'],
    offering: ['services.offering','b2bIntent.offering'],
    looking:  ['services.lookingFor','b2bIntent.lookingFor'],
    regions:  ['services.regionInterest','b2bIntent.regionsInterest'],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  employee: {
    Model: RoleEmployee,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['organization.industry','businessProfile.primaryIndustry'],
    offering: [],
    looking:  [],
    regions:  [],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  expert: {
    Model: RoleExpert,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['expertise.industry','b2bIntent.businessSector'],
    offering: ['b2bIntent.offering'],
    looking:  ['b2bIntent.lookingFor'],
    regions:  ['b2bIntent.regionsInterest'],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  investor: {
    Model: RoleInvestor,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['focus.industry'],
    offering: ['capital.offering'],
    looking:  ['capital.lookingFor'],
    regions:  ['focus.regions'],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  },
  student: {
    Model: RoleStudent,
    name: ['personal.fullName'],
    email: ['personal.email'],
    country: ['personal.country'],
    avatar: ['personal.profilePic'],
    langs: ['personal.preferredLanguages'],
    industry: ['study.industry','businessProfile.primaryIndustry'],
    offering: [],
    looking:  [],
    regions:  [],
    event:    ['id_event'],
    adminVerified: ['adminVerified'],
  }
};

// small getters
const norm = (v='') => String(v).toLowerCase().trim();
const arrify = (x) => Array.isArray(x) ? x.filter(Boolean) : (x ? [x] : []);
const uniq = (a) => Array.from(new Set((a||[]).filter(Boolean)));
const esc = (s='') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function getp(obj, path){
  return path.split('.').reduce((o,k)=> (o && o[k] != null ? o[k] : undefined), obj);
}
function pickFirst(doc, paths){ for (const p of paths||[]) { const v = getp(doc,p); if (v!=null && v!=='') return v; } return ''; }

// language normalizer
const LANG_ALIASES = {
  en:'english', eng:'english', fr:'french', ar:'arabic', es:'spanish', de:'german', it:'italian',
  english:'english', french:'french', arabic:'arabic', spanish:'spanish', german:'german', italian:'italian'
};
function words(x){
  return uniq(arrify(x)
    .flatMap(s => String(s).split(/[,;/|]+|\s+/g))
    .map(norm)
    .filter(t => t && t.length >= 2 && t !== 'and' && t !== 'or'));
}
function langTokens(x){
  const base = words(x);
  return uniq(base.map(t => LANG_ALIASES[t] || t));
}

// build vectors/profile from a doc+role
function profileFrom(doc, roleKey) {
  const r = ROLE_REG[roleKey];
  const id = doc._id;
  const name = pickFirst(doc, r.name) || '';
  const email = pickFirst(doc, r.email) || '';
  const country = pickFirst(doc, r.country) || '';
  const avatar = pickFirst(doc, r.avatar) || null;
  return { id, role: roleKey, name, email, country, avatar };
}
function vectorsFor(doc, roleKey){
  const r = ROLE_REG[roleKey];
  return {
    looking   : words(r.looking.flatMap(p => arrify(getp(doc,p)))),
    offering  : words(r.offering.flatMap(p => arrify(getp(doc,p)))),
    regions   : words(r.regions.flatMap(p => arrify(getp(doc,p)))).map(norm),
    industries: words(r.industry.flatMap(p => arrify(getp(doc,p)))).map(norm),
    languages : uniq(langTokens(r.langs.flatMap(p => arrify(getp(doc,p)))))
  };
}
function eventOf(doc, roleKey){
  const r = ROLE_REG[roleKey];
  return r.event.length ? pickFirst(doc, r.event) : null;
}

// ───────────────────────── Suggested actors (NEW roles supported) ─────────────────────────
exports.getSuggestedActors = asyncHdl(async (req, res) => {
  const meId = (req.body?.meId || req.query?.meId || '').toString().trim();
  if (!mongoose.isValidObjectId(meId)) {
    return res.status(400).json({ message: 'Bad meId' });
  }

  const limit  = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
  const search = (req.params?.search ?? req.query?.search ?? req.query?.q ?? '').toString().trim();
  const rxName = search ? new RegExp(esc(search), 'i') : null;

  // find me across all roles
  let myRole = null, meDoc = null;
  for (const [roleKey, cfg] of Object.entries(ROLE_REG)) {
    // project only fields we need to score + event
    const proj = {};
    [...cfg.name, ...cfg.email, ...cfg.country, ...cfg.avatar, ...cfg.langs, ...cfg.industry, ...cfg.offering, ...cfg.looking, ...cfg.regions, ...cfg.event].forEach(p => p && (proj[p] = 1));
    const hit = await cfg.Model.findById(meId, proj).lean();
    if (hit) { myRole = roleKey; meDoc = hit; break; }
  }
  if (!meDoc) return res.status(404).json({ message: 'Actor not found' });

  const meV = vectorsFor(meDoc, myRole);
  const meEvent = eventOf(meDoc, myRole) ? String(eventOf(meDoc, myRole)) : null;

  // get DM peers to separate existing chats
  const dmRooms = await ChatRoom.find({ isGroup:false, members: meId }).select('members').lean();
  const chattedIds = new Set(
    dmRooms
      .map(r => (r.members || []).map(id => String(id)).find(id => id !== String(meId)))
      .filter(Boolean)
  );

  // base query generator (filters by same event if present, and (optionally) adminVerified when field exists)
  const baseQ = (roleKey) => {
    const cfg = ROLE_REG[roleKey];
    const q = { _id: { $ne: meId } };
    if (meEvent) q.id_event = meEvent;
    // only filter by adminVerified if the role actually has that field
    if (cfg.adminVerified?.length) {
      q.$or = [{ adminVerified: 'yes' }, { adminVerified: true }];
    }
    return q;
  };

  // build per-role projection once
  const projFor = (cfg) => {
    const proj = {};
    [...cfg.name, ...cfg.email, ...cfg.country, ...cfg.avatar, ...cfg.langs, ...cfg.industry, ...cfg.offering, ...cfg.looking, ...cfg.regions, ...cfg.event, ...cfg.adminVerified].forEach(p => p && (proj[p] = 1));
    proj.createdAt = 1;
    return proj;
  };

  // SEARCH MODE (name-only)
  if (rxName) {
    const packs = [];
    for (const [roleKey, cfg] of Object.entries(ROLE_REG)) {
      const q = baseQ(roleKey);
      // build name ORs
      q.$and = [ { $or: cfg.name.map(n => ({ [n]: rxName })) } ];
      const rows = await cfg.Model.find(q, projFor(cfg)).lean();
      for (const d of rows) {
        packs.push({ profile: profileFrom(d, roleKey), hasChat: chattedIds.has(String(d._id)), score: 0 });
      }
    }
    packs.sort((a,b) => a.profile.name.localeCompare(b.profile.name));
    const suggestions = packs.filter(p => !p.hasChat).slice(0, limit);
    const chats       = packs.filter(p =>  p.hasChat);
    return res.json({
      success: true,
      me: { id: meId, role: myRole, id_event: meEvent },
      criteria: { limit, search },
      count: { suggestions: suggestions.length, chats: chats.length, total: packs.length },
      suggestions,
      chats
    });
  }

  // FULL SCORING MODE
  const all = [];
  for (const [roleKey, cfg] of Object.entries(ROLE_REG)) {
    const rows = await cfg.Model.find(baseQ(roleKey), projFor(cfg)).lean();
    for (const d of rows) {
      const v = vectorsFor(d, roleKey);
      let s = 0;
      // scores
      const lxo = meV.looking.filter(t => v.offering.includes(t)).length; s += lxo * 5;
      const oxl = meV.offering.filter(t => v.looking.includes(t)).length; s += oxl * 3;
      const reg = meV.regions.filter(t => v.regions.includes(t)).length;  s += reg * 2;
      const ind = meV.industries.filter(t => v.industries.includes(t)).length; s += ind * 3;
      const lng = meV.languages.filter(t => v.languages.includes(t)).length; s += lng * 1.5;

      all.push({
        profile: profileFrom(d, roleKey),
        score: s,
        hasChat: chattedIds.has(String(d._id))
      });
    }
  }

  all.sort((a,b) => (b.score - a.score) || (a.profile.name.localeCompare(b.profile.name)));
  const suggestions = all.filter(p => !p.hasChat).slice(0, limit);
  const chats       = all.filter(p =>  p.hasChat);

  return res.json({
    success: true,
    me: { id: meId, role: myRole, id_event: meEvent },
    criteria: { limit, search: null },
    count: { suggestions: suggestions.length, chats: chats.length, total: all.length },
    suggestions,
    chats
  });
});

// ───────────────────────── Upload profile/logo (NEW roles supported) ─────────────────────────
exports.uploadProfilePic = [
  imageUploader.single('file'),
  handleAdvancedMulterError,
  asyncHdl(async (req, res) => {
    const { id } = req.body || {};
    if (!mongoose.isValidObjectId(id)) {
      if (req.file?.path) cleanupFile(req.file.path);
      return res.status(400).json({ message: 'Bad id' });
    }
    if (!req.file?.path) return res.status(400).json({ message: 'file is required' });

    const uploadsRoot = path.resolve(__dirname, '../uploads');
    const rel = path.relative(uploadsRoot, req.file.path).replace(/\\/g, '/');
    const url = `/uploads/${rel}`;

    // role-> field mapping: exhibitor uses identity.logo, everyone else personal.profilePic
    const PATCHES = [
      { role: 'exhibitor', Model: ROLE_REG.exhibitor.Model, path: 'identity.logo' },
    ];

    // Build a dynamic list including all remaining roles with personal.profilePic
    for (const [roleKey, cfg] of Object.entries(ROLE_REG)) {
      if (roleKey === 'exhibitor') continue;
      PATCHES.push({ role: roleKey, Model: cfg.Model, path: 'personal.profilePic' });
    }

    let found = null;
    for (const p of PATCHES) {
      const setObj = { $set: { [p.path]: url }, $currentDate: { updatedAt: true } };
      const doc = await p.Model.findOneAndUpdate(
        { _id: id },
        setObj,
        { new: true, projection: { pwd: 0 } }
      ).lean();
      if (doc) { found = { role: p.role, doc }; break; }
    }

    if (!found) {
      cleanupFile(req.file.path);
      return res.status(404).json({ message: 'Actor not found' });
    }
    return res.status(201).json({ success: true, role: found.role, url });
  })
];

module.exports.initActorSockets = initActorSockets;




const ROLE_MODEL = { attendee, exhibitor: Exhibitor, speaker: Speaker };

// ---------- tiny utils ----------

function toStr(x){ return (x==null ? '' : String(x)).trim(); }
function tok(s){
  return uniq(toStr(s).toLowerCase()
    .replace(/[/,_\-+&]|and|or/gi,' ')
    .split(/[^a-z0-9]+/i)
    .filter(t => t && t.length >= 2)
  );
}
function jaccard(a, b){
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter || 1;
  return inter / union;
}
function arrify1(x){
  if (!x) return [];
  if (Array.isArray(x)) return x.filter(Boolean).map(String);
  return [String(x)].filter(Boolean);
}

function lowerSet(arr){ return new Set(arrify1(arr).map((s)=>String(s).toLowerCase().trim()).filter(Boolean)); }
function overlapCount(a,b){ const A=lowerSet(a), B=lowerSet(b); let n=0; for(const x of A) if(B.has(x)) n++; return n; }

// ---------- normalize actors to a common profile ----------
function normActor(doc, role){
  if (!doc) return null;
  const base = {
    id: String(doc._id),
    role,
    eventId: doc.id_event,
    name: '',
    email: '',
    country: '',
    avatar: ''
  };

  if (role === 'exhibitor'){
    base.name    = toStr(doc.identity?.exhibitorName || doc.identity?.orgName);
    base.email   = toStr(doc.identity?.email);
    base.country = toStr(doc.identity?.country);
    base.avatar  = toStr(doc.identity?.logo);

    return {
      ...base,
      businessModel : toStr(doc.business?.businessModel),
      industry      : toStr(doc.business?.industry),
      sector        : toStr(doc.business?.subIndustry),
      languages     : arrify1(doc.commercial?.preferredLanguages || doc.commercial?.language),
      region        : arrify1(doc.commercial?.regionInterest),
      offering      : toStr(doc.commercial?.offering),
      lookingFor    : toStr(doc.commercial?.lookingFor),
      openMeetings  : !!doc.commercial?.availableMeetings
    };
  }

  if (role === 'speaker'){
    base.name    = toStr(doc.personal?.fullName);
    base.email   = toStr(doc.personal?.email);
    base.country = toStr(doc.personal?.country);
    base.avatar  = toStr(doc.personal?.profilePic);

    return {
      ...base,
      businessModel : toStr(doc.b2bIntent?.businessModel),
      industry      : toStr(doc.talk?.topicCategory),
      sector        : toStr(doc.organization?.businessRole || doc.talk?.targetAudience),
      languages     : arrify1(doc.b2bIntent?.preferredLanguages || doc.talk?.language),
      region        : arrify1(doc.b2bIntent?.regionInterest),
      offering      : toStr(doc.b2bIntent?.offering),
      lookingFor    : toStr(doc.b2bIntent?.lookingFor),
      openMeetings  : !!doc.b2bIntent?.openMeetings
    };
  }

  // attendee
  base.name    = toStr(doc.personal?.fullName);
  base.email   = toStr(doc.personal?.email);
  base.country = toStr(doc.personal?.country);
  base.avatar  = toStr(doc.personal?.profilePic);

  // attendees often put “objectives” for lookingFor
  const lookingFor = (Array.isArray(doc.matchingIntent?.objectives) && doc.matchingIntent.objectives.join(', '))
                  || toStr(doc.matchingIntent?.needs);

  return {
    ...base,
    businessModel : toStr(doc.businessProfile?.businessModel),
    industry      : toStr(doc.businessProfile?.primaryIndustry),
    sector        : toStr(doc.businessProfile?.subIndustry),
    languages     : arrify1(doc.matchingAids?.language),
    region        : arrify1(doc.matchingIntent?.regionInterest),
    offering      : toStr(doc.matchingIntent?.offering),
    lookingFor,
    openMeetings  : !!doc.matchingIntent?.openToMeetings
  };
}

// ---------- scoring ----------
function scorePair(me, other){
  // tokens
  const meLF   = tok(me.lookingFor);
  const meOff  = tok(me.offering);
  const meInd  = tok(`${me.industry} ${me.sector}`);

  const otOff  = tok(other.offering);
  const otLF   = tok(other.lookingFor);
  const otInd  = tok(`${other.industry} ${other.sector}`);

  // components
  const s_LF_to_OFF  = jaccard(meLF, otOff);       // strong
  const s_REV        = jaccard(meOff, otLF);       // complement
  const s_industry   = jaccard(meInd, otInd);
  const s_lang       = overlapCount(me.languages, other.languages) / Math.max(1, new Set([...me.languages, ...other.languages]).size);
  const s_region     = overlapCount(me.region, other.region) / Math.max(1, new Set([...me.region, ...other.region]).size);
  const s_bm         = (toStr(me.businessModel) && toStr(me.businessModel).toLowerCase() === toStr(other.businessModel).toLowerCase()) ? 1 : 0;

  // weights (sum <= 1.0 then project to 100)
  const w = {
    lf_off : 0.45,
    rev    : 0.15,
    ind    : 0.15,
    lang   : 0.10,
    region : 0.08,
    bm     : 0.07
  };
  let raw = (
    s_LF_to_OFF * w.lf_off +
    s_REV       * w.rev +
    s_industry  * w.ind +
    s_lang      * w.lang +
    s_region    * w.region +
    s_bm        * w.bm
  );

  // small bonus if both have anything in offering/lookingFor to avoid zeroes
  if ((meLF.length && otOff.length) || (meOff.length && otLF.length)) raw += 0.02;

  const score = Math.max(0, Math.min(100, Math.round(raw * 100)));

  // reasons (top contributions)
  const reasons = [];
  if (s_LF_to_OFF > 0) reasons.push(`Your needs match their offering`);
  if (s_REV       > 0) reasons.push(`Your offering matches what they seek`);
  if (s_industry  > 0) reasons.push(`Similar sector/industry`);
  if (s_lang      > 0) reasons.push(`Shared language${s_lang>0.5?'s':''}`);
  if (s_region    > 0) reasons.push(`Region interest overlap`);
  if (s_bm        > 0) reasons.push(`Same business model`);

  return { score, reasons: reasons.slice(0,3) };
}

// ---------- main handler ----------
exports.suggestMeetingMatches = asyncHdl(async (req, res) => {
  const meId   = isId(req.query.meId) ? req.query.meId : req.user?._id;
  const search = toStr(req.query.search || '');
  const want   = Number.isFinite(Number(req.query.limit)) ? Math.max(20, Math.min(100, Number(req.query.limit))) : 20;

  if (!isId(meId)) return res.status(400).json({ message: 'Bad meId' });

  // --- role registry (models + field paths) ---
  // Make sure these Models are required at top of file:
  // BusinessOwner, Consultant, Employee, Expert, Investor, Student
  const ROLES = {
    attendee: {
      Model: attendee,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['businessProfile.primaryIndustry'],
      offering: ['businessProfile.offering'],
      looking:  ['matchingIntent.objectives'],
      regions:  [],
      openFlag: ['matchingIntent.openToMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    exhibitor: {
      Model: Exhibitor,
      name: ['identity.exhibitorName','identity.contactName'], email: ['identity.email'], country: ['identity.country'], avatar: ['identity.logo'],
      langs: ['identity.preferredLanguages'],
      industry: ['business.industry'],
      offering: ['commercial.offering'],
      looking:  ['commercial.lookingFor'],
      regions:  ['commercial.regionInterest'],
      openFlag: ['commercial.availableMeetings'],
      event:    ['id_event'],
      nameForSearch: ['identity.exhibitorName','identity.orgName','identity.contactName'],
      filterAdmin: true,
    },
    speaker: {
      Model: Speaker,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages','talk.language'],
      industry: ['b2bIntent.businessSector'],
      offering: ['b2bIntent.offering'],
      looking:  ['b2bIntent.lookingFor'],
      regions:  ['b2bIntent.regionsInterest'],
      openFlag: ['b2bIntent.openMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: false,
    },
    businessOwner: {
      Model: RoleBusinessOwner,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['business.industry','businessProfile.primaryIndustry'],
      offering: ['business.offering','b2bIntent.offering'],
      looking:  ['business.lookingFor','b2bIntent.lookingFor'],
      regions:  ['business.regionInterest','b2bIntent.regionsInterest'],
      openFlag: ['b2bIntent.openMeetings','matchingIntent.openToMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    consultant: {
      Model: Consultant,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['businessProfile.primaryIndustry','expertise.industry'],
      offering: ['services.offering','b2bIntent.offering'],
      looking:  ['services.lookingFor','b2bIntent.lookingFor'],
      regions:  ['services.regionInterest','b2bIntent.regionsInterest'],
      openFlag: ['b2bIntent.openMeetings','matchingIntent.openToMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    employee: {
      Model: Employee,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['organization.industry','businessProfile.primaryIndustry'],
      offering: [],
      looking:  [],
      regions:  [],
      openFlag: ['matchingIntent.openToMeetings','b2bIntent.openMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    expert: {
      Model: Expert,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['expertise.industry','b2bIntent.businessSector'],
      offering: ['b2bIntent.offering'],
      looking:  ['b2bIntent.lookingFor'],
      regions:  ['b2bIntent.regionsInterest'],
      openFlag: ['b2bIntent.openMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    investor: {
      Model: Investor,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['focus.industry'],
      offering: ['capital.offering'],
      looking:  ['capital.lookingFor'],
      regions:  ['focus.regions'],
      openFlag: ['b2bIntent.openMeetings','matchingIntent.openToMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
    student: {
      Model: Student,
      name: ['personal.fullName'], email: ['personal.email'], country: ['personal.country'], avatar: ['personal.profilePic'],
      langs: ['personal.preferredLanguages'],
      industry: ['study.industry','businessProfile.primaryIndustry'],
      offering: [],
      looking:  [],
      regions:  [],
      openFlag: ['matchingIntent.openToMeetings'],
      event:    ['id_event'],
      nameForSearch: ['personal.fullName'],
      filterAdmin: true,
    },
  };

  // --- utils ---
  const getp = (obj, path) => path.split('.').reduce((o,k)=> (o && o[k] != null ? o[k] : undefined), obj);
  const pickFirst = (doc, paths) => {
    for (const p of paths || []) { const v = getp(doc,p); if (v != null && v !== '') return v; }
    return undefined;
  };
  const arrify = (x) => Array.isArray(x) ? x.filter(Boolean) : (x ? [x] : []);
  const uniq = (a) => Array.from(new Set((a||[]).filter(Boolean)));
  const norm = (v='') => String(v).toLowerCase().trim();
  const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i') : null;
  const langAliases = { en:'english', eng:'english', fr:'french', ar:'arabic', es:'spanish', de:'german', it:'italian',
    english:'english', french:'french', arabic:'arabic', spanish:'spanish', german:'german', italian:'italian' };
  const words = (x) =>
    uniq(arrify(x).flatMap(s => String(s).split(/[,;/|]+|\s+/g))
      .map(norm).filter(t => t && t.length >= 2 && t !== 'and' && t !== 'or'));
  const langTokens = (x) => uniq(words(x).map(t => langAliases[t] || t));

  const normalize = (doc, roleKey) => {
    const cfg = ROLES[roleKey];
    const id = doc._id;
    const name = pickFirst(doc, cfg.name) || '';
    const email = pickFirst(doc, cfg.email) || '';
    const country = pickFirst(doc, cfg.country) || '';
    const avatar = pickFirst(doc, cfg.avatar) || null;
    const eventId = pickFirst(doc, cfg.event) || null;

    const looking   = words(cfg.looking.flatMap(p => arrify(getp(doc,p))));
    const offering  = words(cfg.offering.flatMap(p => arrify(getp(doc,p))));
    const regions   = words(cfg.regions.flatMap(p => arrify(getp(doc,p)))).map(norm);
    const industries= words(cfg.industry.flatMap(p => arrify(getp(doc,p)))).map(norm);
    const languages = uniq(langTokens(cfg.langs.flatMap(p => arrify(getp(doc,p)))));

    // open flag: true if any configured flag is true (or if none configured, treat as false)
    const isOpen = cfg.openFlag.length
      ? cfg.openFlag.some(p => !!getp(doc, p))
      : false;

    return { id, role: roleKey, name, email, country, avatar, eventId,
      vectors: { looking, offering, regions, industries, languages },
      isOpen
    };
  };

  const scorePair = (me, other) => {
    const a = me.vectors, b = other.vectors;
    let s = 0;
    const lxo = a.looking.filter(t => b.offering.includes(t)).length; s += lxo * 5;
    const oxl = a.offering.filter(t => b.looking.includes(t)).length; s += oxl * 3;
    const reg = a.regions.filter(t => b.regions.includes(t)).length;  s += reg * 2;
    const ind = a.industries.filter(t => b.industries.includes(t)).length; s += ind * 3;
    const lng = a.languages.filter(t => b.languages.includes(t)).length; s += lng * 1.5;
    return s;
  };

  // --- find "me" in any role ---
  let meDoc = null, meRole = null;
  for (const [roleKey, cfg] of Object.entries(ROLES)) {
    const proj = {};
    [...cfg.name, ...cfg.email, ...cfg.country, ...cfg.avatar, ...cfg.langs, ...cfg.industry, ...cfg.offering, ...cfg.looking, ...cfg.regions, ...cfg.event, ...cfg.openFlag]
      .forEach(p => p && (proj[p] = 1));
    const d = await cfg.Model.findById(meId).select(proj).lean();
    if (d) { meDoc = d; meRole = roleKey; break; }
  }
  if (!meDoc) return res.status(404).json({ message: 'Actor not found' });

  const me = normalize(meDoc, meRole);
  if (!me?.eventId) return res.status(400).json({ message: 'Actor missing event context' });

  // --- blocks: anyone I blocked or who blocked me ---
  const blocks = await Block.find({ $or: [{ blockerId: meId }, { blockedId: meId }] })
    .select('blockerId blockedId').lean();
  const blockedSet = new Set();
  for (const b of blocks) {
    if (String(b.blockerId) === String(meId)) blockedSet.add(String(b.blockedId));
    if (String(b.blockedId) === String(meId)) blockedSet.add(String(b.blockerId));
  }

  // --- exclude actors with an active/pending meeting with me ---
  const busyStatuses = ['pending', 'accepted', 'reschedule-proposed'];
  const existing = await MeetRequest.find({
    $or: [{ senderId: meId }, { receiverId: meId }],
    status: { $in: busyStatuses }
  }).select('senderId receiverId').lean();
  const withMeeting = new Set(existing.flatMap(r => [ String(r.senderId), String(r.receiverId) ]));
  withMeeting.delete(String(meId));

  // --- build candidate queries per role (same event, open, not blocked/me/withMeeting, admin filter when present) ---
  const baseQueryFor = (roleKey) => {
    const cfg = ROLES[roleKey];
    const q = {
      id_event: me.eventId,
      _id: { $ne: meId, $nin: [...blockedSet, ...withMeeting] },
    };
    // require "open to meetings" true if openFlag exists
    if (cfg.openFlag.length) {
      q.$or = cfg.openFlag.map(p => ({ [p]: true }));
    }
    if (cfg.filterAdmin) {
      q.$and = q.$and || [];
      q.$and.push({ $or: [{ adminVerified: 'yes' }, { adminVerified: true }, { adminVerified: undefined }] });
    }
    if (rx) {
      const ors = cfg.nameForSearch.map(p => ({ [p]: rx }));
      q.$and = q.$and || [];
      q.$and.push({ $or: ors });
    }
    return q;
  };

  const projFor = (cfg) => {
    const proj = {};
    [...cfg.name, ...cfg.email, ...cfg.country, ...cfg.avatar, ...cfg.langs, ...cfg.industry, ...cfg.offering, ...cfg.looking, ...cfg.regions, ...cfg.event, ...cfg.openFlag]
      .forEach(p => p && (proj[p] = 1));
    return proj;
  };

  // --- pull candidates (cap each role to 300 to keep CPU bounded) ---
  const perRoleCandidates = [];
  for (const [roleKey, cfg] of Object.entries(ROLES)) {
    const rows = await cfg.Model.find(baseQueryFor(roleKey)).select(projFor(cfg)).limit(300).lean();
    for (const d of rows) perRoleCandidates.push(normalize(d, roleKey));
  }

  // --- score & rank ---
  const ranked = perRoleCandidates.map(p => ({
    profile: { id: p.id, role: p.role, name: p.name, email: p.email, country: p.country, avatar: p.avatar },
    score: scorePair(me, p),
    reasons: [] // keep structure compatible if your UI expects reasons; fill later if needed
  })).sort((a,b) => b.score - a.score);

  // --- ensure minimum by fallback: same event, ignoring "open" flag ---
  let out = ranked.slice(0, Math.max(20, want));
  if (out.length < Math.max(20, want)) {
    const excludeIds = new Set(out.map(x => String(x.profile.id)).concat([String(meId), ...blockedSet, ...withMeeting]));
    const fallback = [];
    for (const [roleKey, cfg] of Object.entries(ROLES)) {
      const q = { id_event: me.eventId, _id: { $nin: [...excludeIds] } };
      if (cfg.filterAdmin) {
        q.$or = [{ adminVerified: 'yes' }, { adminVerified: true }, { adminVerified: undefined }];
      }
      const rows = await cfg.Model.find(q).select(projFor(cfg)).limit(200).lean();
      for (const d of rows) fallback.push(normalize(d, roleKey));
    }
    const scoredFallback = fallback.map(p => ({
      profile: { id: p.id, role: p.role, name: p.name, email: p.email, country: p.country, avatar: p.avatar },
      score: scorePair(me, p),
      reasons: []
    })).sort((a,b) => b.score - a.score);

    for (const x of scoredFallback) {
      if (out.length >= Math.max(20, want)) break;
      if (!out.some(y => String(y.profile.id) === String(x.profile.id))) out.push(x);
    }
  }

  out = out.slice(0, Math.max(20, want));

  return res.json({
    success: true,
    count: out.length,
    me: { id: me.id, role: me.role },
    data: out
  });
});



// controllers/actorsController.js

// helpers (keep near the top of file once)
const toLimit   = (v, d=20) => { const n=Number(v); return Number.isFinite(n) ? Math.min(Math.max(1,n),200) : d; };
const makeRegex = (s='') => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
const truthy    = (v) => ['1','true','yes','y','on'].includes(String(v||'').toLowerCase());

// ────────────────────── 1) ATTENDEES LIST ──────────────────────
// GET /actors/event/:eventId/attendees?limit=20&search=...&country=...&open=true
exports.listAttendeesForEvent = asyncHdl(async (req, res) => {
  const { eventId } = req.params || {};
  const { limit, search, country, open } = req.query || {};
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  const toLimit   = (v, d=20) => { const n=Number(v); return Number.isFinite(n) ? Math.min(Math.max(1,n),200) : d; };
  const makeRegex = (s='') => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
  const truthy    = (v) => ['1','true','yes','y','on'].includes(String(v||'').toLowerCase());

  const q = { id_event: eventId, $or: [{ adminVerified: 'yes' }, { adminVerified: true }, { adminVerified: undefined }] };
  const ands = [];

  if (search) {
    const rx = makeRegex(search);
    ands.push({ $or: [
      { 'personal.fullName': rx },
      { 'personal.email': rx },
      { 'organization.orgName': rx }
    ]});
  }

  if (country && String(country).trim()) {
    ands.push({ 'personal.country': new RegExp('^' + String(country).trim().replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&') + '$', 'i') });
  }

  if (truthy(open)) ands.push({ 'matchingIntent.openToMeetings': true });
  if (ands.length) q.$and = ands;

  const rows = await attendee.find(q)
    .select('personal.fullName personal.profilePic personal.email organization.orgName organization.jobTitle organization.businessRole matchingIntent.openToMeetings createdAt')
    .sort({ createdAt: -1 })
    .limit(toLimit(limit, 20))
    .lean();

  const data = rows.map(d => ({
    id: d._id,
    fullName: d?.personal?.fullName || '',
    orgName: d?.organization?.orgName || '',
    jobTitle: d?.organization?.jobTitle || d?.organization?.businessRole || '',
    ProfilePic: d?.personal?.profilePic || '',
    BusinesRole: d?.organization?.businessRole || '',
    openMeetings: !!(d?.matchingIntent?.openToMeetings)
  }));

  res.json({ success: true, count: data.length, data });
});

// ────────────────────── 2) EXHIBITORS LIST ──────────────────────
// GET /actors/event/:eventId/exhibitors?limit=20&search=...&country=...&open=true
exports.listExhibitorsForEvent = asyncHdl(async (req, res) => {
  const { eventId } = req.params || {};
  const { limit, search, country, open } = req.query || {};
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  const toLimit   = (v, d=20) => { const n=Number(v); return Number.isFinite(n) ? Math.min(Math.max(1,n),200) : d; };
  const makeRegex = (s='') => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
  const truthy    = (v) => ['1','true','yes','y','on'].includes(String(v||'').toLowerCase());

  const q = { id_event: eventId, $or: [{ adminVerified: 'yes' }, { adminVerified: true }, { adminVerified: undefined }] };
  const ands = [];

  if (search) {
    const rx = makeRegex(search);
    ands.push({ $or: [
      { 'identity.exhibitorName': rx },
      { 'identity.orgName': rx },
      { 'identity.email': rx }
    ]});
  }

  if (country && String(country).trim()) {
    ands.push({ 'identity.country': new RegExp('^' + String(country).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '$', 'i') });
  }

  if (truthy(open)) ands.push({ 'commercial.availableMeetings': true });
  if (ands.length) q.$and = ands;

  const rows = await Exhibitor.find(q)
    .select('identity.exhibitorName identity.orgName identity.logo identity.country business.industry commercial.offering commercial.availableMeetings createdAt')
    .sort({ createdAt: -1 })
    .limit(toLimit(limit, 20))
    .lean();

  const data = rows.map(d => ({
    id: d._id,
    orgName: d?.identity?.exhibitorName || d?.identity?.orgName || '',
    industry: d?.business?.industry || '',
    logo: d?.identity?.logo || '',
    offering: d?.commercial?.offering || '',
    openToMeet: !!(d?.commercial?.availableMeetings)
  }));

  res.json({ success: true, count: data.length, data });
});
// ───────────────────────── 3) SPEAKERS LIST ─────────────────────
// GET /actors/event/:eventId/speakers?limit=20&search=...&country=...&open=true
exports.listSpeakersForEvent = asyncHdl(async (req, res) => {
  const { eventId } = req.params || {};
  const { limit, search, country, open } = req.query || {};
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ message: 'Bad eventId' });

  // speakers are visible regardless of adminVerified, but keep the check if present
  const q = {
    id_event: eventId,
    $or: [{ adminVerified: 'yes' }, { adminVerified: true }, { adminVerified: undefined }]
  };
  const ands = [];

  if (search) {
    const rx = makeRegex(search);
    ands.push({
      $or: [
        { 'personal.fullName': rx },
        { 'personal.email': rx },
        { 'organization.orgName': rx },
        { 'talk.title': rx },
        { 'talk.topicCategory': rx }
      ]
    });
  }

  if (country && String(country).trim()) {
    ands.push({
      'personal.country': new RegExp(
        '^' + String(country).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        'i'
      )
    });
  }

  if (truthy(open)) {
    ands.push({ 'b2bIntent.openMeetings': true });
  }

  if (ands.length) q.$and = ands;

  const rows = await Speaker.find(q)
    .select([
      // identity
      'personal.fullName',
      'personal.email',
      'personal.country',
      'personal.profilePic',
      // org
      'organization.orgName',
      'organization.jobTitle',
      'organization.businessRole',
      // talk & b2b
      'talk.title',
      'talk.topicCategory',
      'talk.language',
      'b2bIntent.openMeetings',
      // verification + meta
      'verified',
      'adminVerified',
      'createdAt'
    ].join(' '))
    .sort({ createdAt: -1 })
    .limit(toLimit(limit, 20))
    .lean();

  const data = rows.map(d => {
    const fullName   = d?.personal?.fullName || '';
    const orgName    = d?.organization?.orgName || '';
    const jobTitle   = d?.organization?.jobTitle || '';
    const bizRole    = d?.organization?.businessRole || '';
    const countryVal = d?.personal?.country || '';
    const avatar     = d?.personal?.profilePic || '';
    const openMeet   = !!(d?.b2bIntent?.openMeetings);
    const talkTitle  = d?.talk?.title || '';
    const topic      = d?.talk?.topicCategory || '';
    const lang       = d?.talk?.language || '';

    // extra frontend-friendly fields
    const role       = 'speaker';
    const actorType  = 'speaker'; // stable actor type (frontend will rely on this)
    const displayName= fullName || orgName || '(Unnamed)';
    const tags       = [topic, lang].filter(Boolean);

    return {
      // required
      id: d._id,
      fullName,
      orgName,
      jobTitle,
      BuinessRole: bizRole,                      // keep original misspelled key for backward-compat
      country: countryVal,
      profilePic: avatar,
      openMeetings: openMeet,

      // NEW: robust role system + frontend helpers
      role,                                      // 'speaker'
      actorType,                                 // fixed type string for the role system
      displayName,                               // canonical name to render
      talk: { title: talkTitle, topicCategory: topic, language: lang },
      tags,                                      // light chips for UI

      // verification flags for badges/filters
      verifiedEmail: !!d?.verified,
      adminVerified: d?.adminVerified === 'yes' || d?.adminVerified === true,

      // meta for sorting/UX
      createdAt: d?.createdAt
    };
  });

  res.json({ success: true, count: data.length, data });
});

