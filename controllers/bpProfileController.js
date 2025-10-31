// controllers/bpProfileController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const { toStr, normTags } = require('../utils/bpUtil');
const Exhibitor = require('../models/exhibitor');
const Speaker   = require('../models/speaker');
const Attendee  = require('../models/attendee');
const mongoose = require('mongoose');
const TYPE_TO_MODEL = {
  exhibitor: Exhibitor,
  speaker:   Speaker,
  attendee:  Attendee,
};
async function loadActorByAny(id){
  if (!isId(id)) return null;
  // try exact collections first
  for (const M of [Attendee, Exhibitor, Speaker]){
    const doc = await M.findById(id).lean();
    if (doc) return { doc, role: M.modelName.toLowerCase() }; // attendee|exhibitor|speaker
  }
  return null;
}

function nameOf(a, role){
  if (!a) return '';
  if (role === 'attendee')  return a.personal?.fullName || '';
  if (role === 'speaker')   return a.personal?.fullName || '';
  if (role === 'exhibitor') return a.identity?.contactName || a.identity?.exhibitorName || '';
  return '';
}
function avatarOf(a, role){
  if (!a) return '';
  if (role === 'attendee')  return a.personal?.profilePic || '';
  if (role === 'speaker')   return a.personal?.profilePic || '';
  if (role === 'exhibitor') return a.identity?.logo || '';
  return '';
}
function cityOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.identity?.city || '';
  return a.personal?.city || '';
}
function countryOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.identity?.country || '';
  return a.personal?.country || '';
}
function titleOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.actorHeadline || a.business?.industry || '';
  return a.organization?.jobTitle || a.actorHeadline || '';
}
function deptOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.business?.industry || '';
  return a.organization?.businessRole || '';
}
function openMeetOf(a, role){
  if (!a) return false;
  if (role === 'exhibitor') return !!a.commercial?.availableMeetings; // Exhibitor.commercial.availableMeetings
  // attendee/speaker
  return !!(a.matchingIntent?.openToMeetings || a.b2bIntent?.openMeetings);
}
function linksOf(a, role){
  const website  = a?.links?.website  || '';
  const linkedin = a?.links?.linkedin || '';
  return { website, linkedin };
}
function emailOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.identity?.email || a.identity?.firstEmail || '';
  return a.personal?.email || a.personal?.firstEmail || '';
}
function phoneOf(a, role){
  if (!a) return '';
  if (role === 'exhibitor') return a.identity?.phone || '';
  return a.personal?.phone || '';
}

function normalizeMember(a, role, entityId){
  return {
    id: String(entityId),
    fullName: nameOf(a, role) || '—',
    title: titleOf(a, role) || '',
    dept: deptOf(a, role) || '',
    city: cityOf(a, role) || '',
    country: countryOf(a, role) || '',
    avatar: avatarOf(a, role) || '',
    open: openMeetOf(a, role),
    skills: Array.isArray(a?.subRole) ? a.subRole : [],
    peerId: String(entityId),
    entityType: role,
    entityId: String(entityId),
  };
}

/* ---------- helpers for profile lookup (id or slug) ---------- */
async function findProfile(idOrSlug){
  if (isId(idOrSlug)){
    return BusinessProfile.findById(idOrSlug).lean();
  }
  return BusinessProfile.findOne({ slug: String(idOrSlug).toLowerCase() }).lean();
}
const isId = (v)=> mongoose.Types.ObjectId.isValid(String(v||''));
const toISO = (d)=> d ? new Date(d).toISOString() : '';
exports.getPublicTeam = async (req, res) => {
  const { idOrSlug } = req.params;
  const p = await findProfile(idOrSlug);
  if (!p) return res.status(404).json({ message: 'Profile not found' });

  const rawTeam = Array.isArray(p.team) ? p.team : [];

  // load each entity, normalize
  const members = [];
  for (const t of rawTeam){
    const role = String(t.role || '').toLowerCase();
    const entityId = t.entityId;
    const M = ROLE_MODEL[role];
    if (!M || !isId(entityId)) continue;
    const doc = await M.findById(entityId).lean();
    if (!doc) continue;
    members.push(normalizeMember(doc, role, entityId));
  }

  // ensure owner appears once (if owner belongs to known base roles)
  if (p.owner?.actor && isId(p.owner.actor)){
    const exist = members.some(m => m.entityId === String(p.owner.actor));
    if (!exist){
      const owner = await loadActorByAny(p.owner.actor);
      if (owner?.doc){
        members.unshift(normalizeMember(owner.doc, owner.role, p.owner.actor));
      }
    }
  }

  return res.json({ success:true, data: members });
};

