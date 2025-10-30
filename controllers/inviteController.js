// controllers/inviteController.js
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const ActorInviteCode = require('../models/ActorInviteCode');
const ActorInviteUse  = require('../models/ActorInviteUse');
const Event      = require('../models/event'); // if you have it
const attendee   = require('../models/attendee');
const Exhibitor  = require('../models/exhibitor');
const Speaker    = require('../models/speaker');

const toStr = (v)=> (v==null?'':String(v));
const isId  = (id)=> !!id && String(id).match(/^[0-9a-fA-F]{24}$/);

function makeCode(len=8){
  // URL/typing friendly uppercase code, avoid 0/O and 1/I
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s=''; for (let i=0;i<len;i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
  return s;
}

async function uniqueCode(){
  for (let i=0;i<10;i++){
    const c = makeCode();
    const exists = await ActorInviteCode.findOne({ code: c }).lean();
    if (!exists) return c;
  }
  // last resort
  return crypto.randomUUID().slice(0,8).toUpperCase();
}

function modelByRole(role){
  const r = String(role||'').toLowerCase();
  if (r==='attendee') return attendee;
  if (r==='exhibitor') return Exhibitor;
  if (r==='speaker')  return Speaker;
  return null;
}

/** Admin: quick actor search for picker */
exports.searchActors = asyncHandler(async (req,res)=>{
  const q        = toStr(req.query.q || '');
  const role     = toStr(req.query.role || '');
  const eventId  = toStr(req.query.eventId || '');
  const limit    = Math.max(1, Math.min(30, Number(req.query.limit)||12));

  const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i') : null;

  const roles = role ? [role] : ['attendee','exhibitor','speaker'];
  const out = [];

  for (const r of roles){
    const M = modelByRole(r);
    if (!M) continue;
    const namePaths = r==='exhibitor'
      ? ['identity.exhibitorName','identity.orgName','identity.contactName']
      : ['personal.fullName'];

    const or = rx ? namePaths.map(p=>({[p]: rx})) : [];
    const qx = { ...(isId(eventId) ? { id_event: eventId } : {}), ...(rx ? {$or:or} : {}) };

    const docs = await M.find(qx)
      .select(r==='exhibitor'
        ? 'identity.exhibitorName identity.orgName identity.contactName identity.logo id_event'
        : 'personal.fullName personal.profilePic id_event')
      .limit(limit).lean();

    for (const d of docs){
      out.push({
        id: String(d._id),
        role: r,
        name: r==='exhibitor'
          ? (d?.identity?.exhibitorName || d?.identity?.orgName || d?.identity?.contactName || '')
          : (d?.personal?.fullName || ''),
        photo: r==='exhibitor' ? (d?.identity?.logo || '') : (d?.personal?.profilePic || ''),
        eventId: d?.id_event ? String(d.id_event) : null
      });
    }
  }
  res.json({ success:true, count: out.length, data: out.slice(0,limit) });
});

/** Admin: generate (or fetch existing) code for an actor */
exports.generateCode = asyncHandler(async (req,res)=>{
  const { actorId, actorRole, eventId } = req.body || {};
  if (!isId(actorId)) return res.status(400).json({ message:'Valid actorId required' });
  if (!['attendee','exhibitor','speaker'].includes(String(actorRole||''))) {
    return res.status(400).json({ message:'actorRole must be attendee|exhibitor|speaker' });
  }
  if (eventId && !isId(eventId)) return res.status(400).json({ message:'Bad eventId' });

  // ensure actor exists
  const M = modelByRole(actorRole);
  if (!M) return res.status(400).json({ message:'Bad role' });
  const actor = await M.findById(actorId).select('_id').lean();
  if (!actor) return res.status(404).json({ message:'Actor not found' });

  // find existing (per actor+role+event)
  let doc = await ActorInviteCode.findOne({ actorId, actorRole, eventId: eventId||null }).lean();
  if (doc) return res.json({ success:true, data: doc });

  // create new
  const code = await uniqueCode();
  doc = await ActorInviteCode.create({ actorId, actorRole, eventId: eventId || null, code, usageCount:0, enabled:true });
  res.status(201).json({ success:true, data: doc });
});

/** Admin: list invite codes with actor display + filters */
exports.listCodes = asyncHandler(async (req,res)=>{
  const search  = toStr(req.query.search || '');
  const role    = toStr(req.query.role || '');
  const eventId = toStr(req.query.eventId || '');
  const page    = Math.max(1, Number(req.query.page)||1);
  const limit   = Math.max(5, Math.min(50, Number(req.query.limit)||20));
  const skip    = (page-1)*limit;

  const q = {};
  if (role) q.actorRole = role;
  if (isId(eventId)) q.$or = [{eventId}, {eventId: null}]; // allow global codes too

  const [total, rows] = await Promise.all([
    ActorInviteCode.countDocuments(q),
    ActorInviteCode.find(q).sort({ createdAt:-1 }).skip(skip).limit(limit).lean()
  ]);

  // attach actor display (name/photo/link)
  const byRole = { attendee:[], exhibitor:[], speaker:[] };
  rows.forEach(r => byRole[r.actorRole]?.push(r.actorId));

  const pull = async (M, ids, roleName, namePaths, photoPath) => {
    if (!ids.length) return {};
    const docs = await M.find({ _id: { $in: ids } })
      .select([...namePaths, photoPath].join(' ')).lean();
    const map = {};
    for (const d of docs){
      let name = '';
      if (roleName==='exhibitor'){
        name = d?.identity?.exhibitorName || d?.identity?.orgName || d?.identity?.contactName || '';
      } else {
        name = d?.personal?.fullName || '';
      }
      const photo = roleName==='exhibitor' ? (d?.identity?.logo || '') : (d?.personal?.profilePic || '');
      map[String(d._id)] = { name, photo };
    }
    return map;
  };

  const [attMap, exMap, spMap] = await Promise.all([
    pull(attendee,  byRole.attendee,  'attendee',  ['personal.fullName'], 'personal.profilePic'),
    pull(Exhibitor, byRole.exhibitor, 'exhibitor', ['identity.exhibitorName','identity.orgName','identity.contactName'], 'identity.logo'),
    pull(Speaker,   byRole.speaker,   'speaker',   ['personal.fullName'], 'personal.profilePic'),
  ]);

  const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i') : null;
  let data = rows.map(r => {
    const m = r.actorRole==='attendee' ? attMap : (r.actorRole==='exhibitor' ? exMap : spMap);
    const info = m[String(r.actorId)] || { name:'', photo:'' };
    return {
      id: String(r._id),
      actorId: String(r.actorId),
      role: r.actorRole,
      name: info.name || '',
      photo: info.photo || '',
      code: r.code,
      usageCount: r.usageCount || 0,
      createdAt: r.createdAt,
      eventId: r.eventId ? String(r.eventId) : null
    };
  });

  if (rx) data = data.filter(x => rx.test(x.name) || rx.test(x.code));

  res.json({ success:true, page, limit, total, count: data.length, data });
});

/** Public (called from register flow): consume/increment usage */
exports.consumeCode = asyncHandler(async (req,res)=>{
  const { code, registeredActorId, registeredRole, eventId } = req.body || {};
  if (!toStr(code)) return res.status(400).json({ message:'code required' });
  if (!isId(registeredActorId)) return res.status(400).json({ message:'registeredActorId required' });

  const doc = await ActorInviteCode.findOne({ code: toStr(code).toUpperCase() }).lean();
  if (!doc || doc.enabled === false) return res.status(404).json({ message:'Invalid invite code' });

  try {
    await ActorInviteUse.create({
      codeId: doc._id,
      inviteCode: doc.code,
      registeredActorId,
      registeredRole: toStr(registeredRole||'').toLowerCase() || 'attendee',
      eventId: isId(eventId) ? eventId : (doc.eventId || null)
    });
    await ActorInviteCode.updateOne({ _id: doc._id }, { $inc: { usageCount: 1 } });
  } catch(e){
    // duplicate => ignore (already counted)
  }
  const fresh = await ActorInviteCode.findById(doc._id).lean();
  res.json({ success:true, data: { code: fresh.code, usageCount: fresh.usageCount }});
});
