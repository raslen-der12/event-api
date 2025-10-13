/**************************************************************************************************
 *  REQUEST-MEETING  (POST /meets)
 *  ----------------------------------------------------------------------------------------------
 *  Body: {
 *    eventId,                 // Event Mongo ID
 *    receiverId, receiverRole,// Who the sender wants to meet
 *    dateTimeISO,             // "2025-11-04T09:00:00.000Z" – UTC start of 30-min slot
 *    subject,                 // Required
 *    message                  // Optional
 *  }
 *  Preconditions
 *    • sender is logged-in (protect middleware sets req.user + req.user.role)
 *    • Both sender & receiver have their “open to meetings” flag = true.
 *    • dateTimeISO falls within event dates AND within receiver.availableDays (if defined).
 *    • Slot is not already occupied in meetSlotIndex for either actor.
 *  Result
 *    • meetRequest doc (status: 'pending')
 *    • E-mails: receiver gets an “Accept / Decline” link; sender gets a confirmation.
 **************************************************************************************************/

const asyncHandler   = require('express-async-handler');
const mongoose       = require('mongoose');
const bcrypt       = require('bcrypt'); // for compare if you store hashed tokens later
const { sendMail }   = require('../config/mailer');
const Agenda       = require('agenda');

const MeetRequest    = require('../models/meetRequest');
const SlotIndex      = require('../models/meetSoltIndex');
const Event          = require('../models/event');
const ical         = require('ical-generator'); 
const attendee  = require('../models/attendee');
const Exhibitor = require('../models/exhibitor');
const Speaker   = require('../models/speaker');
const BusinessProfile = require('../models/BusinessProfile');

/* ─────────────────── helper maps ──────────────────── */
const ROLE_MODEL = { attendee:attendee, exhibitor:Exhibitor, speaker:Speaker };
function getEmail(doc, role){
  switch(role){
    case 'attendee': return doc.personal.email;
    case 'speaker' : return doc.personal.email;
    case 'exhibitor':return doc.identity.email;
  }
}
function isOpenToMeetings(doc, role){
  switch(role){
    case 'attendee': return doc.matchingIntent?.openToMeetings ?? false;
    case 'speaker' : return doc.b2bIntent?.openMeetings       ?? false;
    case 'exhibitor':return doc.commercial?.availableMeetings ?? false;
  }
}
// Floor to 30-minute grid (UTC)
function floorTo30UTC(isoOrDate) {
  const d = new Date(isoOrDate);
  const step = 30 * 60 * 1000;
  const floored = Math.floor(d.getTime() / step) * step;
  const out = new Date(floored);
  out.setUTCSeconds(0, 0);
  return out;
}

// Build daily window from event start/end *time-of-day* (UTC).
// If unusable, fallback to 10:00–16:00 UTC.
function dailyWindowFromEvent(evStartDate, evEndDate, y, m, d) {
  const evS = new Date(evStartDate);
  const evE = new Date(evEndDate);
  let sh = evS.getUTCHours(), sm = evS.getUTCMinutes();
  let eh = evE.getUTCHours(), em = evE.getUTCMinutes();

  // Unusable or inverted window? fallback to 10–16
  const unusable = (eh < sh) || (eh === sh && em <= sm) || (sh === 0 && sm === 0 && eh === 0 && em === 0);
  if (unusable) { sh = 10; sm = 0; eh = 16; em = 0; }

  const start = Date.UTC(y, m - 1, d, sh, sm, 0, 0);
  const end   = Date.UTC(y, m - 1, d, eh, em, 0, 0);
  return { dayStartUTC: start, dayEndUTC: end };
}


const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const arr  = (v) => Array.isArray(v) ? v : [];
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const firstText = (...vals) => vals.find(v => text(v)) || '';