const get = (obj, path) => path.split('.').reduce((o,k)=> (o && o[k]!==undefined) ? o[k] : undefined, obj);
const pickFirst = (doc, paths) => {
  for (const p of paths) { const v = get(doc, p); if (v != null && v !== '') return v; }
  return '';
};
const ROLE_MODELS = {
  exhibitor: { Model: Exhibitor, namePaths: ['identity.exhibitorName','identity.contactName'], avatarPaths: ['identity.logo'] },
  speaker  : { Model: Speaker,   namePaths: ['personal.fullName'],        avatarPaths: ['personal.profilePic'] },
  attendee : { Model: Attendee,  namePaths: ['personal.fullName'],        avatarPaths: ['personal.profilePic'] },
};

const denyStudent = (role='') => String(role).toLowerCase() === 'student';
async function loadMyBP(userId) {
  // Adjust this to your ownership model
  return BusinessProfile.findOne({ owner: userId });
}

async function fetchOneBy(type, id) {
  const Model = TYPE_TO_MODEL[type];
  if (!Model) return null;
  return Model.findById(id, { _id:1, name:1, title:1, headline:1, avatarUpload:1 }).lean();
}
const pickPublic = (p) => ({
  _id: p._id, slug: p.slug, name: p.name, size: p.size, tagline: p.tagline,
  about: p.about, industries: p.industries, countries: p.countries, languages: p.languages,
  offering: p.offering, seeking: p.seeking, innovation: p.innovation,
  owner: p.owner, event: p.event,
  logoUpload: p.logoUpload, bannerUpload: p.bannerUpload, gallery: p.gallery,
  badges: p.badges, featured: p.featured, published: p.published,
  stats: p.stats, createdAt: p.createdAt, updatedAt: p.updatedAt
});
exports.getMyTeam = async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const bp = await BusinessProfile.findOne({ 'owner.actor': actorId }).lean();
  console.log("bp",bp);
  if (!bp) return res.status(404).json({ message: 'BP_NOT_FOUND' });

  const team = Array.isArray(bp.team) ? bp.team : [];

  // fetch each referenced actor to display name & avatar
  async function hydrate(t) {
    const role = t.role;
    const { Model, namePaths, avatarPaths } = ROLE_MODELS[role] || {};
    if (!Model) return null;
    const doc = await Model.findById(t.entityId).lean();
    if (!doc) return null;
    return {
      role: role,
      entityId  : String(t.entityId),
      roleLabel : t.role || '',
      name      : pickFirst(doc, namePaths) || '(Unnamed)',
      avatarUpload: pickFirst(doc, avatarPaths) || null,
      title     : '', // optional
    };
  }

  const hydrated = (await Promise.all(team.map(hydrate))).filter(Boolean);
  return res.json({ success: true, data: hydrated });
};

exports.searchTeamCandidates = async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  if (!actorId) return res.status(401).json({ message: 'Unauthorized' });

  const q = toStr(req.query.q);
  const limit = Math.max(1, Math.min(30, Number(req.query.limit || 12)));

  // 1) Collect all actors who already OWN a BP -> exclude them
  const owners = await BusinessProfile.find({}, { 'owner.actor': 1 }).lean();
  const ownerIds = new Set(owners.map(x => String(x.owner?.actor)).filter(Boolean));

  // 2) Collect my BP (to exclude already-added team members)
  const myBP = await BusinessProfile.findOne({ 'owner.actor': actorId }, { team: 1 }).lean();
  const alreadyInTeam = new Set(
    (myBP?.team || []).map(t => `${t.entityType}:${String(t.entityId)}`)
  );

  // 3) Build a regex for name/email search (where available)
  const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

  async function searchRole(roleKey){
    const { Model, namePaths, avatarPaths } = ROLE_MODELS[roleKey];
    const nameOrEmail = [
      ...namePaths,
      ...(roleKey === 'exhibitor' ? ['identity.email'] : ['personal.email'])
    ];
    const proj = {};
    [...namePaths, ...avatarPaths, ...nameOrEmail, 'id_event', 'createdAt'].forEach(p => proj[p] = 1);

    const sFilter = rx ? { $or: nameOrEmail.map(p => ({ [p]: rx })) } : {};
    const rows = await Model.find(sFilter, proj).sort({ createdAt: -1 }).limit(limit).lean();

    const out = [];
    for (const d of rows) {
      const id = String(d._id);
      if (ownerIds.has(id)) continue; // has its own BP -> cannot be a team member
      const key = `${roleKey}:${id}`;
      if (alreadyInTeam.has(key)) continue; // already in my team

      out.push({
        entityType: roleKey,
        entityId  : id,
        name      : pickFirst(d, namePaths) || '(Unnamed)',
        title     : '', // optional – you can enrich if you have a title field
        avatarUpload: pickFirst(d, avatarPaths) || null,
      });
    }
    return out;
  }

  const [exh, spk, att] = await Promise.all([
    searchRole('exhibitor'),
    searchRole('speaker'),
    searchRole('attendee'),
  ]);

  // merge + trim to limit
  const merged = [...exh, ...spk, ...att].slice(0, limit);
  return res.json({ success: true, data: merged });
};


