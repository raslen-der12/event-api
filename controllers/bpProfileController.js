// controllers/bpProfileController.js
const asyncHdl = require('express-async-handler');
const BusinessProfile = require('../models/BusinessProfile');
const { toStr, normTags } = require('../utils/bpUtil');
const Exhibitor = require('../models/exhibitor');
const Speaker   = require('../models/speaker');
const Attendee  = require('../models/attendee');
const MeetRequest = require('../models/meetRequest');
const SessionRegistration = require('../models/sessionRegistration');
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
function modelByRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'exhibitor') return Exhibitor;
  if (r === 'attendee')  return Attendee;
  if (r === 'speaker' && Speaker) return Speaker;
  return null;
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

exports.getPublicTeam = asyncHdl(async (req, res) => {
  const id = req.params.profileId;
  const profile = await loadProfile(id);
    console.log("bp/me/team",req.user);

  if (!profile) return res.status(404).json({ message: 'BusinessProfile not found' });

  // helpers
  const isId = (v) => mongoose.isValidObjectId(v);
  const toStr = (v) => (v == null ? '' : String(v));
  const norm = (s) => toStr(s).trim().toLowerCase();

  const roleModel = (r) => ({ attendee: Attendee, exhibitor: Exhibitor, speaker: Speaker }[norm(r)] || null);

  // Try to resolve owner role to one of attendee|exhibitor|speaker if possible
  let ownerActor = profile?.owner?.actor;
  let ownerRole  = norm(profile?.owner?.role);
  if (isId(ownerActor) && !['attendee','exhibitor','speaker'].includes(ownerRole)) {
    // Soft-detect which collection actually holds the owner
    if (await Attendee.exists({ _id: ownerActor }))  ownerRole = 'attendee';
    else if (await Exhibitor.exists({ _id: ownerActor })) ownerRole = 'exhibitor';
    else if (await Speaker.exists({ _id: ownerActor }))   ownerRole = 'speaker';
  }

  // Base members use model fields: team[].{role, entityId}
  const base = Array.isArray(profile.team) ? profile.team : [];
  const members = base
    .filter(m => isId(m?.entityId) && ['attendee','exhibitor','speaker'].includes(norm(m.role)))
    .map(m => ({ entityType: norm(m.role), entityId: String(m.entityId) }));

  // Ensure owner is present if resolvable
  if (isId(ownerActor) && ['attendee','exhibitor','speaker'].includes(ownerRole)) {
    const key = `${ownerRole}|${String(ownerActor)}`;
    const have = new Set(members.map(m => `${m.entityType}|${m.entityId}`));
    if (!have.has(key)) members.push({ entityType: ownerRole, entityId: String(ownerActor) });
  }

  // De-dupe
  const uniq = Array.from(new Map(members.map(m => [`${m.entityType}|${m.entityId}`, m])).values());

  // Batch fetch by role
  const byRole = uniq.reduce((acc, m) => {
    (acc[m.entityType] ||= []).push(m.entityId);
    return acc;
  }, {});

  const out = [];

  async function pull(role, Model) {
    const ids = byRole[role] || [];
    if (!ids.length || !Model) return;

    const select =
      role === 'exhibitor'
        ? 'identity.exhibitorName identity.contactName identity.logo identity.city identity.country commercial.availableMeetings'
        : 'personal.fullName personal.profilePic personal.city personal.country matchingIntent.openToMeetings';

    const docs = await Model.find({ _id: { $in: ids } }).select(select).lean();
    const map  = new Map(docs.map(d => [String(d._id), d]));

    for (const id of ids) {
      const d = map.get(String(id));
      const card = d ? extractActorCard(role, d) : { name:'', avatar:'', city:'', country:'', open:false };
      out.push({
        id: String(id),
        peerId: String(id),
        entityType: role,
        entityId: String(id),
        fullName: card.name || '',
        title: role,       // no title in BP.team schema; keep empty for UI compatibility
        dept: '',        // same
        city: card.city || '',
        country: card.country || '',
        avatar: card.avatar || '',
        open: !!card.open,
        skills: []       // team schema has no skills; keep empty list
      });
    }
  }

  await pull('attendee',  Attendee);
  await pull('exhibitor', Exhibitor);
  await pull('speaker',   Speaker);

  out.sort((a,b)=> (a.fullName||'').localeCompare(b.fullName||'', undefined, { sensitivity:'base' }));
  return res.json({ success:true, data: out, count: out.length });
});