exports.getMeetingPrefs = async (req, res) => {
  try {
    const {  actorId :id } = req.params;
    if (!isId(id)) return res.status(400).json({ success:false, error:'Invalid id' });

    // 1) Find the legacy document (speaker | exhibitor | attendee)
    const [sp, ex, at] = await Promise.all([
      Speaker.findById(id).lean().catch(()=>null),
      Exhibitor.findById(id).lean().catch(()=>null),
      attendee.findById(id).lean().catch(()=>null),
    ]);

    const doc  = sp || ex || at || null;
    const role = sp ? 'speaker' : ex ? 'exhibitor' : at ? 'attendee' : null;
    if (!doc) return res.json({ success:true, data:{ language:'', sector:'', offering:'', lookingFor:'', role:null }});

    // 2) BusinessProfile (owner mapping is not always consistent, so be liberal)
    const bp = await BusinessProfile.findOne({
      $or: [
        { 'owner.actor': id },
        { ownerId: id },
        { owner: id },
        { createdBy: id },
      ]
    }).lean().catch(()=>null);

    // 3) Map fields by role (fallback to anything we have)
    let language = '';
    let sector   = '';
    let offering = '';
    let lookingFor = '';

    if (role === 'speaker') {
      const talk = doc.talk || {};
      const intent = doc.b2bIntent || {};
      // language is required at registration (speaker may store in talk.language or preferredLanguages)
      language = firstText(
        arr(doc?.personal?.preferredLanguages)[0],
        talk.language,
        arr(intent.preferredLanguages)[0],
        intent.language
      );

      // sector: try BP first, then talk/topics or generic
      sector = firstText(
        // BusinessProfile
        (bp?.primaryIndustry && bp?.subIndustry) ? `${bp.primaryIndustry} / ${bp.subIndustry}` : null,
        arr(bp?.industries)?.length ? bp.industries.join(', ') : '',
        // speaker-ish
        arr(talk?.topics)?.length ? talk.topics.join(', ') : ''
      );

      // offering / seeking
      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(', ') : '',
        talk.offering,
        intent.offering
      );
      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(', ') : '',
        intent.lookingFor
      );
    }

    if (role === 'exhibitor') {
      const idt = doc.identity || {};
      const com = doc.commercial || {};
      // language
      language = firstText(
        arr(com?.preferredLanguages)[0],
        com.language,
        arr(doc?.personal?.preferredLanguages)[0]
      );

      // sector: prefer BP
      sector = firstText(
        (bp?.primaryIndustry && bp?.subIndustry) ? `${bp.primaryIndustry} / ${bp.subIndustry}` : null,
        arr(bp?.industries)?.length ? bp.industries.join(', ') : '',
        (idt.industry && idt.subIndustry) ? `${idt.industry} / ${idt.subIndustry}` : idt.industry
      );

      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(', ') : '',
        com.offering
      );
      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(', ') : '',
        com.lookingFor
      );
    }

    if (role === 'attendee') {
      const bpAtt = doc.businessProfile || {};
      const mi    = doc.matchingIntent || {};
      const aids  = doc.matchingAids || {};
      // language is required at registration for attendees (matchingAids.language or personal.preferredLanguages)
      language = firstText(
        aids.language,
        arr(doc?.personal?.preferredLanguages)[0]
      );

      sector = firstText(
        (bp?.primaryIndustry && bp?.subIndustry) ? `${bp.primaryIndustry} / ${bp.subIndustry}` : null,
        arr(bp?.industries)?.length ? bp.industries.join(', ') : '',
        (bpAtt?.primaryIndustry && bpAtt?.subIndustry) ? `${bpAtt.primaryIndustry} / ${bpAtt.subIndustry}` : bpAtt?.primaryIndustry
      );

      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(', ') : '',
        mi.offering
      );

      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(', ') : '',
        (arr(mi?.objectives)?.length ? mi.objectives.join(', ') : ''),
        mi.needs
      );
    }

    // 4) Return
    return res.json({
      success: true,
      data: {
        role,
        language: language || '',
        sector: sector || '',
        offering: offering || '',
        lookingFor: lookingFor || ''
      }
    });
  } catch (err) {
    console.error('getMeetingPrefs error:', err);
    return res.status(500).json({ success:false, error:'Server error' });
  }
};
/* 30-min slot normaliser */
function normalizeToUTC(dt) {
  if (dt instanceof Date) {
    // Keep the same wall time but return a UTC date
    return new Date(Date.UTC(
      dt.getFullYear(), dt.getMonth(), dt.getDate(),
      dt.getHours(), dt.getMinutes(), 0, 0
    ));
  }

  const s = String(dt || "");

  // If timezone is specified (Z or ±HH:MM), trust it
  if (/[zZ]$|[+\-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return d;
  }

  // If it's a plain "YYYY-MM-DDTHH:mm" (or with :ss) treat as **UTC** (no shift)
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (m) {
    return new Date(Date.UTC(
      +m[1], +m[2] - 1, +m[3],
      +m[4], +m[5], +(m[6] || 0), 0
    ));
  }

  // Fallback: parse as Date then preserve wall time in UTC
  const d = new Date(s);
  return new Date(Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), 0, 0
  ));
}