/** POST /biz/bp/me/team { entityType, entityId, role? } */
exports.addTeamMember = async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const { entityId, role } = req.body || {};
  const entityType =role;
  const roleKey = String(role || '').toLowerCase();
  if (!['exhibitor','speaker','attendee'].includes(roleKey))
    return res.status(400).json({ message: 'entityType must be exhibitor|speaker|attendee' });
  if (!mongoose.isValidObjectId(entityId))
    return res.status(400).json({ message: 'Bad entityId' });

  const bp = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (!bp) return res.status(404).json({ message: 'BP_NOT_FOUND' });

  // ensure the target actor does NOT own a BP
  const hasOwnBP = await BusinessProfile.exists({ 'owner.actor': entityId });
  if (hasOwnBP) return res.status(409).json({ message: 'Actor already has a business profile' });
  // avoid duplicates
  const exists = (bp.team || []).some(t => t.role === roleKey && String(t.entityId) === String(entityId));
  if (exists) return res.status(200).json({ success: true, data: bp.team });

  bp.team = [...(bp.team || []), {entityId, role: roleKey }];
await bp.save();
  return res.status(201).json({ success: true, data: bp.team });
};

/** DELETE /biz/bp/me/team/:entityType/:entityId */
exports.removeTeamMember = async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const roleKey = String(req.params.entityType || '').toLowerCase();
  const entId = req.params.entityId;

  if (!['exhibitor','speaker','attendee'].includes(roleKey))
    return res.status(400).json({ message: 'entityType must be exhibitor|speaker|attendee' });
  if (!mongoose.isValidObjectId(entId))
    return res.status(400).json({ message: 'Bad entityId' });

  const bp = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (!bp) return res.status(404).json({ message: 'BP_NOT_FOUND' });

  const before = bp.team?.length || 0;
  bp.team = (bp.team || []).filter(t => !(t.entityType === roleKey && String(t.entityId) === String(entId)));
  if (bp.team.length === before) return res.status(404).json({ message: 'Not in team' });

  await bp.save();
  return res.json({ success: true, data: bp.team });
};
// POST /bp/me/create-or-get
exports.createOrGetMyProfile = asyncHdl(async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const actorRole = (req.user?.actorType || req.user?.role || '').toLowerCase();
  if (!actorId) return res.status(401).json({ message: 'Unauthorized' });
  if (denyStudent(actorRole)) return res.status(403).json({ message: 'Students cannot own a business profile' });

  let p = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (p) return res.json({ ok: true, created: false, data: pickPublic(p) });

  // sensible defaults using any data present on req.user (comes from your role model at login)
  const defaultName =
    req.user?.personal?.fullName ||
    req.user?.identity?.exhibitorName ||
    req.user?.organization?.orgName ||
    'My Business';

  p = new BusinessProfile({
    owner: { actor: actorId, role: actorRole || 'attendee' },
    event: req.user?.id_event || undefined,
    name: toStr(req.body?.name || defaultName, 120),
    size: toStr(req.body?.size || '1-10', 20),
    tagline: toStr(req.body?.tagline, 160),
    about: toStr(req.body?.about, 4000),
    industries: normTags(req.body?.industries || req.user?.business?.industry || req.user?.businessProfile?.primaryIndustry),
    countries : normTags(req.body?.countries || req.user?.personal?.country),
    languages : normTags(req.body?.languages || req.user?.personal?.preferredLanguages || req.user?.identity?.preferredLanguages),
    offering  : normTags(req.body?.offering  || req.user?.commercial?.offering || req.user?.b2bIntent?.offering),
    seeking   : normTags(req.body?.seeking   || req.user?.matchingIntent?.objectives || req.user?.commercial?.lookingFor || req.user?.b2bIntent?.lookingFor),
    innovation: normTags(req.body?.innovation),
  });

  await p.save();
  res.status(201).json({ ok: true, created: true, data: pickPublic(p) });
});