function extractActorCard(role, doc) {
  const r = String(role||'').toLowerCase();
  let name = '';
  let avatar = '';
  let city = '';
  let country = '';
  let open = false;

  if (r === 'exhibitor') {
    name    = toStr(doc?.identity?.contactName) || toStr(doc?.identity?.exhibitorName);
    avatar  = toStr(doc?.identity?.logo);
    city    = toStr(doc?.identity?.city);
    country = toStr(doc?.identity?.country);
    open    = !!doc?.commercial?.availableMeetings;
  } else {
    // attendee / speaker share the same personal.* structure in your codebase
    name    = toStr(doc?.personal?.fullName);
    avatar  = toStr(doc?.personal?.profilePic);
    city    = toStr(doc?.personal?.city);
    country = toStr(doc?.personal?.country);
    open    = !!doc?.matchingIntent?.openToMeetings;
  }

  return { name, avatar, city, country, open };
}
async function loadProfile(id) {
  if (isId(id)) {
    const p = await BusinessProfile.findById(id).lean();
    if (p) return p;
  }
  return await BusinessProfile.findOne({ slug: String(id).trim().toLowerCase() }).lean();
}
exports.getPublicContact = asyncHdl(async (req, res) => {
  const id = req.params.profileId;
  const profile = await loadProfile(id);
  if (!profile) return res.status(404).json({ message: 'BusinessProfile not found' });

  const toStr = (v) => (v == null ? '' : String(v));
  const isId  = (v) => mongoose.isValidObjectId(v);
  const normR = (r) => String(r||'').toLowerCase();

  // 1) Base arrays from BP model
  const contacts = Array.isArray(profile.contacts) ? profile.contacts : [];   // [{kind,value,label}]
  const socials  = Array.isArray(profile.socials)  ? profile.socials  : [];   // [{kind,url}]
  const countries= Array.isArray(profile.countries)? profile.countries: [];   // ['TN','FR',...]
  const name     = toStr(profile.name);
  const size     = toStr(profile.size);

  // 2) Owner fallback for a "people" main contact + website/linkedin
  let ownerDoc = null, ownerRole = normR(profile?.owner?.role), ownerId = profile?.owner?.actor;
  const roleModel = (r) => ({ attendee: Attendee, exhibitor: Exhibitor, speaker: Speaker }[normR(r)] || null);

  if (isId(ownerId)) {
    if (!['attendee','exhibitor','speaker'].includes(ownerRole)) {
      if (await Attendee.exists({ _id: ownerId }))  ownerRole = 'attendee';
      else if (await Exhibitor.exists({ _id: ownerId })) ownerRole = 'exhibitor';
      else if (await Speaker.exists({ _id: ownerId }))   ownerRole = 'speaker';
    }
    const M = roleModel(ownerRole);
    if (M) ownerDoc = await M.findById(ownerId).lean().catch(()=>null);
  }

  const people = [];
  if (ownerDoc) {
    const card = extractActorCard(ownerRole, ownerDoc);
    const email = ownerRole === 'exhibitor' ? toStr(ownerDoc?.identity?.email) : toStr(ownerDoc?.personal?.email);
    const phone = ownerRole === 'exhibitor' ? toStr(ownerDoc?.identity?.phone) : toStr(ownerDoc?.personal?.phone);
    people.push({
      id: String(ownerId),
      name: card.name || 'Contact',
      title: ownerRole.charAt(0).toUpperCase() + ownerRole.slice(1),
      email, phone, avatar: card.avatar || ''
    });

    // Derive common socials if BP.socials misses them
    const website  = toStr(ownerDoc?.links?.website);
    const linkedin = toStr(ownerDoc?.links?.linkedin);
    const has = (k) => socials.some(s => s?.kind === k);
    if (website && !has('website'))  socials.push({ kind:'website',  url: website });
    if (linkedin && !has('linkedin')) socials.push({ kind:'linkedin', url: linkedin });
  }

  // 3) Locations: BP has no locations array; build a light list from owner city/country or BP.countries
  const locs = [];
  if (ownerDoc) {
    const city = ownerRole === 'exhibitor' ? toStr(ownerDoc?.identity?.city) : toStr(ownerDoc?.personal?.city);
    const country = ownerRole === 'exhibitor' ? toStr(ownerDoc?.identity?.country) : toStr(ownerDoc?.personal?.country);
    if (city || country) locs.push({ label:'HQ', city, country, address:'' });
  }
  if (!locs.length && countries.length) {
    // show first country at least
    locs.push({ label:'HQ', city:'', country: countries[0], address:'' });
  }

  // 4) Company facts
  const company = [];
  if (name) company.push({ label:'Company', value:name });
  if (size) company.push({ label:'Size', value:size });

  // 5) Collateral from available media fields in BP
  const collateral = [];
  if (profile.logoUpload)   collateral.push({ label:'Logo',   href: toStr(profile.logoUpload),   type:'image' });
  if (profile.bannerUpload) collateral.push({ label:'Banner', href: toStr(profile.bannerUpload), type:'image' });
  if (Array.isArray(profile.gallery) && profile.gallery.length) {
    profile.gallery.slice(0, 6).forEach((g, i) => collateral.push({ label:`Gallery ${i+1}`, href: toStr(g), type:'image' }));
  }
  if (profile.legalDocPath) collateral.push({ label:'Legal', href: toStr(profile.legalDocPath), type:'file' });

  // 6) Topics/tags — synthesize from offering|seeking|innovation|industries
  const uniq = (a) => Array.from(new Set((a||[]).map(s => String(s).trim()).filter(Boolean)));
  const topics = uniq([...(profile.offering||[]), ...(profile.seeking||[]), ...(profile.innovation||[]), ...(profile.industries||[])]).slice(0, 12);

  return res.json({
    success:true,
    data: {
      people,
      social: socials.map(s => ({ kind: toStr(s.kind), url: toStr(s.url) })),
      locations: locs,
      company,
      collateral,
      topics
    }
  });
});
exports.getPublicEngagements = asyncHdl(async (req, res) => {
  const id = req.params.profileId;
  const profile = await loadProfile(id);
  
  if (!profile) return res.status(404).json({ message: 'BusinessProfile not found' });

  const eventId = profile.event;
  const ownerId = profile?.owner?.actor;
  if (!isId(eventId) || !isId(ownerId)) {
    return res.json({ success:true, data: [] });
  }

  // --- pull meetings for this owner ---
  const meets = await MeetRequest.find({
    eventId,
    $or: [{ senderId: ownerId }, { receiverId: ownerId }]
  })
  .select('_id slotISO status happenedAt senderId receiverId meetLink tableId')
  .lean()
  .catch(() => []);

  // collect counterpart ids
  const counterpartIds = new Set();
  for (const m of meets) {
    const me = String(ownerId);
    const other = String(m?.senderId) === me ? String(m?.receiverId) : String(m?.senderId);
    if (isId(other)) counterpartIds.add(other);
  }
  const cpIds = [...counterpartIds];

  // fetch counterpart minimal cards from all roles
  const [exh, att, spk] = await Promise.all([
    Exhibitor.find({ _id: { $in: cpIds } })
      .select('identity.exhibitorName identity.contactName')
      .lean().catch(()=>[]),
    Attendee.find({ _id: { $in: cpIds } })
      .select('personal.fullName')
      .lean().catch(()=>[]),
    Speaker.find({ _id: { $in: cpIds } })
      .select('personal.fullName')
      .lean().catch(()=>[])
  ]);

  const cardMap = new Map();
  for (const d of exh) cardMap.set(String(d._id), {
    name: d?.identity?.exhibitorName || d?.identity?.contactName || 'Exhibitor',
    org : d?.identity?.exhibitorName || undefined
  });
  for (const d of att) cardMap.set(String(d._id), {
    name: d?.personal?.fullName || 'Attendee', org: undefined
  });
  for (const d of spk) cardMap.set(String(d._id), {
    name: d?.personal?.fullName || 'Speaker', org: undefined
  });

  function inferMode(m){
    if (m.meetLink && m.tableId) return 'hybrid';
    if (m.meetLink) return 'virtual';
    return 'in-person';
  }
  function mapStatus(m){
    // normalize to UI’s set
    if (m.status === 'confirmed') return m.happenedAt ? 'completed' : 'scheduled';
    if (m.status === 'declined')  return 'lost';
    if (m.status === 'cancelled') return 'lost';
    return 'in-progress';
  }

  const items = [];
  for (const m of meets) {
    const me = String(ownerId);
    const otherId = String(m?.senderId) === me ? String(m?.receiverId) : String(m?.senderId);
    const cp = cardMap.get(otherId) || {};
    items.push({
      id: String(m._id),
      type: 'meeting',
      title: 'B2B Meeting',
      counterpart: { name: cp.name || cp.org || '—', org: cp.org || cp.name || '' },
      dateISO: m?.slotISO ? new Date(m.slotISO).toISOString() : null,
      mode: inferMode(m),                 // 'in-person' | 'virtual' | 'hybrid'
      status: mapStatus(m),               // 'scheduled' | 'in-progress' | 'completed' | 'lost'
      notes: m.tableId ? `Table ${m.tableId}` : '',
      tags: [inferMode(m)]
    });
  }

  // (Optional) include simple session “touches” as follow-ups (non-destructive):
  if (SessionRegistration && isId(ownerId) && isId(eventId)) {
    const regs = await SessionRegistration.find({
      actorId: ownerId, eventId, status: { $ne: 'cancelled' }
    }).select('createdAt status attended').lean().catch(()=>[]);
    for (const r of regs) {
      items.push({
        id: `sess-${String(r._id)}`,
        type: 'followup',
        title: 'Session Registration',
        counterpart: { name: 'Program Session', org: '' },
        dateISO: r?.createdAt ? new Date(r.createdAt).toISOString() : null,
        mode: 'in-person',
        status: r.attended ? 'completed' : 'in-progress',
        notes: r.attended ? 'Marked attended' : 'Assigned',
        tags: ['session']
      });
    }
  }

  items.sort((a,b)=>{
    const A = a.dateISO ? new Date(a.dateISO).getTime() : 0;
    const B = b.dateISO ? new Date(b.dateISO).getTime() : 0;
    return B - A;
  });

  return res.json({ success:true, data: items });
});
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
  console.log("bp/me/team",req.user);
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
  console.log("req.params.entityType ",req.params.entityType );
  const roleKey = String(req.params.entityType || '').toLowerCase();
  const entId = req.params.entityId;

  if (!['exhibitor','speaker','attendee'].includes(roleKey))
    return res.status(400).json({ message: 'entityType must be exhibitor|speaker|attendee' });
  if (!mongoose.isValidObjectId(entId))
    return res.status(400).json({ message: 'Bad entityId' });

  const bp = await BusinessProfile.findOne({ 'owner.actor': actorId });
  if (!bp) return res.status(404).json({ message: 'BP_NOT_FOUND' });

  const before = bp.team?.length || 0;
  bp.team = (bp.team || []).filter(t => !(t.role === roleKey && String(t.entityId) === String(entId)));
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