function slotKey(dateTimeISO) {
  const d = normalizeToUTC(dateTimeISO);
  // snap to nearest :00 or :30 without changing hour
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins < 30 ? 0 : 30);
  // minute precision canonical ISO
  return d.toISOString().slice(0, 19) + 'Z';
}
/* ─────────────────── CREATE REQUEST ───────────────── */
function floorTo30UTC(isoOrDate) {
  const d = new Date(isoOrDate);
  const ms = d.getTime();
  const step = 30 * 60 * 1000;
  const floored = Math.floor(ms / step) * step;
  const out = new Date(floored);
  out.setUTCSeconds(0, 0);
  return out;
}
exports.requestMeeting = asyncHandler(async (req, res) => {
  const { eventId, receiverId, receiverRole, dateTimeISO, subject, message = '' } = req.body;

  if (!eventId || !receiverId || !receiverRole || !dateTimeISO || !subject)
    return res.status(400).json({ message:'Missing required fields' });
  if (!mongoose.isValidObjectId(eventId) || !mongoose.isValidObjectId(receiverId))
    return res.status(400).json({ message:'Bad IDs' });
  if (!['attendee','exhibitor','speaker'].includes(receiverRole))
    return res.status(400).json({ message:'Unknown receiverRole' });

  const senderId   = req.user._id;
  const senderRole = req.user.role;
  if (senderId.toString() === receiverId && senderRole === receiverRole)
    return res.status(400).json({ message:'Cannot book meeting with yourself' });

  const event = await Event.findById(eventId).lean();
  if (!event) return res.status(404).json({ message:'Event not found' });

  // Calendar bounds in UTC (by day)
  const evS = new Date(event.startDate), evE = new Date(event.endDate);
  const calStartUTC = Date.UTC(evS.getUTCFullYear(), evS.getUTCMonth(), evS.getUTCDate());
  const calEndUTC   = Date.UTC(evE.getUTCFullYear(), evE.getUTCMonth(), evE.getUTCDate());

  // Normalize to 30-min grid (UTC)
  const slotStart = floorTo30UTC(dateTimeISO);
  const slotISO   = slotStart.toISOString();
  const slotDayUTC = Date.UTC(slotStart.getUTCFullYear(), slotStart.getUTCMonth(), slotStart.getUTCDate());
  if (slotDayUTC < calStartUTC || slotDayUTC > calEndUTC)
    return res.status(400).json({ message:'Slot day outside event' });

  // Daily window from event times
  const { dayStartUTC, dayEndUTC } = dailyWindowFromEvent(
    event.startDate, event.endDate,
    slotStart.getUTCFullYear(), slotStart.getUTCMonth()+1, slotStart.getUTCDate()
  );
  if (slotStart.getTime() < dayStartUTC || slotStart.getTime() >= dayEndUTC)
    return res.status(409).json({ message:'Requested time outside daily window' });

  // Fetch actors & openness
  const SenderModel   = ROLE_MODEL[senderRole];
  const ReceiverModel = ROLE_MODEL[receiverRole];
  const [senderDoc, receiverDoc] = await Promise.all([
    SenderModel.findById(senderId).lean(),
    ReceiverModel.findById(receiverId).lean()
  ]);
  if (!receiverDoc) return res.status(404).json({ message:'Receiver not found' });
  if (!isOpenToMeetings(receiverDoc, receiverRole))
    return res.status(409).json({ message:'Receiver is not open to meetings' });
  if (!isOpenToMeetings(senderDoc, senderRole))
    return res.status(409).json({ message:'You are not open to meetings (edit profile to enable)' });

  // Receiver availableDays check (if any)
  const availDays = receiverDoc.matchingIntent?.availableDays || [];
  if (availDays.length) {
    const ymd = slotISO.slice(0,10);
    const ok = availDays.some(d => {
      try { return new Date(d).toISOString().slice(0,10) === ymd; } catch { return false; }
    });
    if (!ok) return res.status(409).json({ message:'Receiver unavailable that day' });
  }

  // 🔒 Clash check across BOTH participants for PENDING/ACCEPTED/RESCHEDULE
  const statuses = ['pending', 'accepted', 'reschedule-proposed'];
  const conflict = await MeetRequest.findOne({
    eventId,
    status: { $in: statuses },
    $and: [
      { $or: [
        { senderId: senderId }, { receiverId: senderId },
        { senderId: receiverId }, { receiverId: receiverId }
      ]},
      { $or: [
        { requestedAt:   slotStart },   // exact 30-min stamp
        { proposedNewAt: slotStart }
      ]}
    ]
  }).lean();
  if (conflict) return res.status(409).json({ message:'Slot already held by another request/meeting' });

  // (Still keep accepted locks check for safety)
  const acceptedLock = await SlotIndex.findOne({
    eventId,
    actorId: { $in: [ senderId, receiverId ] },
    slotISO: slotISO
  }).lean();
  if (acceptedLock) return res.status(409).json({ message:'Slot already booked' });

  // Create request (pending)
  const reqDoc = await MeetRequest.create({
    eventId,
    senderId, senderRole,
    receiverId, receiverRole,
    subject, message,
    requestedAt : slotStart,
    status      : 'pending',
    history     : [{ actorId: senderId, action:'sent', note: slotISO }]
  });

  // ───────── Emails (same as before) ─────────
  const nameOf = (doc, role) => role==='exhibitor'
      ? (doc?.identity?.exhibitorName || doc?.identity?.orgName || 'Exhibitor')
      : (doc?.personal?.fullName || 'User');
  const emailOf = (doc, role) => role==='exhibitor' ? doc?.identity?.email : doc?.personal?.email;

  const senderName   = nameOf(senderDoc, senderRole);
  const receiverName = nameOf(receiverDoc, receiverRole);
  const senderEmail  = emailOf(senderDoc, senderRole);
  const receiverEmail= emailOf(receiverDoc, receiverRole);

  const whenPretty = new Intl.DateTimeFormat('en-US', {
    dateStyle:'full', timeStyle:'short', hour12:false, timeZone:'UTC'
  }).format(slotStart);

  const appBase = process.env.FRONTEND_URL?.replace(/\/+$/,'') || 'https://app.example.com';
  const meetingsLink = `${appBase}/meetings`;

  await Promise.all([
    sendMail(
      receiverEmail,
      'New meeting request',
      `
        <p><strong>${senderName}</strong> wants to meet you.</p>
        <p><strong>When:</strong> ${whenPretty} (UTC)</p>
        <p><strong>Subject:</strong> ${subject}</p>
        ${message ? `<p><strong>Message:</strong> ${String(message).slice(0,1000)}</p>` : ''}
        <p>Manage requests in the app: <a href="${meetingsLink}">${meetingsLink}</a></p>
      `
    ),
    sendMail(
      senderEmail,
      'Your meeting request was sent',
      `
        <p>You requested a meeting with <strong>${receiverName}</strong>.</p>
        <p><strong>When:</strong> ${whenPretty} (UTC)</p>
        <p><strong>Subject:</strong> ${subject}</p>
        ${message ? `<p><strong>Message:</strong> ${String(message).slice(0,1000)}</p>` : ''}
        <p>Track it here: <a href="${meetingsLink}">${meetingsLink}</a></p>
      `
    )
  ]);

  return res.status(201).json({ success:true, data:{ requestId: reqDoc._id, status:'pending' } });
});