// PATCH /bp/me
exports.updateMyProfile = asyncHdl(async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const p = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (!p) return res.status(404).json({ message: 'Not found' });

  const allow = ['name','size','tagline','about','contacts','socials','featured','badges','published'];
  for (const k of allow) if (k in req.body) p[k] = req.body[k];

  if ('industries' in req.body) p.industries = normTags(req.body.industries);
  if ('countries'  in req.body) p.countries  = normTags(req.body.countries);
  if ('languages'  in req.body) p.languages  = normTags(req.body.languages);
  if ('offering'   in req.body) p.offering   = normTags(req.body.offering);
  if ('seeking'    in req.body) p.seeking    = normTags(req.body.seeking);
  if ('innovation' in req.body) p.innovation = normTags(req.body.innovation);

  await p.save();
  res.json({ ok: true, data: pickPublic(p) });
});

// PATCH /bp/me/role  { toRole }
exports.changeMyBusinessRole = asyncHdl(async (req, res) => {
  const actorId = req.user?._id || req.user?.id;
  const toRole = String(req.body?.toRole || '').toLowerCase().trim();
  if (!toRole) return res.status(400).json({ message: 'toRole required' });
  if (denyStudent(toRole)) return res.status(400).json({ message: 'Cannot change to student' });

  const p = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (!p) return res.status(404).json({ message: 'Not found' });

  p.owner.role = toRole;
  await p.save();
  res.json({ ok: true, role: p.owner.role });
});

// GET /bp/me/summary
// controllers/bpProfileController.js
exports.getMyProfileSummary = asyncHdl(async (req, res) => {
  const actorId = req.user?._id || req.user?.id;

  const p = await BusinessProfile.findOne({ 'owner.actor': actorId })
    .select(
      [
        '_id', 'slug', 'name', 'tagline', 'about', 'size',
        'industries', 'countries', 'languages',
        'offering', 'seeking', 'innovation',
        'logoUpload', 'bannerUpload', 'gallery',
        'contacts', 'socials', 'legalDocUpload',
        'published', 'owner', 'role', 'stats',
        'createdAt', 'updatedAt'
      ].join(' ')
    )
    .lean();

  if (!p) return res.status(404).json({ message: 'Not found' });

  // Normalize arrays so the client can map() safely
  const arr = (v) => (Array.isArray(v) ? v : []);
  const data = {
    _id: p._id,
    slug: p.slug || null,
    name: p.name || '',
    tagline: p.tagline || '',
    about: p.about || '',
    size: p.size || '',
    industries: arr(p.industries),
    countries: arr(p.countries),
    languages: arr(p.languages),
    offering: arr(p.offering),
    seeking: arr(p.seeking),
    innovation: arr(p.innovation),

    logoUpload: p.logoUpload || null,
    bannerUpload: p.bannerUpload || null,
    gallery: arr(p.gallery),

    contacts: arr(p.contacts),
    socials: arr(p.socials),
    legalDocUpload: p.legalDocUpload || null,

    published: !!p.published,
    owner: p.owner || null,
    role: p.role || null,
    stats: p.stats || {},

    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };

  return res.json({ ok: true, data });
});
exports.confirmProfileId = asyncHdl(async (req, res) => {
  const profileId = req.params.id;
  if (!profileId || !mongoose.isValidObjectId(profileId)) {
    return res.status(400).json({ success: false, error: 'INVALID_PROFILE_ID' });
  }
  const bp = await BusinessProfile.findById(profileId).lean();
  if (!bp) {
    return res.status(404).json({ success: false, error: 'BP_NOT_FOUND' });
  }
  return res.status(200).json({ success: true, data: pickPublic(bp) });

});