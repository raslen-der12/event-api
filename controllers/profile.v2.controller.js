// controllers/profile.v2.controller.js
const mongoose = require('mongoose');

// --- Core actor models (adjust paths to yours)
const Attendee  = require('../models/attendee');
const Speaker   = require('../models/speaker');
const Exhibitor = require('../models/exhibitor');

// --- Optional: business profile model
const BusinessProfile = require('../models/BusinessProfile');

// --- Optional: role assignment models (if you use separate collections)
const RoleBusinessOwner = require('../models/roles/BusinessOwner');
const RoleConsultant    = require('../models/roles/Consultant');
const RoleEmployee      = require('../models/roles/Employee');
const RoleExpert        = require('../models/roles/Expert');
const RoleInvestor      = require('../models/roles/Investor');
const RoleStudent       = require('../models/roles/Student');

// --- Optional: file storage util (implement to your stack)
const path = require('path');
const fs   = require('fs');

function ensureObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function getModelByRole(role) {
  const r = String(role || '').toLowerCase();
  switch (r) {
    case 'attendee':  return { model: Attendee,  roleKey: 'attendee'  };
    case 'speaker':   return { model: Speaker,   roleKey: 'speaker'   };
    case 'exhibitor': return { model: Exhibitor, roleKey: 'exhibitor' };
    default:
      return { model: null, roleKey: r };
  }
}

/**
 * Normalizes minimal header fields for the ProfileShell.
 * NOTE: we DO NOT mutate original doc; we add a __ui object to help the client,
 * while keeping original paths (personal/enrichments/identity) intact.
 */
function shapeActorForHeader(doc, roleKey) {
  const r = (roleKey || '').toLowerCase();
  const clone = JSON.parse(JSON.stringify(doc || {}));

  let fullName = '';
  let orgName  = '';
  let email    = '';
  let avatar   = ''; // server url string
  let eventId  = '';

  if (r === 'attendee' || r === 'speaker') {
    fullName = clone?.personal?.fullName || '';
    orgName  = clone?.organization?.orgName || '';
    email    = clone?.personal?.email || '';
    // Attendee keeps avatar at personal.profilePic; Speaker at enrichments.profilePic
    avatar   = (r === 'attendee')
      ? (clone?.personal?.profilePic || '')
      : (clone?.enrichments?.profilePic || '');
    eventId  = clone?.eventId || clone?.id_event || '';
  } else if (r === 'exhibitor') {
    // For exhibitor the “display name” is usually brand/exhibitor name
    fullName = '';
    orgName  = clone?.identity?.exhibitorName || clone?.identity?.orgName || '';
    email    = clone?.identity?.email || '';
    avatar   = clone?.identity?.logo || '';
    eventId  = clone?.eventId || clone?.id_event || '';
  }

  // Role-like label & sub-roles (as the UI needs)
  const roleLike = clone?.actorType || '';            // BusinessOwner / Consultant / ...
  const subRoles = Array.isArray(clone?.subRole) ? clone.subRole : [];

  // “first sub-role or role-like when BusinessOwner” rule for the email chip placeholder in UI
  const firstSub = subRoles[0] || (roleLike ? roleLike : '');

  // Add a __ui helper block (non-breaking)
  clone.__ui = {
    roleKey: r,                // attendee | speaker | exhibitor
    fullName, orgName, email,
    avatarUrl: avatar,
    roleLike,
    firstSubRoleOrRoleLike: firstSub,
    eventId: eventId || '',
  };

  return clone;
}

/**
 * GET profile (new name): readProfileCardV2
 * params: role (attendee|speaker|exhibitor), id (ObjectId)
 * returns: { ok, role, actor, eventId, assignedRoles, businessProfile }
 */
exports.readProfileCardV2 = async function readProfileCardV2(req, res) {
  try {
    const role = req.params.role || req.body.role;
    const id   = req.params.id   || req.body.id;

    if (!role) return res.status(400).json({ ok:false, message:'role is required' });
    if (!id   || !ensureObjectId(id)) {
      return res.status(400).json({ ok:false, message:'bad id' });
    }

    const { model, roleKey } = getModelByRole(role);
    if (!model) return res.status(400).json({ ok:false, message:'unsupported role' });

    // Load raw doc — select only what you need or keep lean
    const doc = await model.findById(id).lean().exec();
    if (!doc) return res.status(404).json({ ok:false, message:'not found' });

    const shaped = shapeActorForHeader(doc, roleKey);

    // Assigned roles (if you keep separate role collections)
    const [isBO, isCO, isEM, isEX, isIN, isST] = await Promise.all([
      RoleBusinessOwner?.exists({ actor: id }) || false,
      RoleConsultant?.exists({ actor: id })    || false,
      RoleEmployee?.exists({ actor: id })      || false,
      RoleExpert?.exists({ actor: id })        || false,
      RoleInvestor?.exists({ actor: id })      || false,
      RoleStudent?.exists({ actor: id })       || false,
    ]);

    const assignedRoles = []
      .concat(isBO ? ['businessOwner'] : [])
      .concat(isCO ? ['consultant']    : [])
      .concat(isEM ? ['employee']      : [])
      .concat(isEX ? ['expert']        : [])
      .concat(isIN ? ['investor']      : [])
      .concat(isST ? ['student']       : []);

    // Business profile presence (optional)
    let bp = { exists:false, id:null, status:null };
    if (BusinessProfile) {
      const bpDoc = await BusinessProfile.findOne({ actor: id }).select('_id status').lean().exec();
      if (bpDoc) bp = { exists:true, id:String(bpDoc._id), status: bpDoc.status || null };
    }

    res.json({
      ok: true,
      role: roleKey,
      actor: shaped,
      eventId: shaped.__ui?.eventId || '',
      assignedRoles,
      businessProfile: bp,
    });
  } catch (err) {
    console.error('readProfileCardV2 error:', err);
    res.status(500).json({ ok:false, message:'server error' });
  }
};