/* helper: email + name fetch */
function getMeta(doc, role){
  return {
    email : role==='exhibitor' ? doc.identity.email : doc.personal.email,
    name  : role==='exhibitor' ? doc.identity.exhibitorName : doc.personal.fullName
  };
}

/* helper: insert SlotIndex for both actors, catching race */
async function lockSlot(eventId, actorIds, slotISO){
  const docs = actorIds.map(id=>({ eventId, actorId:id, slotISO }));
  try {
    await SlotIndex.insertMany(docs, { ordered:false });
  } catch(e){
    if (e.code === 11000) throw new Error('Slot has just been taken');
    throw e;
  }
}

/* ───────────────────────── ACCEPT ─────────────────────────────── */
exports.acceptMeeting = asyncHandler(async (req,res)=>{
  const { id } = req.params;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message:'Not found' });

  /* permissions */
  const IamSender   = meet.senderId.toString()   === meId && meet.senderRole===meRole;
  const IamReceiver = meet.receiverId.toString() === meId && meet.receiverRole===meRole;

  /* Valid transitions */
  if (meet.status==='pending' && !IamReceiver)
    return res.status(403).json({ message:'Only receiver can accept initial request' });
  if (meet.status==='reschedule-proposed' && !IamSender)
    return res.status(403).json({ message:'Only original sender can accept new slot' });
  if (!['pending','reschedule-proposed'].includes(meet.status))
    return res.status(400).json({ message:`Cannot accept from status ${meet.status}` });

  /* Choose slot */
  const finalISO = slotKey(meet.status==='pending' ? meet.requestedAt : meet.proposedNewAt);
  const finalDate= new Date(finalISO);

  /* Check event bounds & lock slot */
  const event = await Event.findById(meet.eventId).lean();
  if (finalDate < event.startDate || finalDate > event.endDate)
    return res.status(400).json({ message:'Date outside event' });

  await lockSlot(meet.eventId, [meet.senderId, meet.receiverId], finalISO);

  /* Update meet doc */
  meet.status      = 'accepted';
  meet.acceptedAt  = finalDate;
  meet.requestedAt = finalDate;        // store actual final slot
  meet.proposedNewAt = undefined;
  meet.history.push({ actorId:meId, action:'accepted', note:finalISO });
  await meet.save();
  await exports.scheduleMeetingReminder(meet);
  /* Notify both parties */
  const [senderDoc, receiverDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean()
  ]);
  const s = getMeta(senderDoc, meet.senderRole);
  const r = getMeta(receiverDoc, meet.receiverRole);

  await Promise.all([
    sendMail(s.email, 'Meeting confirmed', `
      <p>Your meeting with ${r.name} has been confirmed for ${finalDate.toUTCString()}.</p>`),
    sendMail(r.email, 'Meeting confirmed', `
      <p>Your meeting with ${s.name} has been confirmed for ${finalDate.toUTCString()}.</p>`)
  ]);

  res.json({ success:true, message:'Meeting accepted', data:{ status:'accepted', at:finalISO } });
});

/* ───────────────────────── DECLINE ─────────────────────────────── */
exports.declineMeeting = asyncHandler(async (req,res)=>{
  const { id } = req.params;
  const meId   = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message:'Not found' });

  const IamSender   = meet.senderId.toString()   === meId && meet.senderRole===meRole;
  const IamReceiver = meet.receiverId.toString() === meId && meet.receiverRole===meRole;

  const canDecline = (meet.status==='pending'   && IamReceiver) ||
                     (meet.status==='reschedule-proposed' && IamSender) ||
                     (meet.status==='accepted' && (IamSender||IamReceiver));
  if (!canDecline) return res.status(403).json({ message:'Cannot decline in this state' });

  const prevStatus = meet.status;
  meet.status = 'declined';
  meet.history.push({ actorId:meId, action:'declined', note:prevStatus });
  await meet.save();

  /* If previously accepted, free slot */
  if (prevStatus === 'accepted'){
    await SlotIndex.deleteMany({ eventId:meet.eventId, actorId:{ $in:[ meet.senderId, meet.receiverId ] }, slotISO:slotKey(meet.requestedAt) });
  }

  /* Notify both */
  const [sDoc, rDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean()
  ]);
  await Promise.all([
    sendMail(getMeta(sDoc,meet.senderRole).email, 'Meeting declined', 'One of the parties has declined the meeting.'),
    sendMail(getMeta(rDoc,meet.receiverRole).email, 'Meeting declined', 'Meeting has been declined.')
  ]);

  res.json({ success:true, message:'Declined' });
});

/* ───────────────────────── PROPOSE NEW TIME (receiver) ──────────── */
exports.proposeNewTime = asyncHandler(async (req,res)=>{
  const { id } = req.params;
  const { dateTimeISO } = req.body;
  const meId   = req.user._id.toString();
  const meRole = req.user.role;

  if (!dateTimeISO) return res.status(400).json({ message:'dateTimeISO required' });

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message:'Not found' });
  if (meet.status!=='pending')
    return res.status(400).json({ message:'Only pending requests can be rescheduled' });

  const IamReceiver = meet.receiverId.toString() === meId && meet.receiverRole===meRole;
  if (!IamReceiver) return res.status(403).json({ message:'Only receiver can propose new time' });

  /* validate slot inside event & clash-free for both actors */
  const slotISO = slotKey(dateTimeISO);
  const slotDate= new Date(slotISO);
  const event   = await Event.findById(meet.eventId).lean();
  if (slotDate < event.startDate || slotDate > event.endDate)
    return res.status(400).json({ message:'Slot outside event dates' });

  const clash = await SlotIndex.findOne({
    eventId:meet.eventId,
    actorId:{ $in:[ meet.senderId, meet.receiverId ] },
    slotISO
  }).lean();
  if (clash) return res.status(409).json({ message:'One of you is busy at that time' });

  /* update meet */
  meet.status        = 'reschedule-proposed';
  meet.proposedNewAt = slotDate;
  meet.history.push({ actorId:meId, action:`proposed:${slotISO}` });
  await meet.save();

  /* notify sender */
  const senderDoc = await ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean();
  const receiverDoc = await ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean();

  const acceptNew = `${process.env.FRONTEND_URL}/meets/${meet._id}?action=confirm`;
  const declineNew= `${process.env.FRONTEND_URL}/meets/${meet._id}?action=decline`;

  await sendMail(
    getMeta(senderDoc, meet.senderRole).email,
    'New time proposed for meeting',
    `<p>${getMeta(receiverDoc, meet.receiverRole).name} proposed ${slotDate.toUTCString()}.</p>
     <a href="${acceptNew}">Accept</a> | <a href="${declineNew}">Decline</a>`
  );

  res.json({ success:true, message:'New time proposed', data:{ status:'reschedule-proposed', proposedAt:slotISO } });
});