/**
 * PATCH profile (new name): patchProfileCardV2
 * body: { role, id, patch }
 * NOTE: We apply patch role-aware, but do not allow arbitrary $ operators by default.
 */
exports.patchProfileCardV2 = async function patchProfileCardV2(req, res) {
  try {
    const { role, id, patch } = req.body || {};
    if (!role) return res.status(400).json({ ok:false, message:'role is required' });
    if (!id   || !ensureObjectId(id)) {
      return res.status(400).json({ ok:false, message:'bad id' });
    }
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ ok:false, message:'patch is required' });
    }

    const { model, roleKey } = getModelByRole(role);
    if (!model) return res.status(400).json({ ok:false, message:'unsupported role' });

    // For safety, whitelist top-level paths per role
    const allowedPaths = (function() {
      switch (roleKey) {
        case 'attendee':
        case 'speaker':
          return [
            'personal.fullName','personal.email','personal.phone','personal.country','personal.city',
            'organization.orgName','organization.jobTitle','organization.businessRole',
            'links.website','links.linkedin',
            'matchingIntent.objective','matchingIntent.openToMeetings',
            'businessProfile.preferredLanguages','subRole','actorType',
            // any other safe leaf paths you want to allow
          ];
        case 'exhibitor':
          return [
            'identity.exhibitorName','identity.contactName','identity.email','identity.phone','identity.country','identity.city','identity.orgName',
            'business.industry','commercial.availableMeetings',
            'links.website','links.linkedin',
            'identity.preferredLanguages','subRole','actorType','actorHeadline',
          ];
        default: return [];
      }
    })();

    // Build $set only with whitelisted paths
    const $set = {};
    for (const [k, v] of Object.entries(patch)) {
      if (allowedPaths.includes(k)) $set[k] = v;
    }

    if (!Object.keys($set).length) {
      return res.status(400).json({ ok:false, message:'no allowed fields in patch' });
    }

    const updated = await model.findByIdAndUpdate(id, { $set }, { new:true, lean:true }).exec();
    if (!updated) return res.status(404).json({ ok:false, message:'not found' });

    res.json({ ok:true, actor: shapeActorForHeader(updated, roleKey) });
  } catch (err) {
    console.error('patchProfileCardV2 error:', err);
    res.status(500).json({ ok:false, message:'server error' });
  }
};

/**
 * Upload avatar/logo (new name): uploadProfileAvatarV2
 * multipart field: "file"; body: { role, id }
 * Attendee -> personal.profilePic
 * Speaker  -> enrichments.profilePic
 * Exhibitor-> identity.logo
 */
exports.uploadProfileAvatarV2 = async function uploadProfileAvatarV2(req, res) {
  try {
    const role = req.body?.role;
    const id   = req.body?.id;
    if (!role) return res.status(400).json({ ok:false, message:'role is required' });
    if (!id   || !ensureObjectId(id)) {
      return res.status(400).json({ ok:false, message:'bad id' });
    }
    if (!req.file) return res.status(400).json({ ok:false, message:'file is required' });

    // Save file — replace with your storage (S3, Cloudinary, etc.)
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const safeName = `${id}-${Date.now()}${ext}`;
    const outDir = path.join(process.cwd(), 'public', 'uploads', 'avatars');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, safeName);
    fs.writeFileSync(outPath, req.file.buffer);
    const publicUrl = `/uploads/avatars/${safeName}`;

    const { model, roleKey } = getModelByRole(role);
    if (!model) return res.status(400).json({ ok:false, message:'unsupported role' });

    let pathToSet = '';
    if (roleKey === 'attendee')  pathToSet = 'personal.profilePic';
    if (roleKey === 'speaker')   pathToSet = 'enrichments.profilePic';
    if (roleKey === 'exhibitor') pathToSet = 'identity.logo';

    const updated = await model.findByIdAndUpdate(
      id,
      { $set: { [pathToSet]: publicUrl } },
      { new:true, lean:true }
    ).exec();

    if (!updated) return res.status(404).json({ ok:false, message:'not found' });

    res.json({ ok:true, url: publicUrl, actor: shapeActorForHeader(updated, roleKey) });
  } catch (err) {
    console.error('uploadProfileAvatarV2 error:', err);
    res.status(500).json({ ok:false, message:'server error' });
  }
};