/* ───────────────────────── CONFIRM PROPOSED NEW TIME ─────────────── */
exports.confirmReschedule = exports.acceptMeeting;  // same logic as acceptMeeting





exports.getMyMeetings = asyncHandler(async (req, res) => {
  const { eventId, status } = req.query;
  const meId   = req.user._id;
  const meRole = req.user.role;

  const q = {
    eventId,
    $or: [
      { senderId:meId,   senderRole:meRole },
      { receiverId:meId, receiverRole:meRole }
    ]
  };
  if (status) q.status = status;

  const rows = await MeetRequest.find(q).sort({ requestedAt:1 }).lean();
  res.json({ success:true, count:rows.length, data:rows });
});

/* ─────────────────────── GET /meets/agenda/:actorId ────────────────
 *  Admin helper to view any participant’s agenda
 */
exports.listActorAgenda = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message:'Admin only' });

  const { actorId } = req.params;
  const { eventId, status } = req.query;
  if (!mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message:'Bad actorId' });

  const q = {
    eventId,
    $or:[ { senderId:actorId }, { receiverId:actorId } ]
  };
  if (status) q.status = status;

  const rows = await MeetRequest.find(q).sort({ requestedAt:1 }).lean();
  res.json({ success:true, count:rows.length, data:rows });
});

/* ───────────────────── GET /events/:eventId/available-slots ───────
 *  Checks 09:00-17:00 (inclusive) in 30-min steps for a given date.
 *  Needs ?actorId=receiverId&date=YYYY-MM-DD
 */
function pad2(n){ return String(n).padStart(2, '0'); }
function toLocalIso(Y, M /*0-based*/, D, h, m){
  return `${Y}-${pad2(M+1)}-${pad2(D)}T${pad2(h)}:${pad2(m)}:00`;
}

// ───────────────────── GET /events/:eventId/available-slots ───────
// Query: ?actorId=<receiverId>&date=YYYY-MM-DD// GET /events/:eventId/available-slots?actorId=<receiverId>&date=YYYY-MM-DD
// GET /events/:eventId/available-slots?actorId=<receiverId>&date=YYYY-MM-DD
exports.listAvailableSlots = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { actorId, date } = req.query;
  const senderId = req.user._id;

  if (!actorId || !date) return res.status(400).json({ message: 'actorId and date required' });
  if (!mongoose.isValidObjectId(actorId)) return res.status(400).json({ message: 'Bad actorId' });

  const event = await Event.findById(eventId).lean();
  if (!event) return res.status(404).json({ message: 'Event not found' });

  // Check calendar day within event days (UTC-by-day)
  const evS = new Date(event.startDate), evE = new Date(event.endDate);
  const calStartUTC = Date.UTC(evS.getUTCFullYear(), evS.getUTCMonth(), evS.getUTCDate());
  const calEndUTC   = Date.UTC(evE.getUTCFullYear(), evE.getUTCMonth(), evE.getUTCDate());
  const day = new Date(`${date}T00:00:00.000Z`);
  const dayUTC = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  if (dayUTC < calStartUTC || dayUTC > calEndUTC)
    return res.status(400).json({ message: 'Date outside event' });

  const { dayStartUTC, dayEndUTC } = dailyWindowFromEvent(
    event.startDate, event.endDate,
    day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()
  );
  const dayStartISO = new Date(dayStartUTC).toISOString();
  const dayEndISO   = new Date(dayEndUTC).toISOString();

  // 1) Busy from ACCEPTED locks (SlotIndex)
  const acceptedLocks = await SlotIndex.find({
    eventId,
    actorId: { $in: [senderId, actorId] }, // either participant
    slotISO: { $gte: dayStartISO, $lt: dayEndISO }
  }).lean();

  // 2) Busy from MeetRequest in statuses pending/accepted/reschedule-proposed
  const statuses = ['pending', 'accepted', 'reschedule-proposed'];
  const pendingReqs = await MeetRequest.find({
    eventId,
    status: { $in: statuses },
    $and: [
      { $or: [
        { senderId: senderId }, { receiverId: senderId },
        { senderId: actorId  }, { receiverId: actorId  }
      ]},
      { $or: [
        { requestedAt : { $gte: new Date(dayStartUTC), $lt: new Date(dayEndUTC) } },
        { proposedNewAt: { $gte: new Date(dayStartUTC), $lt: new Date(dayEndUTC) } }
      ]}
    ]
  }).lean();

  const busy = new Set([
    ...acceptedLocks.map(b => b.slotISO),
    ...pendingReqs.flatMap(r => {
      const out = [];
      if (r.requestedAt)   out.push(new Date(r.requestedAt).toISOString());
      if (r.proposedNewAt) out.push(new Date(r.proposedNewAt).toISOString());
      return out;
    })
  ]);

  // Generate 30-min grid and filter out busy
  const slots = [];
  for (let t = dayStartUTC; t < dayEndUTC; t += 30 * 60000) {
    const iso = new Date(t).toISOString();
    if (!busy.has(iso)) slots.push(iso);
  }

  return res.json({ success: true, count: slots.length, data: slots });
});



exports.cancelMeeting = asyncHandler(async (req, res) => {
  const { id }  = req.params;
  const meId    = req.user._id.toString();
  const meRole  = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message:'Meeting not found' });
  if (meet.status !== 'accepted')
    return res.status(400).json({ message:'Only accepted meetings can be cancelled' });

  const IamParticipant =
        (meet.senderId.toString()   === meId && meet.senderRole===meRole) ||
        (meet.receiverId.toString() === meId && meet.receiverRole===meRole);
  const isAdmin = meRole === 'admin';
  if (!IamParticipant && !isAdmin)
    return res.status(403).json({ message:'Not allowed' });

  /* remove slot lock */
  await SlotIndex.deleteMany({
    eventId: meet.eventId,
    actorId: { $in:[ meet.senderId, meet.receiverId ] },
    slotISO: slotKey(meet.requestedAt)
  });

  meet.status = 'cancelled';
  meet.history.push({ actorId:meId, action:'cancelled' });
  await meet.save();

  /* notify */
  const [sDoc, rDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean()
  ]);
  const emailOf = (doc, role) =>
    role==='exhibitor' ? doc.identity.email : doc.personal.email;

  await Promise.all([
    sendMail(emailOf(sDoc,meet.senderRole), 'Meeting cancelled',
      `Your meeting scheduled for ${meet.requestedAt.toUTCString()} has been cancelled.`),
    sendMail(emailOf(rDoc,meet.receiverRole), 'Meeting cancelled',
      `Your meeting scheduled for ${meet.requestedAt.toUTCString()} has been cancelled.`)
  ]);

  res.json({ success:true, message:'Meeting cancelled' });
});

/* ───────────────────────── 2. .ics download ──────────────────────── */
exports.getMeetingICS = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const meId   = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message:'Meeting not found' });
  if (meet.status!=='accepted')
    return res.status(400).json({ message:'ICS available only for accepted meetings' });

  const IamParticipant =
        (meet.senderId.toString()   === meId && meet.senderRole===meRole) ||
        (meet.receiverId.toString() === meId && meet.receiverRole===meRole);
  const isAdmin = meRole === 'admin';
  if (!IamParticipant && !isAdmin)
    return res.status(403).json({ message:'Not allowed' });

  const event = await Event.findById(meet.eventId).lean();

  const cal = ical({ name:`Meeting @ ${event.title}` });
  cal.createEvent({
    id      : meet._id.toString(),
    start   : meet.requestedAt,
    end     : new Date(new Date(meet.requestedAt).getTime()+30*60*1000),
    summary : meet.subject,
    description:`B2B Meeting – ${meet.subject}`,
    location: `${event.title} venue`,
    status  : 'CONFIRMED'
  });

  res.setHeader('Content-Type','text/calendar');
  res.setHeader('Content-Disposition',`attachment; filename="meeting_${id}.ics"`);
  res.send(cal.toString());
});




const JOB_NAME = 'meeting:remind';
let   agenda;                         // Agenda instance shared by all modules

/* ───────────────────── init – call from server.js ────────────────── */
exports.initMeetingReminderEngine = (app) => {
  if (agenda) return;                // avoid double-init in dev hot-reload
  agenda = new Agenda({
    db : { address: process.env.REMINDER_DB_URI,
           collection: 'agendaJobs' }
  });

  /* define once */
  agenda.define(JOB_NAME, async (job) => {
    const { meetingId } = job.attrs.data;
    const meet = await MeetRequest.findById(meetingId).lean();
    if (!meet || meet.status !== 'accepted') return job.remove();      // no longer valid

    const event = await Event.findById(meet.eventId).lean();
    if (!event) return job.remove();

    const [sDoc, rDoc] = await Promise.all([
      ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
      ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean()
    ]);
    const emailOf = (doc, role) =>
      role==='exhibitor' ? doc.identity.email : doc.personal.email;

    await Promise.all([
      sendMail(emailOf(sDoc,meet.senderRole),
        `Reminder: your meeting in 1 hour`,
        `<p>This is a reminder: <strong>${meet.subject}</strong><br/>
         Time: ${new Date(meet.requestedAt).toUTCString()}</p>`),
      sendMail(emailOf(rDoc,meet.receiverRole),
        `Reminder: your meeting in 1 hour`,
        `<p>This is a reminder for your meeting with
         ${sDoc.personal?.fullName || sDoc.identity?.exhibitorName}.<br/>
         Time: ${new Date(meet.requestedAt).toUTCString()}</p>`)
    ]);
  });

  agenda.on('ready', () => agenda.start());
  app.locals.agenda = agenda;
};

/* ────────────────── helper to schedule one reminder ──────────────── */
exports.scheduleMeetingReminder = async (meetDoc) => {
  if (!agenda) return;                       // ensure init called

  /* Fire 60 min before meeting start */
  const runAt = new Date(new Date(meetDoc.requestedAt).getTime() - 60*60*1000);
  if (runAt <= Date.now()) return;           // meeting in < 1h : skip

  await agenda.create(JOB_NAME, { meetingId: meetDoc._id })
              .unique({ 'data.meetingId': meetDoc._id })
              .schedule(runAt)
              .save();
};

/* ─────────────── GET /meets/reminders/:eventId (admin) ───────────── */
exports.listMeetingReminders = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message:'Admin only' });

  const { eventId } = req.params;
  if (!agenda) return res.status(500).json({ message:'Reminder engine not running' });

  const jobs = await agenda.jobs({ name:JOB_NAME, 'data.eventId':eventId });
  const rows = jobs.map(j => ({
    jobId   : j.attrs._id,
    meetingId : j.attrs.data.meetingId,
    runAt   : j.attrs.nextRunAt
  }));
  res.json({ success:true, count:rows.length, data:rows });
});
exports.checkMeetingExist = asyncHandler(async (req, res) => {
  const { senderId , receiverId } = req.body || {};

  if (!senderId) return res.status(401).json({ message: 'Unauthorized' });
  if (!receiverId || !mongoose.isValidObjectId(receiverId))
    return res.status(400).json({ message: 'Bad receiverId' });

  // Find any latest request between the two, regardless of direction
  const doc = await MeetRequest.findOne({
    $or: [
      { senderId,   receiverId },
      { senderId: receiverId, receiverId: senderId }
    ]
  })
  .sort({ updatedAt: -1, createdAt: -1 })
  .lean();

  if (!doc) return res.json({ success: true, exist: 'no' });

  const st = String(doc.status || '').toLowerCase();

  // Map to the requested buckets:
  // - "yes"     → accepted (confirmed)
  // - "pending" → pending or reschedule-proposed
  // - "refused" → declined or cancelled
  // Fallback: treat unknown but present as "pending".
  let exist = 'pending';
  if (st === 'accepted') exist = 'yes';
  else if (st === 'pending' || st === 'reschedule-proposed') exist = 'pending';
  else if (st === 'declined' || st === 'cancelled') exist = 'refused';

  return res.json({ success: true, exist });
});