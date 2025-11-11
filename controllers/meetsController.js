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

const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt"); // for compare if you store hashed tokens later
const { sendMail } = require("../config/mailer");
const Agenda = require("agenda");
const MeetRequest = require("../models/meetRequest");
const SlotIndex = require("../models/meetSoltIndex");
const MeetingSlot = require("../models/MeetingSlot");
const Event = require("../models/event");
const ical = require("ical-generator");
const attendee = require("../models/attendee");
const Exhibitor = require("../models/exhibitor");
const Speaker = require("../models/speaker");
const BusinessProfile = require("../models/BusinessProfile");
const Schedule = require("../models/eventModels/schedule");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const HybridMeetingSlot = require("../models/HybridMeetingSlot");
const MeetingTableCounter = require("../models/MeetingTableCounter");
const SlotWhitelist = require("../models/SlotWhitelist");
/* ─────────────────── helper maps ──────────────────── */
const SessionRegistration = require("../models/sessionRegistration"); // path as in your app
const { Types } = require("mongoose");
const EventSchedule = require("../models/eventModels/schedule");
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MeetingAttendance =
  mongoose.models.MeetingAttendance ||
  mongoose.model(
    "MeetingAttendance",
    new mongoose.Schema(
      {
        eventId: { type: mongoose.Schema.Types.ObjectId, index: true },
        meetingId: { type: mongoose.Schema.Types.ObjectId, index: true },
        actorId: { type: mongoose.Schema.Types.ObjectId, index: true },
        kind: { type: String, enum: ["physical", "virtual"], required: true },
        attended: { type: Boolean, default: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId }, // admin user
      },
      { collection: "meeting_attendance" }
    )
  );

const EventCheckin =
  mongoose.models.eventCheckin ||
  mongoose.model(
    "eventCheckin",
    new mongoose.Schema(
      {
        eventId: { type: Types.ObjectId, index: true, required: true },
        actorId: { type: Types.ObjectId, index: true, required: true },
        actorRole: {
          type: String,
          enum: ["attendee", "exhibitor", "speaker", "admin"],
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: Types.ObjectId, index: true },
      },
      { versionKey: false, timestamps: false }
    )
  );

const SessionAttendance =
  mongoose.models.sessionAttendance ||
  mongoose.model(
    "sessionAttendance",
    new mongoose.Schema(
      {
        sessionId: { type: Types.ObjectId, index: true, required: true },
        eventId: { type: Types.ObjectId, index: true, required: true },
        actorId: { type: Types.ObjectId, index: true, required: true },
        actorRole: {
          type: String,
          enum: ["attendee", "exhibitor", "speaker", "admin"],
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: Types.ObjectId, index: true },
      },
      { versionKey: false, timestamps: false }
    )
  );
  const FeedbackPrompt = mongoose.models.FeedbackPrompt || mongoose.model(
  'FeedbackPrompt',
  new mongoose.Schema({
    eventId : { type: mongoose.Schema.Types.ObjectId, ref: 'event', index: true },
    kind    : { type: String, enum: ['meet','session','event'], required: true, index: true },
    refId   : { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, // meetId/sessionId/eventId
    actorId : { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    role    : { type: String, enum: ['attendee','exhibitor','speaker','admin'], required: true },

    dueAt   : { type: Date, required: true, index: true },
    status  : { type: String, enum: ['pending','shown','completed','expired'], default: 'pending', index: true },
    shownAt : { type: Date },
    completedAt: { type: Date },

    // dedupe safety (one prompt per ref per actor)
  }, { timestamps: true })
    .index({ kind:1, refId:1, actorId:1 }, { unique: true })
);

const FeedbackResponse = mongoose.models.FeedbackResponse || mongoose.model(
  'FeedbackResponse',
  new mongoose.Schema({
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedbackPrompt', required: true, index: true },
    eventId : { type: mongoose.Schema.Types.ObjectId, ref: 'event', index: true },
    kind    : { type: String, enum: ['meet','session','event'], required: true, index: true },
    refId   : { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    actorId : { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    role    : { type: String, enum: ['attendee','exhibitor','speaker','admin'], required: true },

    stars   : { type: Number, min:1, max:5, required: true },
    comment : { type: String, trim: true, maxlength: 1000 },
  }, { timestamps: true })
);


function resolveActorModel(role) {
  switch (String(role || "").toLowerCase()) {
    case "attendee":
      return attendee;
    case "exhibitor":
      return Exhibitor;
    case "speaker":
      return Speaker;
    default:
      return null;
  }
}

const STEP_MS = 30 * 60 * 1000;
const norm30 = (dLike) => {
  const t = (dLike instanceof Date ? dLike : new Date(dLike)).getTime();
  const aligned = Math.floor(t / STEP_MS) * STEP_MS;
  return new Date(aligned);
};
const iso = (d) => new Date(d).toISOString();
const toSetISO = (arr) => new Set((arr || []).map(iso));

const ROLE_MODEL = {
  attendee: attendee,
  exhibitor: Exhibitor,
  speaker: Speaker,
};

// === PATCH START: helpers for virtual/hybrid/physical + timezone formatting ===
function isVirtualDoc(doc) {
  return !!(doc && (doc.virtualMeet === true || doc.virtualMeet === "true"));
}
function meetingModeFromDocs(senderDoc, receiverDoc) {
  const sV = isVirtualDoc(senderDoc);
  const rV = isVirtualDoc(receiverDoc);
  if (sV && rV) return "virtual";
  if (sV !== rV) return "hybrid";
  return "physical";
}

// localize a Date (or ISO) using event timezone to a human string
function fmtTZ(dt, tz, opts) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.toLocaleString(undefined, { timeZone: tz || "UTC", ...opts });
}
function fmtTZDate(dt, tz) {
  return fmtTZ(dt, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
}
function fmtTZTime(dt, tz) {
  return fmtTZ(dt, tz, { hour: "2-digit", minute: "2-digit", hour12: false });
}
// === PATCH END: helpers for virtual/hybrid/physical + timezone formatting ===

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === "string" ? v.trim() : "");
const firstText = (...vals) => vals.find((v) => text(v)) || "";
exports.listEventSessionsMini = asyncHandler(async (req, res) => {
  const eventId = req.params.eventId || req.query.eventId;
  const search = (req.query.search || "").trim();
  if (!mongoose.isValidObjectId(eventId)) {
    return res.status(400).json({ message: "Bad eventId" });
  }

  const q = { id_event: new mongoose.Types.ObjectId(eventId) };
  if (search) q.sessionTitle = { $regex: escapeRx(search), $options: "i" };

  const docs = await EventSchedule.find(q)
    .select("_id sessionTitle startTime endTime room roomId track")
    .sort({ startTime: 1, _id: 1 })
    .lean();

  const data = docs.map((d) => ({
    _id: String(d._id),
    title: d.sessionTitle || "Session",
    startAt: d.startTime || null,
    endAt: d.endTime || null,
    room: d.room || null,
    roomId: d.roomId || null,
    track: d.track || "",
  }));

  return res.json({ success: true, count: data.length, data });
});
exports.getMeetingPrefs = async (req, res) => {
  try {
    const { actorId: id } = req.params;
    if (!isId(id))
      return res.status(400).json({ success: false, error: "Invalid id" });

    // 1) Find the legacy document (speaker | exhibitor | attendee)
    const [sp, ex, at] = await Promise.all([
      Speaker.findById(id)
        .lean()
        .catch(() => null),
      Exhibitor.findById(id)
        .lean()
        .catch(() => null),
      attendee
        .findById(id)
        .lean()
        .catch(() => null),
    ]);

    const doc = sp || ex || at || null;
    const role = sp ? "speaker" : ex ? "exhibitor" : at ? "attendee" : null;
    if (!doc)
      return res.json({
        success: true,
        data: {
          language: "",
          sector: "",
          offering: "",
          lookingFor: "",
          role: null,
        },
      });

    // 2) BusinessProfile (owner mapping is not always consistent, so be liberal)
    const bp = await BusinessProfile.findOne({
      $or: [
        { "owner.actor": id },
        { ownerId: id },
        { owner: id },
        { createdBy: id },
      ],
    })
      .lean()
      .catch(() => null);

    // 3) Map fields by role (fallback to anything we have)
    let language = "";
    let sector = "";
    let offering = "";
    let lookingFor = "";

    if (role === "speaker") {
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
        bp?.primaryIndustry && bp?.subIndustry
          ? `${bp.primaryIndustry} / ${bp.subIndustry}`
          : null,
        arr(bp?.industries)?.length ? bp.industries.join(", ") : "",
        // speaker-ish
        arr(talk?.topics)?.length ? talk.topics.join(", ") : ""
      );

      // offering / seeking
      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(", ") : "",
        talk.offering,
        intent.offering
      );
      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(", ") : "",
        intent.lookingFor
      );
    }

    if (role === "exhibitor") {
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
        bp?.primaryIndustry && bp?.subIndustry
          ? `${bp.primaryIndustry} / ${bp.subIndustry}`
          : null,
        arr(bp?.industries)?.length ? bp.industries.join(", ") : "",
        idt.industry && idt.subIndustry
          ? `${idt.industry} / ${idt.subIndustry}`
          : idt.industry
      );

      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(", ") : "",
        com.offering
      );
      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(", ") : "",
        com.lookingFor
      );
    }

    if (role === "attendee") {
      const bpAtt = doc.businessProfile || {};
      const mi = doc.matchingIntent || {};
      const aids = doc.matchingAids || {};
      // language is required at registration for attendees (matchingAids.language or personal.preferredLanguages)
      language = firstText(
        aids.language,
        arr(doc?.personal?.preferredLanguages)[0]
      );

      sector = firstText(
        bp?.primaryIndustry && bp?.subIndustry
          ? `${bp.primaryIndustry} / ${bp.subIndustry}`
          : null,
        arr(bp?.industries)?.length ? bp.industries.join(", ") : "",
        bpAtt?.primaryIndustry && bpAtt?.subIndustry
          ? `${bpAtt.primaryIndustry} / ${bpAtt.subIndustry}`
          : bpAtt?.primaryIndustry
      );

      offering = firstText(
        arr(bp?.offering)?.length ? bp.offering.join(", ") : "",
        mi.offering
      );

      lookingFor = firstText(
        arr(bp?.seeking)?.length ? bp.seeking.join(", ") : "",
        arr(mi?.objectives)?.length ? mi.objectives.join(", ") : "",
        mi.needs
      );
    }

    // 4) Return
    return res.json({
      success: true,
      data: {
        role,
        language: language || "",
        sector: sector || "",
        offering: offering || "",
        lookingFor: lookingFor || "",
      },
    });
  } catch (err) {
    console.error("getMeetingPrefs error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};
/* 30-min slot normaliser */
function normalizeToUTC(dt) {
  if (dt instanceof Date) {
    // Keep the same wall time but return a UTC date
    return new Date(
      Date.UTC(
        dt.getFullYear(),
        dt.getMonth(),
        dt.getDate(),
        dt.getHours(),
        dt.getMinutes(),
        0,
        0
      )
    );
  }

  const s = String(dt || "");

  // If timezone is specified (Z or ±HH:MM), trust it
  if (/[zZ]$|[+\-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return d;
  }

  // If it's a plain "YYYY-MM-DDTHH:mm" (or with :ss) treat as **UTC** (no shift)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return new Date(
      Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0)
    );
  }

  // Fallback: parse as Date then preserve wall time in UTC
  const d = new Date(s);
  return new Date(
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      0,
      0
    )
  );
}

function slotKey(dateTimeISO) {
  const d = normalizeToUTC(dateTimeISO);
  // snap to nearest :00 or :30 without changing hour
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins < 30 ? 0 : 30);
  // minute precision canonical ISO
  return d.toISOString().slice(0, 19) + "Z";
}
/* ─────────────────── CREATE REQUEST ───────────────── */

function getModelByRole(role) {
  const k = String(role || "").toLowerCase();
  if (k === "attendee") return attendee;
  if (k === "exhibitor") return Exhibitor;
  if (k === "speaker") return Speaker;
  return null;
}

function safeGet(obj, path) {
  return path
    .split(".")
    .reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
}

function displayFromDoc(role, doc = {}) {
  const r = String(role || "").toLowerCase();
  if (r === "attendee") {
    const p = doc.personal || {};
    const o = doc.organization || {};
    return {
      name: p.fullName || "",
      email: p.email || "",
      photo: p.profilePic || "",
      org: o.orgName || "",
    };
  }
  if (r === "exhibitor") {
    const i = doc.identity || {};
    return {
      name: i.exhibitorName || i.orgName || "",
      email: i.email || "",
      photo: i.logo || "",
      org: i.orgName || "",
    };
  }
  // speaker
  const p = doc.personal || {};
  const o = doc.organization || {};
  return {
    name: p.fullName || "",
    email: p.email || "",
    photo: p.profilePic || "",
    org: o.orgName || "",
  };
}

function fmtDate(iso, timeZone) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: timeZone || "UTC",
    });
  } catch {
    return "—";
  }
}
function fmtTime(iso, timeZone) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timeZone || "UTC",
    });
  } catch {
    return "—";
  }
}

function renderEmail({
  title,
  intro,
  rows = [],
  ctaHref,
  ctaLabel = "Open Meetings",
}) {
  const rowHtml = rows
    .map(
      ([k, v]) => `
    <tr>
      <td style="padding:6px 8px;color:#334155">${k}</td>
      <td style="padding:6px 8px;color:#0f172a;font-weight:600">${v || "—"}</td>
    </tr>`
    )
    .join("");
  return `
  <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;padding:24px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <tr><td style="padding:18px 20px;background:#0ea5e9;color:#fff;font-size:18px;font-weight:700">${title}</td></tr>
      <tr><td style="padding:16px 20px;color:#334155">${intro}</td></tr>
      <tr><td style="padding:0 20px 12px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          ${rowHtml}
        </table>
      </td></tr>
      <tr><td style="padding:16px 20px 20px">
        <a href="${ctaHref}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700">${ctaLabel}</a>
      </td></tr>
    </table>
    <div style="max-width:640px;margin:12px auto 0;color:#64748b;font-size:12px">This is an automated message from Eventra.</div>
  </div>`;
}
exports.requestMeeting = asyncHandler(async (req, res) => {
  // Body expected from your UI:
  // { eventId, receiverId, receiverRole, dateTimeISO, subject, message }
  const senderId = req.user?.role === "admin" ? req.body?.senderId : req.user?._id;
  const senderRole =
    req.user?.role === "admin"
      ? req.body?.senderRole || "attendee"
      : req.user?.role;
  const eventId = req.body?.eventId;
  const receiverId = req.body?.receiverId;
  const receiverRole = req.body?.receiverRole;
  const slotISO = req.body?.dateTimeISO; // 30-min ISO (UTC recommended)
  const subject = String(
    req.body?.subject || "suggested by AI matchmaking tool"
  ).trim();
  const message = String(
    req.body?.message ||
      "You’re a strong match. We hope this meeting happens. Great fit detected. Looking forward to your meeting. Excellent match—hoping you can connect soon. Strong alignment—let’s make this meeting happen. High match score. We’re excited for your meetup."
  ).trim();
  console.log("senderId 1", senderId);
  console.log("senderRole 2", senderRole);
  if (!mongoose.isValidObjectId(senderId))
    return res.status(401).json({ message: "Auth required" });
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });
  if (!mongoose.isValidObjectId(receiverId))
    return res.status(400).json({ message: "Bad receiverId" });
  if (
    !["attendee", "exhibitor", "speaker"].includes(
      String(receiverRole || "").toLowerCase()
    )
  )
    return res.status(400).json({ message: "Bad receiverRole" });
  if (!slotISO || Number.isNaN(new Date(slotISO).getTime()))
    return res.status(400).json({ message: "Bad dateTimeISO" });
  if (!subject) return res.status(400).json({ message: "Subject required" });

  if (String(senderId) === String(receiverId)) {
    console.error("[requestMeeting:validation] same id");
    return res
      .status(400)
      .json({ message: "You cannot send a meeting request to yourself." });
  }
  // Load sender / receiver docs for email & validation
  const SenderModel = getModelByRole(senderRole);
  const ReceiverModel = getModelByRole(receiverRole);

  if (!SenderModel || !ReceiverModel) {
    return res.status(400).json({ message: "Unsupported roles" });
  }

  const [senderDoc, receiverDoc] = await Promise.all([
    SenderModel.findById(senderId).lean(),
    ReceiverModel.findById(receiverId).lean(),
  ]);
  if (!senderDoc) return res.status(404).json({ message: "Sender not found" });
  if (!receiverDoc)
    return res.status(404).json({ message: "Receiver not found" });

  const senderVirtual = !!senderDoc.virtualMeet;
  const receiverVirtual = !!receiverDoc.virtualMeet;
  const bothVirtual = senderVirtual && receiverVirtual;
  const halfVirtual = senderVirtual !== receiverVirtual;
  const slotNorm = norm30(slotISO); // normalize before checking
  const [wSender2, wReceiver2] = await Promise.all([
    SlotWhitelist.findOne({ eventId, actorId: senderId })
      .select("slots")
      .lean(),
    SlotWhitelist.findOne({ eventId, actorId: receiverId })
      .select("slots")
      .lean(),
  ]);
  const needCheck = !!(wSender2 || wReceiver2); // only enforce if at least one list exists
  if (needCheck) {
    const sSet = toSetISO(wSender2?.slots || []);
    const rSet = toSetISO(wReceiver2?.slots || []);
    const k = iso(slotNorm);
    if (!(sSet.has(k) && rSet.has(k))) {
      return res
        .status(409)
        .json({
          message: "Selected slot is not whitelisted by both participants.",
        });
    }
  }
  const activeStatuses = ["pending", "confirmed", "rescheduled"];
  const existing = await MeetRequest.findOne({
    eventId,
    $or: [
      { senderId, receiverId },
      { senderId: receiverId, receiverId: senderId }, // either direction
    ],
    status: { $in: activeStatuses },
  }).lean();

  if (existing) {
    return res.status(409).json({
      message: "Active meeting already exists for these participants and event",
    });
  }

  // Read capacity (always, but we will use it only if not both virtual)
  let physCapMax =
    Number(process.env.MEETING_SLOT_CAP) > 0
      ? Number(process.env.MEETING_SLOT_CAP)
      : 30;
  let hybridCapMax = null;
  let eventObjForCaps = null;

  if (Event) {
    try {
      eventObjForCaps = await Event.findById(eventId)
        .select("b2bCapacity postsCount timezone title name")
        .lean();
      if (Number(eventObjForCaps?.b2bCapacity) > 0)
        physCapMax = Number(eventObjForCaps.b2bCapacity);
      if (Number(eventObjForCaps?.postsCount) > 0)
        hybridCapMax = Number(eventObjForCaps.postsCount);
    } catch {}
  }
  // sensible fallback for hybrid if postsCount missing
  if (!Number.isFinite(hybridCapMax) || hybridCapMax == null) hybridCapMax = 10;

  let used = 0,
    limit = 0;
  let counterKind = bothVirtual
    ? "virtual"
    : halfVirtual
    ? "hybrid"
    : "physical";

  if (counterKind === "physical") {
    // physical ↔ physical: use MeetingSlot
    let slotDoc = await MeetingSlot.findOne({ eventId, slotISO }).lean();
    if (!slotDoc) {
      try {
        slotDoc = await MeetingSlot.create({
          eventId,
          slotISO,
          used: 0,
          cap: physCapMax,
        });
      } catch {
        slotDoc = await MeetingSlot.findOne({ eventId, slotISO }).lean();
      }
    }
    used = Number(slotDoc?.used || 0);
    limit = Number(slotDoc?.cap || physCapMax);
    if (used >= limit)
      return res
        .status(409)
        .json({ message: "Slot is full, please choose another time" });
  }

  if (counterKind === "hybrid") {
    // physical ↔ virtual: use HybridMeetingSlot (cap = postsCount)
    let hDoc = await HybridMeetingSlot.findOne({ eventId, slotISO }).lean();
    if (!hDoc) {
      try {
        hDoc = await HybridMeetingSlot.create({
          eventId,
          slotISO,
          used: 0,
          cap: hybridCapMax,
        });
      } catch {
        hDoc = await HybridMeetingSlot.findOne({ eventId, slotISO }).lean();
      }
    }
    used = Number(hDoc?.used || 0);
    limit = Number(hDoc?.cap || hybridCapMax);
    if (used >= limit)
      return res
        .status(409)
        .json({ message: "Hybrid slot is full, please choose another time" });
  }

  // Create meeting
  const created = await MeetRequest.create({
    eventId,
    senderId,
    senderRole,
    receiverId,
    receiverRole,
    subject,
    message,
    requestedAt: new Date(),
    status: "pending",
    slotISO, // store selected slot
    proposedNewAt: null,
  });

  // Increment the slot usage
  if (counterKind === "physical") {
    await MeetingSlot.updateOne(
      { eventId, slotISO },
      { $inc: { used: 1 }, $set: { cap: limit || physCapMax } },
      { upsert: true }
    );
  } else if (counterKind === "hybrid") {
    await HybridMeetingSlot.updateOne(
      { eventId, slotISO },
      { $inc: { used: 1 }, $set: { cap: limit || hybridCapMax } },
      { upsert: true }
    );
  }

  // Email both parties
  const FRONT = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  let eventObj = null;
  if (Event) {
    try {
      eventObj = await Event.findById(eventId)
        .select("title name city country timezone")
        .lean();
    } catch {}
  }
  const evTitle = eventObj?.title || eventObj?.name || "Event";
  const evTZ = eventObj?.timezone || "UTC";

  const senderDisp = displayFromDoc(senderRole, senderDoc);
  const receiverDisp = displayFromDoc(receiverRole, receiverDoc);

  const prettyDate = fmtDate(slotISO, evTZ);
  const prettyTime = fmtTime(slotISO, evTZ);

  const rowsCommon = [
    ["Event", evTitle],
    ["Date", prettyDate],
    ["Time", prettyTime + (evTZ ? ` (${evTZ})` : "")],
    ["Subject", subject],
  ];
  const modeLabel = bothVirtual
    ? "Online (virtual for both)"
    : halfVirtual
    ? senderVirtual
      ? "Hybrid (you virtual, receiver in-person)"
      : "Hybrid (you in-person, receiver virtual)"
    : "In-person (both in venue)";

  const rowsSender = [...rowsCommon, ["Mode", modeLabel]];

  // Receiver sees it from their POV too (swap the hybrid text if needed)
  const modeLabelReceiver = bothVirtual
    ? "Online (virtual for both)"
    : halfVirtual
    ? receiverVirtual
      ? "Hybrid (you virtual, sender in-person)"
      : "Hybrid (you in-person, sender virtual)"
    : "In-person (both in venue)";

  const rowsReceiver = [...rowsCommon, ["Mode", modeLabelReceiver]];

  const introSenderExtra = bothVirtual
    ? " This meeting is online (virtual for both)."
    : halfVirtual
    ? " This meeting will be hybrid (one side virtual)."
    : "";

  const introReceiverExtra = bothVirtual
    ? " This meeting is online (virtual for both)."
    : halfVirtual
    ? " This meeting will be hybrid (one side virtual)."
    : "";
  // Sender mail
  const ti =
    req.user.role === "admin"
      ? "You’ve Been Matched!  Your Next B2B Connection Awaits"
      : "Your meeting request was sent";
  const int =
    req.user.role === "admin"
      ? `Hi ${senderDisp.name || ""},

Eventra’s AI just did its magic — you’ve been automatically matched with ${
          receiverDisp.name || "participant"
        }.
Our system detected strong business potential between your profiles.

👉 Go to your Eventra account, open “View Meetings” under your profile, and check your new invitation to confirm or decline.

Eventra - Connect. Grow, Globalize`
      : `Thanks ${senderDisp.name || ""}! We sent your request to <b>${
          receiverDisp.name || "participant"
        }</b>. You’ll receive an email when they respond.${introSenderExtra}`;
  const htmlSender = renderEmail({
    title: ti,
    intro: int,
    rows: [
      ...rowsSender,
      ["To", receiverDisp.name || receiverDisp.email || "—"],
    ],
    ctaHref: `${FRONT}/meetings`,
    ctaLabel: "Open my meetings",
  });
  const ti2 = req.user.role === "admin" ? ti : "You have a new meeting request";
  const int2 =
    req.user.role === "admin"
      ? `Hi ${receiverDisp.name || ""},

Eventra’s AI just did its magic — you’ve been automatically matched with ${
          senderDisp.name || "participant"
        }.
Our system detected strong business potential between your profiles.

👉 Go to your Eventra account, open “View Meetings” under your profile, and check your new invitation to confirm or decline.

Eventra - Connect. Grow, Globalize`
      
      : `Hello ${
          receiverDisp.name || ""
        }, you received a meeting request from <b>${
          senderDisp.name || "a participant"
        }</b>.${introReceiverExtra}`;
  const htmlReceiver = renderEmail({
    title: ti2,
    intro: int2,
    rows: [
      ...rowsReceiver,
      ["From", senderDisp.name || senderDisp.email || "—"],
      ["Message", message || "(no message)"],
    ],
    ctaHref: `${FRONT}/meetings`,
    ctaLabel: "Review request",
  });

  const mailErrors = [];
  try {
    if (senderDisp.email)
      await sendMail(senderDisp.email, "Eventra · Request sent", htmlSender);
  } catch (e) {
    mailErrors.push("sender");
  }
  try {
    if (receiverDisp.email)
      await sendMail(
        receiverDisp.email,
        "Eventra · New meeting request",
        htmlReceiver
      );
  } catch (e) {
    mailErrors.push("receiver");
  }
  try {
    const meetUrl = `/meetings/${String(doc._id)}`;
    await ActorNotification.create([
      {
        actorId: doc.receiverId,
        title: "New meeting request",
        body: `You have a meeting request from ${String(doc.senderId)}`,
        link: meetUrl,
        priority: 5,
      },
      {
        actorId: doc.senderId,
        title: "Meeting request sent",
        body: `Your request to ${String(doc.receiverId)} was created`,
        link: meetUrl,
        priority: 3,
      },
    ]);
  } catch (e) {
    console.error("[notif][requestMeeting]", e?.message || e);
  }

  return res.status(201).json({
    success: true,
    message: mailErrors.length
      ? "Meeting created; some emails failed to send"
      : "Meeting created and emails sent",
    data: {
      id: created._id,
      status: created.status,
      slotISO: created.slotISO,
      sender: { id: senderId, role: senderRole },
      receiver: { id: receiverId, role: receiverRole },
      slotCounter:
        counterKind === "virtual"
          ? null
          : { used: used + 1, cap: limit, kind: counterKind },
    },
    emailFailed: mailErrors,
  });
});

/* helper: email + name fetch */
function getMeta(doc, role) {
  return {
    email: role === "exhibitor" ? doc.identity.email : doc.personal.email,
    name:
      role === "exhibitor" ? doc.identity.exhibitorName : doc.personal.fullName,
  };
}

/* helper: insert SlotIndex for both actors, catching race */
async function lockSlot(eventId, actorIds, slotISO) {
  const docs = actorIds.map((id) => ({ eventId, actorId: id, slotISO }));
  try {
    await SlotIndex.insertMany(docs, { ordered: false });
  } catch (e) {
    if (e.code === 11000) throw new Error("Slot has just been taken");
    throw e;
  }
}

/* ───────────────────────── ACCEPT ─────────────────────────────── */
exports.acceptMeeting = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message: "Not found" });

  /* permissions */
  const IamSender =
    meet.senderId.toString() === meId && meet.senderRole === meRole;
  const IamReceiver =
    meet.receiverId.toString() === meId && meet.receiverRole === meRole;

  /* Valid transitions */
  if (meet.status === "pending" && !IamReceiver)
    return res
      .status(403)
      .json({ message: "Only receiver can accept initial request" });
  if (meet.status === "reschedule-proposed" && !IamSender)
    return res
      .status(403)
      .json({ message: "Only original sender can accept new slot" });
  if (!["pending", "reschedule-proposed"].includes(meet.status))
    return res
      .status(400)
      .json({ message: `Cannot accept from status ${meet.status}` });

  /* Choose slot */
  const finalISO = slotKey(
    meet.status === "pending" ? meet.requestedAt : meet.proposedNewAt
  );
  const finalDate = new Date(finalISO);

  /* Check event bounds & lock slot */
  const event = await Event.findById(meet.eventId).lean();
  if (finalDate < event.startDate || finalDate > event.endDate)
    return res.status(400).json({ message: "Date outside event" });

  await lockSlot(meet.eventId, [meet.senderId, meet.receiverId], finalISO);

  /* Update meet doc */
  meet.status = "accepted";
  meet.acceptedAt = finalDate;
  meet.requestedAt = finalDate; // store actual final slot
  meet.proposedNewAt = undefined;
  meet.history.push({ actorId: meId, action: "accepted", note: finalISO });
  await meet.save();
  await exports.scheduleMeetingReminder(meet);
  /* Notify both parties */
  const [senderDoc, receiverDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
  ]);
  const s = getMeta(senderDoc, meet.senderRole);
  const r = getMeta(receiverDoc, meet.receiverRole);

  await Promise.all([
    sendMail(
      s.email,
      "Meeting confirmed",
      `
      <p>Your meeting with ${
        r.name
      } has been confirmed for ${finalDate.toUTCString()}.</p>`
    ),
    sendMail(
      r.email,
      "Meeting confirmed",
      `
      <p>Your meeting with ${
        s.name
      } has been confirmed for ${finalDate.toUTCString()}.</p>`
    ),
  ]);

  res.json({
    success: true,
    message: "Meeting accepted",
    data: { status: "accepted", at: finalISO },
  });
});

/* ───────────────────────── DECLINE ─────────────────────────────── */
exports.declineMeeting = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message: "Not found" });

  const IamSender =
    meet.senderId.toString() === meId && meet.senderRole === meRole;
  const IamReceiver =
    meet.receiverId.toString() === meId && meet.receiverRole === meRole;

  const canDecline =
    (meet.status === "pending" && IamReceiver) ||
    (meet.status === "reschedule-proposed" && IamSender) ||
    (meet.status === "accepted" && (IamSender || IamReceiver));
  if (!canDecline)
    return res.status(403).json({ message: "Cannot decline in this state" });

  const prevStatus = meet.status;
  meet.status = "declined";
  meet.history.push({ actorId: meId, action: "declined", note: prevStatus });
  await meet.save();

  /* If previously accepted, free slot */
  if (prevStatus === "accepted") {
    await SlotIndex.deleteMany({
      eventId: meet.eventId,
      actorId: { $in: [meet.senderId, meet.receiverId] },
      slotISO: slotKey(meet.requestedAt),
    });
  }

  /* Notify both */
  const [sDoc, rDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
  ]);
  await Promise.all([
    sendMail(
      getMeta(sDoc, meet.senderRole).email,
      "Meeting declined",
      "One of the parties has declined the meeting."
    ),
    sendMail(
      getMeta(rDoc, meet.receiverRole).email,
      "Meeting declined",
      "Meeting has been declined."
    ),
  ]);

  res.json({ success: true, message: "Declined" });
});

/* ───────────────────────── PROPOSE NEW TIME (receiver) ──────────── */
exports.proposeNewTime = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { dateTimeISO } = req.body;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  if (!dateTimeISO)
    return res.status(400).json({ message: "dateTimeISO required" });

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message: "Not found" });
  if (meet.status !== "pending")
    return res
      .status(400)
      .json({ message: "Only pending requests can be rescheduled" });

  const IamReceiver =
    meet.receiverId.toString() === meId && meet.receiverRole === meRole;
  if (!IamReceiver)
    return res
      .status(403)
      .json({ message: "Only receiver can propose new time" });

  /* validate slot inside event & clash-free for both actors */
  const slotISO = slotKey(dateTimeISO);
  const slotDate = new Date(slotISO);
  const event = await Event.findById(meet.eventId).lean();
  if (slotDate < event.startDate || slotDate > event.endDate)
    return res.status(400).json({ message: "Slot outside event dates" });

  const clash = await SlotIndex.findOne({
    eventId: meet.eventId,
    actorId: { $in: [meet.senderId, meet.receiverId] },
    slotISO,
  }).lean();
  if (clash)
    return res.status(409).json({ message: "One of you is busy at that time" });

  /* update meet */
  meet.status = "reschedule-proposed";
  meet.proposedNewAt = slotDate;
  meet.history.push({ actorId: meId, action: `proposed:${slotISO}` });
  await meet.save();

  /* notify sender */
  const senderDoc = await ROLE_MODEL[meet.senderRole]
    .findById(meet.senderId)
    .lean();
  const receiverDoc = await ROLE_MODEL[meet.receiverRole]
    .findById(meet.receiverId)
    .lean();

  const acceptNew = `${process.env.FRONTEND_URL}/meets/${meet._id}?action=confirm`;
  const declineNew = `${process.env.FRONTEND_URL}/meets/${meet._id}?action=decline`;

  await sendMail(
    getMeta(senderDoc, meet.senderRole).email,
    "New time proposed for meeting",
    `<p>${
      getMeta(receiverDoc, meet.receiverRole).name
    } proposed ${slotDate.toUTCString()}.</p>
     <a href="${acceptNew}">Accept</a> | <a href="${declineNew}">Decline</a>`
  );

  res.json({
    success: true,
    message: "New time proposed",
    data: { status: "reschedule-proposed", proposedAt: slotISO },
  });
});

/* ───────────────────────── CONFIRM PROPOSED NEW TIME ─────────────── */
exports.confirmReschedule = exports.acceptMeeting; // same logic as acceptMeeting

function getModelByRole(role) {
  const k = String(role || "").toLowerCase();
  if (k === "attendee") return attendee;
  if (k === "exhibitor") return Exhibitor;
  if (k === "speaker") return Speaker;
  return null;
}

function pick(obj, pathArr) {
  for (const p of pathArr) {
    const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function displayFromDoc(role, doc) {
  if (!doc) return { name: "—", email: "", photo: "" };

  if (role === "attendee") {
    return {
      name: pick(doc, ["personal.fullName"]) || "—",
      email: pick(doc, ["personal.email"]) || "",
      photo: pick(doc, ["personal.profilePic"]) || "",
    };
  }
  if (role === "exhibitor") {
    return {
      name: pick(doc, ["identity.exhibitorName", "identity.orgName"]) || "—",
      email: pick(doc, ["identity.email"]) || "",
      photo: pick(doc, ["identity.logo", "logo"]) || "",
    };
  }
  if (role === "speaker") {
    return {
      name: pick(doc, ["personal.fullName"]) || "—",
      email: pick(doc, ["personal.email"]) || "",
      photo: pick(doc, ["personal.profilePic"]) || "",
    };
  }
  return { name: "—", email: "", photo: "" };
}

function computeAllowedActions(meet, actorId) {
  const me = String(actorId);
  const isSender = String(meet.senderId) === me;
  const isReceiver = String(meet.receiverId) === me;

  if (!isSender && !isReceiver) return [];

  const st = String(meet.status || "").toLowerCase();
  const proposedBy = meet.proposedBy ? String(meet.proposedBy) : null;

  if (st === "pending") {
    // sender: cancel | reschedule, receiver: confirm | reject | reschedule
    return isSender
      ? ["cancel", "reschedule"]
      : ["confirm", "reject", "reschedule"];
  }
  if (st === "rescheduled") {
    // who DIDN'T propose can confirm/reject; proposer can cancel/reschedule again
    if (proposedBy && proposedBy === me) return ["cancel", "reschedule"];
    return ["confirm", "reject", "reschedule"];
  }
  if (st === "confirmed") {
    // both sides can reschedule or cancel
    return ["reschedule", "cancel"];
  }
  // rejected/cancelled => no actions
  return [];
}

async function attachParticipants(rows) {
  // Build role+id → doc map with 1 batch fetch per role
  const aIds = [],
    eIds = [],
    sIds = [];
  rows.forEach((r) => {
    const push = (role, id) => {
      if (!mongoose.isValidObjectId(id)) return;
      if (role === "attendee") aIds.push(String(id));
      if (role === "exhibitor") eIds.push(String(id));
      if (role === "speaker") sIds.push(String(id));
    };
    push(r.senderRole, r.senderId);
    push(r.receiverRole, r.receiverId);
  });

  const uniq = (xs) => Array.from(new Set(xs));
  const [A, E, S] = await Promise.all([
    aIds.length ? attendee.find({ _id: { $in: uniq(aIds) } }).lean() : [],
    eIds.length ? Exhibitor.find({ _id: { $in: uniq(eIds) } }).lean() : [],
    sIds.length ? Speaker.find({ _id: { $in: uniq(sIds) } }).lean() : [],
  ]);

  const map = { attendee: new Map(), exhibitor: new Map(), speaker: new Map() };
  A.forEach((d) => map.attendee.set(String(d._id), d));
  E.forEach((d) => map.exhibitor.set(String(d._id), d));
  S.forEach((d) => map.speaker.set(String(d._id), d));

  return rows.map((r) => {
    const sDoc = map[r.senderRole]?.get(String(r.senderId));
    const rDoc = map[r.receiverRole]?.get(String(r.receiverId));
    const sDisp = displayFromDoc(r.senderRole, sDoc);
    const rDisp = displayFromDoc(r.receiverRole, rDoc);

    return {
      ...r,
      id: r._id,
      senderName: sDisp.name,
      senderEmail: sDisp.email,
      senderPhoto: sDisp.photo,
      receiverName: rDisp.name,
      receiverEmail: rDisp.email,
      receiverPhoto: rDisp.photo,
    };
  });
}

function scoreMatch(me, them) {
  // "AI-like" scoring based on overlap & intent — bounded 0..100
  // We try to read common places across your 3 roles.
  const getSet = (v) => {
    if (!v) return new Set();
    if (Array.isArray(v)) return new Set(v.map(String));
    return new Set(
      String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  };

  // Extract "interests" / "objectives" / "industry" / "languages"
  const meIntents = getSet(
    me?.matchingIntent?.objectives ||
      me?.commercial?.lookingFor ||
      me?.talk?.topicCategory
  );
  const themIntents = getSet(
    them?.matchingIntent?.objectives ||
      them?.commercial?.lookingFor ||
      them?.talk?.topicCategory
  );

  const meLang = getSet(
    me?.personal?.preferredLanguages ||
      me?.commercial?.languages ||
      me?.talk?.language
  );
  const themLang = getSet(
    them?.personal?.preferredLanguages ||
      them?.commercial?.languages ||
      them?.talk?.language
  );

  const meInd = getSet(
    me?.businessProfile?.primaryIndustry || me?.business?.industry
  );
  const themInd = getSet(
    them?.businessProfile?.primaryIndustry || them?.business?.industry
  );

  const overlap = (A, B) => {
    const a = Array.from(A);
    if (!a.length) return 0;
    let c = 0;
    a.forEach((x) => {
      if (B.has(String(x))) c++;
    });
    return c / Math.max(1, new Set([...A, ...B]).size);
  };

  let score = 0;
  score += overlap(meIntents, themIntents) * 50; // intent heavy
  score += overlap(meLang, themLang) * 20; // communication
  score += overlap(meInd, themInd) * 20; // industry
  // small country boost
  if (
    me?.personal?.country &&
    them?.personal?.country &&
    me.personal.country === them.personal.country
  )
    score += 5;
  // receiver open to meetings
  if (
    them?.matchingIntent?.openToMeetings ||
    them?.b2bIntent?.openMeetings ||
    them?.commercial?.availableMeetings
  )
    score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}
const getp = (obj, path) =>
  path.split(".").reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);

const pickFirst = (doc, paths = []) => {
  for (const p of paths) {
    const v = getp(doc, p);
    if (v != null && v !== "") return v;
  }
  return undefined;
};

function metaFromDoc(role, doc = {}) {
  const r = String(role || "").toLowerCase();

  if (r === "exhibitor") {
    return {
      name:
        pickFirst(doc, [
          "identity.exhibitorName",
          "identity.orgName",
          "identity.contactName",
        ]) || "Exhibitor",
      email: pickFirst(doc, ["identity.email"]) || "",
      photo:
        pickFirst(doc, [
          "identity.logo",
          "enrichments.profilePic",
          "personal.profilePic",
        ]) || "",
    };
  }
  if (r === "speaker") {
    return {
      name: pickFirst(doc, ["personal.fullName"]) || "Speaker",
      email: pickFirst(doc, ["personal.email"]) || "",
      photo:
        pickFirst(doc, ["enrichments.profilePic", "personal.profilePic"]) || "",
    };
  }
  // attendee (default)
  return {
    name: pickFirst(doc, ["personal.fullName"]) || "Attendee",
    email: pickFirst(doc, ["personal.email"]) || "",
    photo:
      pickFirst(doc, ["personal.profilePic", "enrichments.profilePic"]) || "",
  };
}

/**
 * Allowed actions matrix (server-side guard to match UI):
 * - pending:
 *    - sender   -> cancel, reschedule, delete
 *    - receiver -> confirm, reject, reschedule
 * - rescheduled:
 *    - proposedBy (who initiated new time) -> acts like pending/sender (cancel, reschedule, delete)
 *    - other party                        -> confirm, reject, reschedule
 * - confirmed: both -> reschedule, cancel
 * - rejected : sender -> []; receiver -> delete
 * - cancelled: both -> delete
 */
function computeAllowedActions(meet, meId) {
  const me = String(meId);
  const s = String(meet?.status || "").toLowerCase();

  const isSender = String(meet?.senderId) === me;
  const isReceiver = String(meet?.receiverId) === me;
  const iAmParty = isSender || isReceiver;

  if (!iAmParty) return [];

  if (s === "pending") {
    return isSender
      ? ["cancel", "reschedule", "delete"]
      : ["confirm", "reject", "reschedule"];
  }

  if (s === "rescheduled") {
    const who = String(meet?.proposedBy || "");
    const iAmProposer = who && who === me;
    return iAmProposer
      ? ["cancel", "reschedule", "delete"]
      : ["confirm", "reject", "reschedule"];
  }

  if (s === "confirmed") return ["reschedule", "cancel"];

  if (s === "rejected") return isSender ? [] : ["delete"];

  if (s === "cancelled" || s === "canceled") return ["delete"];

  return [];
}

/* ------------------------------ getMyMeetings ------------------------------ */
/**
 * Returns meetings for the logged-in actor, enriched with the *other* side’s
 * display fields for your UI:
 *  - otherId, otherRole, otherName, otherEmail, otherPhoto
 *  - plus all original meeting fields you render (requestedAt, slotISO, etc.)
 *  - allowedActions computed against req.user._id
 */
exports.getMyMeetings = asyncHandler(async (req, res) => {
  const meId = String(req.user._id);
  const meRole = String(req.user.role || "").toLowerCase();
  const { eventId, status } = req.query || {};

  const q = {
    $or: [
      { senderId: meId, senderRole: meRole },
      { receiverId: meId, receiverRole: meRole },
    ],
  };
  if (eventId) q.eventId = eventId;
  if (status) q.status = status;

  // Pull minimal fields used by the UI and transitions
  const rows = await MeetRequest.find(q)
    .sort({ requestedAt: 1 })
    .select(
      `
      _id eventId status subject message roomId
      senderId senderRole receiverId receiverRole
      requestedAt slotISO proposedNewAt proposedBy acceptedAt createdAt updatedAt
    `
    )
    .lean();

  if (!rows.length) {
    return res.json({ success: true, count: 0, data: [], actorId: meId });
  }

  // Collect ONLY the "other side" ids we need to hydrate
  // Collect BOTH participants so we can compute virtual flags
  const buckets = {
    attendee: new Set(),
    exhibitor: new Set(),
    speaker: new Set(),
  };

  for (const m of rows) {
    const pairs = [
      [String(m.senderRole), String(m.senderId)],
      [String(m.receiverRole), String(m.receiverId)],
    ];
    for (const [r, id] of pairs) {
      if (ROLE_MODEL[r] && mongoose.isValidObjectId(id)) {
        buckets[r].add(String(id));
      }
    }
  }

  // Batch fetch by role
  const cache = new Map(); // key: `${role}:${id}` -> doc
  async function fill(roleKey) {
    const ids = Array.from(buckets[roleKey] || []);
    if (!ids.length) return;
    const M = ROLE_MODEL[roleKey];
    const docs = await M.find({ _id: { $in: ids } })
      .select(
        roleKey === "exhibitor"
          ? "identity.logo identity.exhibitorName identity.orgName identity.contactName identity.email virtualMeet"
          : "personal.fullName personal.email personal.profilePic enrichments.profilePic virtualMeet"
      )
      .lean();
    for (const d of docs) cache.set(`${roleKey}:${String(d._id)}`, d);
  }
  await Promise.all([fill("attendee"), fill("exhibitor"), fill("speaker")]);

  // Build payloads
  const data = rows.map((m) => {
    const iAmSender = String(m.senderId) === meId;
    const otherRole = iAmSender ? m.receiverRole : m.senderRole;
    const otherId = iAmSender ? m.receiverId : m.senderId;
    const otherDoc = cache.get(`${otherRole}:${String(otherId)}`) || {};
    const otherMeta = metaFromDoc(otherRole, otherDoc);
    const senderDoc =
      cache.get(`${String(m.senderRole)}:${String(m.senderId)}`) || {};
    const receiverDoc =
      cache.get(`${String(m.receiverRole)}:${String(m.receiverId)}`) || {};
    const senderVirtual = !!senderDoc.virtualMeet;
    const receiverVirtual = !!receiverDoc.virtualMeet;
    return {
      senderVirtual,
      receiverVirtual,
      // meeting fields (keep original ids/roles)
      id: String(m._id),
      _id: m._id, // if your frontend still reads `_id`
      eventId: String(m.eventId),
      status: m.status,
      subject: m.subject || "",
      message: m.message || "",
      roomId: m.roomId || null,

      senderId: String(m.senderId),
      senderRole: String(m.senderRole),
      receiverId: String(m.receiverId),
      receiverRole: String(m.receiverRole),

      requestedAt: m.requestedAt || null,
      slotISO: m.slotISO || m.requestedAt || null,
      proposedNewAt: m.proposedNewAt || null,
      proposedBy: m.proposedBy ? String(m.proposedBy) : undefined,
      acceptedAt: m.acceptedAt || null,
      createdAt: m.createdAt || null,
      updatedAt: m.updatedAt || null,

      // the *other* side for the logged-in user
      otherId: String(otherId),
      otherRole: String(otherRole),
      otherName: otherMeta.name || "—",
      otherEmail: otherMeta.email || "",
      otherPhoto: otherMeta.photo || "",

      // server-side guard for UI buttons
      allowedActions: computeAllowedActions(m, meId),
    };
  });

  return res.json({
    success: true,
    count: data.length,
    data,
    actorId: meId,
  });
});

/* ───────────────────────── listActorAgenda (admin) ───────────────────────── */
// GET /meets/agenda/:actorId?eventId=&status=
exports.listActorAgenda = asyncHandler(async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ message: "Admin only" });

  const { actorId } = req.params || {};
  const { eventId, status } = req.query || {};
  if (!mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: "Bad actorId" });

  const q = {
    $or: [{ senderId: actorId }, { receiverId: actorId }],
  };
  if (eventId) q.eventId = eventId;
  if (status) q.status = status;

  const rows = await MeetRequest.find(q).sort({ requestedAt: 1 }).lean();
  const data = await attachParticipants(rows);
  return res.json({ success: true, count: data.length, data });
});
const MeetingBlacklist =
  mongoose.models.MeetingBlacklist ||
  mongoose.model(
    "MeetingBlacklist",
    new mongoose.Schema(
      {
        meetingId: {
          type: mongoose.Schema.Types.ObjectId,
          index: true,
          unique: true,
        },
        eventId: { type: mongoose.Schema.Types.ObjectId, index: true },
        actors: [{ type: mongoose.Schema.Types.ObjectId }],
        reason: { type: String, default: "" },
        createdAt: { type: Date, default: Date.now },
      },
      { collection: "meeting_blacklist" }
    )
  );

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const asStr = (x) => String(x || "");

function whoAmI(meet, meId) {
  const s = asStr(meet.senderId) === asStr(meId);
  const r = asStr(meet.receiverId) === asStr(meId);
  return { isSender: s, isReceiver: r };
}

function computeAllowedActions(meet, meId, isAdmin = false) {
  if (isAdmin) return ["confirm", "reject", "cancel", "reschedule", "delete"];
  const st = String(meet.status || "").toLowerCase();
  const { isSender, isReceiver } = whoAmI(meet, meId);
  const proposedBy = asStr(meet.proposedBy || "");

  if (st === "pending") {
    if (isReceiver) return ["confirm", "reject", "reschedule"];
    if (isSender) return ["cancel", "reschedule"];
    return [];
  }
  if (st === "rescheduled") {
    if (proposedBy && asStr(proposedBy) === asStr(meId))
      return ["cancel", "reject"];
    return ["confirm", "reject"];
  }
  if (st === "confirmed") return ["reschedule", "cancel"];
  if (st === "rejected") return isReceiver ? ["delete"] : [];
  if (st === "cancelled" || st === "canceled") return [];
  return [];
}

async function lockActors(eventId, slotISO, a, b) {
  console.log(
    "[lockActors] eventId=%s slotISO=%s a=%s b=%s",
    eventId,
    slotISO,
    a,
    b
  );
  const docs = [
    { eventId, actorId: a, slotISO },
    { eventId, actorId: b, slotISO },
  ];
  for (const d of docs) {
    const r = await SlotIndex.updateOne(
      { eventId: d.eventId, actorId: d.actorId, slotISO: d.slotISO },
      { $setOnInsert: d },
      { upsert: true }
    );
    console.log("[lockActors] upsert result=", r);
  }
}

async function unlockActors(eventId, slotISO, a, b) {
  if (!slotISO) return;
  console.log(
    "[unlockActors] eventId=%s slotISO=%s actors=[%s,%s]",
    eventId,
    slotISO,
    a,
    b
  );
  const r = await SlotIndex.deleteMany({
    eventId,
    actorId: { $in: [a, b] },
    slotISO,
  });
  console.log("[unlockActors] deleteMany result=", r);
}

async function ensureCapDoc(eventId, slotISO) {
  const ev = await Event.findById(eventId).select("b2bCapacity").lean();
  const capDefault = Number(ev?.b2bCapacity) > 0 ? Number(ev.b2bCapacity) : 30;
  const doc = await MeetingSlot.findOneAndUpdate(
    { eventId, slotISO },
    { $setOnInsert: { eventId, slotISO, used: 0, cap: capDefault } },
    { new: true, upsert: true }
  ).lean();
  console.log("[ensureCapDoc] eventId=%s slotISO=%s ->", eventId, slotISO, doc);
  return doc;
}

async function decCapIfExists(eventId, slotISO) {
  if (!slotISO) return;
  const row = await MeetingSlot.findOne({ eventId, slotISO }).lean();
  console.log("[decCapIfExists] pre row=", row);
  if (!row) return;
  const nextUsed = Math.max(0, Number(row.used || 0) - 1);
  const r = await MeetingSlot.updateOne(
    { eventId, slotISO },
    { $set: { used: nextUsed } }
  );
  console.log("[decCapIfExists] set used=%d result=", nextUsed, r);
}

function getMeta(doc, role) {
  const r = (role || "").toLowerCase();
  if (r === "exhibitor") {
    const out = {
      name:
        doc?.identity?.exhibitorName || doc?.identity?.orgName || "Exhibitor",
      email:
        doc?.identity?.email ||
        doc?.identity?.contactEmail ||
        doc?.organization?.email ||
        doc?.personal?.email ||
        "",
      org: doc?.identity?.orgName || doc?.organization?.orgName || "",
    };
    console.log("[getMeta:exhibitor]", out);
    return out;
  }
  const out = {
    name: doc?.personal?.fullName || "User",
    email: doc?.personal?.email || doc?.personal?.firstEmail || "",
    org: doc?.organization?.orgName || "",
  };
  console.log("[getMeta:%s]", r || "attendee/speaker", out);
  return out;
}

function fmtLocal(iso, tz) {
  const d = new Date(iso);
  const out = {
    date: d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz || "UTC",
    }),
    time: d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz || "UTC",
    }),
  };
  console.log("[fmtLocal] iso=%s tz=%s =>", iso, tz, out);
  return out;
}

// IMPORTANT: ignore the current meeting when checking busy
async function existsBusyAt(
  eventId,
  slotISO,
  actorIds = [],
  ignoreMeetId = null
) {
  console.log("[existsBusyAt] start", {
    eventId: String(eventId),
    slotISO,
    actorIds,
    ignoreMeetId: String(ignoreMeetId || ""),
  });

  // Check per-actor locks (confirmed holds)
  const lock = await SlotIndex.findOne({
    eventId,
    actorId: { $in: actorIds },
    slotISO,
  }).lean();
  console.log("[existsBusyAt] slot lock found?", !!lock, lock?._id || null);
  if (lock) return true;

  // Check overlapping MeetRequest at the exact slot for either actor,
  // but EXCLUDE the current meeting if provided
  const q = {
    eventId,
    _id: ignoreMeetId ? { $ne: ignoreMeetId } : { $exists: true },
    status: { $in: ["pending", "rescheduled", "confirmed"] },
    $and: [
      {
        $or: [
          { senderId: { $in: actorIds } },
          { receiverId: { $in: actorIds } },
        ],
      },
      {
        $or: [
          { requestedAt: new Date(slotISO) },
          { proposedNewAt: new Date(slotISO) },
          { slotISO: new Date(slotISO) },
        ],
      },
    ],
  };
  const other = await MeetRequest.findOne(q)
    .select("_id status senderId receiverId slotISO requestedAt proposedNewAt")
    .lean();
  console.log(
    "[existsBusyAt] conflicting request found?",
    !!other,
    other || null
  );
  return !!other;
}

// PDF helpers
function pdfToBuffer(makeDoc) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    makeDoc(doc);
    doc.end();
  });
}

async function buildMeetingPDF({ meet, eventObj, actor, other, qrPngBuffer }) {
  const tz = eventObj?.timezone || "UTC";
  const when = fmtLocal(meet.slotISO, tz);
  const evTitle = eventObj?.title || eventObj?.name || "Event";
  const tableId = String(meet.tableId || "");
  const vLink = String(meet.meetLink || "");

  return pdfToBuffer((doc) => {
    doc.fontSize(18).text(`${evTitle} — B2B Meeting`, { align: "left" });
    doc.moveDown(0.5);
    doc
      .fontSize(12)
      .fillColor("#333")
      .text(`Meeting ID: ${String(meet._id)}`);
    doc.text(`Status: ${String(meet.status).toUpperCase()}`);
    doc.text(`Timezone: ${tz}`);
    if (tableId) doc.text(`Table: ${tableId.toUpperCase()}`);
    doc.moveDown();

    doc.fontSize(14).fillColor("#000").text("Details", { underline: true });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor("#333");
    doc.text(`Date: ${when.date}`);
    doc.text(`Time: ${when.time} (${tz})`);
    doc.text(`Subject: ${meet.subject || "—"}`);
    if (meet.message) doc.text(`Message: ${meet.message}`);
    if (vLink) {
      doc.moveDown(0.25);
      doc
        .fontSize(12)
        .fillColor("#0ea5e9")
        .text(`Virtual link: ${vLink}`, { link: vLink, underline: true });
      doc.fillColor("#333");
    }

    doc.moveDown();
    doc
      .fontSize(14)
      .fillColor("#000")
      .text("Participants", { underline: true });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor("#333");
    doc.text(`You: ${actor.name}${actor.org ? ` (${actor.org})` : ""}`);
    doc.text(`Partner: ${other.name}${other.org ? ` (${other.org})` : ""}`);
    doc.moveDown(1);

    // QR is optional: only rendered if qrPngBuffer is provided (i.e., recipient is physical)
    if (qrPngBuffer) {
      const imgSize = 220;
      try {
        doc
          .fontSize(14)
          .fillColor("#000")
          .text("Check-in QR", { underline: true });
        doc.moveDown(0.25);
        doc.image(qrPngBuffer, { fit: [imgSize, imgSize] });
        doc.moveDown(0.5);
      } catch (e) {
        doc
          .fontSize(10)
          .fillColor("red")
          .text(`QR render failed: ${e?.message || e}`);
      }
    }

    doc.moveDown(1);
    doc
      .fontSize(9)
      .fillColor("#666")
      .text(
        "Keep this PDF handy. Arrive 5 minutes before your slot. Physical attendees use the QR to enter the room."
      );
  });
}

async function decMeetingSlotUsed(eventId, slotISO) {
  if (!eventId || !slotISO) return;
  console.log(
    "[decMeetingSlotUsed] eventId=%s slotISO=%s",
    String(eventId),
    slotISO
  );
  // Avoid negatives: only decrement when used > 0
  const r = await MeetingSlot.updateOne(
    { eventId, slotISO, used: { $gt: 0 } },
    { $inc: { used: -1 } }
  );
  console.log("[decMeetingSlotUsed] updateOne result=", r);
  if (!r.matchedCount) {
    console.log("[decMeetingSlotUsed] no decrement (missing doc or used==0)");
  }
}

// NOTE: FIXED — use your 5-arg sendMail(to, subject, html, text, attachments)
async function sendConfirmEmailsWithPDF(meet) {
  console.log("[sendConfirmEmailsWithPDF] meetingId=", String(meet._id));
  const [senderDoc, receiverDoc, ev] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
    Event.findById(meet.eventId)
      .select("title name timezone city country venue postsCount")
      .lean(),
  ]);
  const s = {
    ...getMeta(senderDoc, meet.senderRole),
    _id: meet.senderId,
    virtual: !!senderDoc?.virtualMeet,
  };
  const r = {
    ...getMeta(receiverDoc, meet.receiverRole),
    _id: meet.receiverId,
    virtual: !!receiverDoc?.virtualMeet,
  };
  console.log("[sendConfirmEmailsWithPDF] s=", s, "r=", r, "ev=", ev);

  const FRONT = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
  const tz = ev?.timezone || "UTC";
  const when = fmtLocal(meet.slotISO, tz);
  const evTitle = ev?.title || ev?.name || "Event";
  const meetLink = meet.meetLink || `${FRONT}/vmeet/${String(meet._id)}`; // ensure present

  const htmlBase = (whoName, otherName, isPhysical) => {
    const qrLine = isPhysical
      ? "Your <b>PDF ticket</b> includes your personal QR code for venue check-in."
      : "This is a virtual participant. Your PDF includes the meeting details and link.";
    return `
      <div style="background:#f6f7f9;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;border-collapse:separate;border-spacing:0">
          <tr>
            <td style="padding:0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
                <tr>
                  <td style="padding:18px 20px;background:#0ea5e9;color:#fff;font:700 18px/1.2 Inter,Segoe UI,Roboto,Arial,sans-serif">
                    Meeting confirmed
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 20px 10px;color:#0f172a;font:700 16px/1.4 Inter,Segoe UI,Roboto,Arial,sans-serif">
                    Hi ${whoName || "there"}, your meeting is set ✅
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 20px 8px;color:#334155;font:500 14px/1.6 Inter,Segoe UI,Roboto,Arial,sans-serif">
                    You’re meeting with <b>${otherName}</b>.
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 20px 0">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
                      <tr>
                        <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">When</td>
                        <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${
                          when.date
                        } — ${when.time} (${tz})</td>
                      </tr>
                      <tr style="background:#fafafa">
                        <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">Subject</td>
                        <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${
                          meet.subject || "—"
                        }</td>
                      </tr>
                      ${
                        meet.tableId
                          ? `
                      <tr>
                        <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">Table</td>
                        <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${String(
                          meet.tableId
                        ).toUpperCase()}</td>
                      </tr>
                      `
                          : ""
                      }
                      <tr>
                        <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">Virtual link</td>
                        <td style="padding:10px 12px">
                          <a href="${meetLink}" style="color:#0ea5e9;font:700 13px Inter;text-decoration:none">${meetLink}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 20px 0;color:#334155;font:500 13px/1.6 Inter">
                    ${qrLine}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px 22px">
                    <a href="${FRONT}/meetings"
                       style="display:inline-block;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:10px;font:800 13px Inter">
                      Open my meetings
                    </a>
                  </td>
                </tr>
              </table>
              <div style="color:#94a3b8;font:500 11px/1.6 Inter;margin-top:10px;text-align:center">
                This is an automated message from Eventra.
              </div>
            </td>
          </tr>
        </table>
      </div>
    `;
  };

  // Build PDFs:
  // - Physical recipients: include QR
  // - Virtual recipients: no QR (pass null)
  const urlFor = (actorId) =>
    `${FRONT}/admin/marking?meetId=${meet._id}&actorId=${actorId}`;

  const qrOrNull = async (isPhysical, actorId) => {
    if (!isPhysical) return null;
    return QRCode.toBuffer(urlFor(actorId), {
      type: "png",
      errorCorrectionLevel: "M",
      scale: 8,
      margin: 1,
    });
  };

  const [qrS, qrR] = await Promise.all([
    qrOrNull(!s.virtual, meet.senderId),
    qrOrNull(!r.virtual, meet.receiverId),
  ]);

  const [pdfS, pdfR] = await Promise.all([
    buildMeetingPDF({
      meet,
      eventObj: ev,
      actor: s,
      other: r,
      qrPngBuffer: qrS,
    }),
    buildMeetingPDF({
      meet,
      eventObj: ev,
      actor: r,
      other: s,
      qrPngBuffer: qrR,
    }),
  ]);

  const textSummary = `Your meeting is confirmed. Date: ${when.date} — ${
    when.time
  } (${tz}). Subject: ${meet.subject || "—"}.`;
  const attS = [
    {
      filename: `Meeting-${String(meet._id)}-YOU.pdf`,
      content: pdfS,
      contentType: "application/pdf",
    },
  ];
  const attR = [
    {
      filename: `Meeting-${String(meet._id)}-YOU.pdf`,
      content: pdfR,
      contentType: "application/pdf",
    },
  ];

  // Send
  const tasks = [];
  if (s.email) {
    tasks.push(
      sendMail(
        s.email,
        `${evTitle} · Meeting confirmed`,
        htmlBase(s.name, r.name, !s.virtual),
        textSummary,
        attS
      )
    );
  }
  if (r.email) {
    tasks.push(
      sendMail(
        r.email,
        `${evTitle} · Meeting confirmed`,
        htmlBase(r.name, s.name, !r.virtual),
        textSummary,
        attR
      )
    );
  }
  await Promise.all(tasks);
  console.log(
    "[sendConfirmEmailsWithPDF] done (PDFs sent; QR only to physical)."
  );
}

async function sendActionEmail(meet, type) {
  console.log("[sendActionEmail] meetingId=%s type=%s", String(meet._id), type);

  const [senderDoc, receiverDoc, ev] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
    Event.findById(meet.eventId).select("title name timezone").lean(),
  ]);

  const s = { ...getMeta(senderDoc, meet.senderRole), _id: meet.senderId };
  const r = {
    ...getMeta(receiverDoc, meet.receiverRole),
    _id: meet.receiverId,
  };

  const FRONT = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
  const tz = ev?.timezone || "UTC";
  const evTitle = ev?.title || ev?.name || "Event";

  // IMPORTANT: choose the right time for emails
  // - rescheduled -> show proposedNewAt if present
  // - others      -> prefer slotISO, then proposedNewAt, then requestedAt
  const whenIso =
    type === "rescheduled"
      ? meet.proposedNewAt || meet.slotISO || meet.requestedAt
      : meet.slotISO || meet.proposedNewAt || meet.requestedAt;

  const when = fmtLocal(whenIso, tz);

  const types = {
    rejected: {
      subj: `${evTitle} · Meeting request rejected`,
      intro: `${r.name} has rejected the meeting request.`,
    },
    cancelled: {
      subj: `${evTitle} · Meeting cancelled`,
      intro: `The meeting has been cancelled.`,
    },
    rescheduled: {
      subj: `${evTitle} · New time proposed`,
      intro: `${
        meet.proposedBy && asStr(meet.proposedBy) === asStr(s._id)
          ? s.name
          : r.name
      } proposed a new time.`,
    },
  };
  const t = types[type];
  if (!t) {
    console.log("[sendActionEmail] unknown type -> skip");
    return;
  }

  const html = `
    <div style="background:#f6f7f9;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;border-collapse:separate;border-spacing:0">
        <tr>
          <td style="padding:0">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
              <tr>
                <td style="padding:18px 20px;background:#0ea5e9;color:#fff;font:700 18px/1.2 Inter,Segoe UI,Roboto,Arial,sans-serif">
                  ${t.subj.replace(`${evTitle} · `, "")}
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px 6px;color:#0f172a;font:700 16px/1.4 Inter">
                  ${t.intro}
                </td>
              </tr>
              <tr>
                <td style="padding:0 20px 0">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
                    <tr>
                      <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">Subject</td>
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${
                        meet.subject || "—"
                      }</td>
                    </tr>
                    <tr style="background:#fafafa">
                      <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">When</td>
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${
                        when.date
                      } — ${when.time} (${tz})</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px 22px">
                  <a href="${FRONT}/meetings"
                     style="display:inline-block;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:10px;font:800 13px Inter">
                    Open meetings
                  </a>
                </td>
              </tr>
            </table>
            <div style="color:#94a3b8;font:500 11px/1.6 Inter;margin-top:10px;text-align:center">
              This is an automated message from Eventra.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;

  const tasks = [];
  if (s.email) {
    console.log("[sendActionEmail] -> sender", s.email);
    tasks.push(sendMail(s.email, t.subj, html));
  }
  if (r.email) {
    console.log("[sendActionEmail] -> receiver", r.email);
    tasks.push(sendMail(r.email, t.subj, html));
  }
  await Promise.all(tasks);
  console.log("[sendActionEmail] done.");
}
function tableCodeFromIndex(idx, perLetter = 3) {
  // a1..a3, b1..b3, c1..c3 ...
  const letterIndex = Math.floor(idx / perLetter);
  const number = (idx % perLetter) + 1;
  const letter = String.fromCharCode("a".charCodeAt(0) + letterIndex);
  return `${letter}${number}`;
}

async function reserveTableIndex(eventId, slotISO) {
  // atomic get&inc counter for this (eventId, slotISO)
  const doc = await MeetingTableCounter.findOneAndUpdate(
    { eventId, slotISO },
    { $setOnInsert: { eventId, slotISO, next: 0 }, $inc: { next: 1 } },
    { new: true, upsert: true }
  ).lean();
  // we want the allocated index = new.next - 1
  return Math.max(0, Number(doc?.next || 1) - 1);
}

async function loadVirtualFlags(senderId, receiverId) {
  const loadV = async (id) => {
    let d = null;
    try {
      d = await (global.Attendee || Attendee)
        ?.findById(id)
        .select("virtualMeet")
        .lean();
    } catch {}
    if (!d) {
      try {
        d = await (global.Exhibitor || Exhibitor)
          ?.findById(id)
          .select("virtualMeet")
          .lean();
      } catch {}
    }
    if (!d) {
      try {
        d = await (global.Speaker || Speaker)
          ?.findById(id)
          .select("virtualMeet")
          .lean();
      } catch {}
    }
    return !!d?.virtualMeet;
  };
  const [sV, rV] = await Promise.all([loadV(senderId), loadV(receiverId)]);
  return { senderVirtual: sV, receiverVirtual: rV };
}
// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// CONFIG + SHARED UTILS
// ──────────────────────────────────────────────────────────────────────────────
const PER_LETTER = 5; // A1..A5, B1..B5, ...

function normISO(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  d.setSeconds(0, 0);
  const snapped = Math.floor(d.getTime() / STEP_MS) * STEP_MS;
  return new Date(snapped).toISOString();
}

// ──────────────────────────────────────────────────────────────────────────────
// TABLE HELPERS (physical vs hybrid are separate namespaces)
// ──────────────────────────────────────────────────────────────────────────────
function* tableCodeGenerator(perLetter = PER_LETTER, kind = "physical") {
  // physical => A1, A2, ... ; hybrid => A1-h, A2-h, ...
  const suffix = kind === "hybrid" ? "-h" : "";
  let li = 0;
  while (true) {
    const letter = String.fromCharCode("A".charCodeAt(0) + li);
    for (let n = 1; n <= perLetter; n++) yield `${letter}${n}${suffix}`;
    li++;
  }
}

function parseTableCode(code = "") {
  // supports A1 and A1-h
  const m = String(code)
    .trim()
    .toUpperCase()
    .match(/^([A-Z])(\d{1,2})(-H)?$/);
  if (!m) return null;
  return {
    letterIdx: m[1].charCodeAt(0) - "A".charCodeAt(0),
    num: Number(m[2]),
    kind: m[3] ? "hybrid" : "physical",
  };
}

async function nextTableIdForSlot(
  eventId,
  slotISO,
  perLetter = PER_LETTER,
  kind = "physical"
) {
  // Only confirmed meetings on THIS (eventId, slotISO)
  const rows = await MeetRequest.find({
    eventId,
    status: "confirmed",
    slotISO: new Date(slotISO),
    tableId: { $exists: true, $ne: null },
  })
    .select("tableId")
    .lean();

  // Partition namespace: hybrid (‘-h’) vs physical (no suffix)
  const used = new Set(
    (rows || [])
      .map((r) => String(r.tableId || "").toUpperCase())
      .filter(Boolean)
      .filter((code) =>
        kind === "hybrid" ? /-H$/.test(code) : !/-H$/.test(code)
      )
  );

  // Gap-fill in lexical order: A1..A5, B1..B5, ...
  for (const code of tableCodeGenerator(perLetter, kind)) {
    if (!used.has(code)) return code;
  }
  // Fallback (practically unreachable)
  return kind === "hybrid" ? "Z999-H" : "Z999";
}

// ──────────────────────────────────────────────────────────────────────────────
async function passesWhitelist(eventId, senderId, receiverId, iso) {
  const [wS, wR] = await Promise.all([
    SlotWhitelist.findOne({ eventId, actorId: senderId })
      .select("slots")
      .lean(),
    SlotWhitelist.findOne({ eventId, actorId: receiverId })
      .select("slots")
      .lean(),
  ]);
  const sArr = Array.isArray(wS?.slots) ? wS.slots : [];
  const rArr = Array.isArray(wR?.slots) ? wR.slots : [];
  const hasS = sArr.length > 0;
  const hasR = rArr.length > 0;
  if (!hasS && !hasR) return true; // no whitelist → open

  const key = normISO(iso);
  const sSet = hasS ? new Set(sArr.map((x) => normISO(x))) : null;
  const rSet = hasR ? new Set(rArr.map((x) => normISO(x))) : null;
  const passS = !hasS || sSet.has(key);
  const passR = !hasR || rSet.has(key);
  return passS && passR; // intersection
}

function pickTime(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

async function validateRescheduleSlot({ eventId, senderId, receiverId, iso }) {
  const key = normISO(iso);
  if (!key) return { ok: false, reason: "bad-iso" };

  // Event range
  const ev = await Event.findById(eventId).select("startDate endDate").lean();
  if (!ev?.startDate || !ev?.endDate)
    return { ok: false, reason: "no-event-range" };
  const t = new Date(key).getTime();
  const a = new Date(ev.startDate).getTime();
  const b = new Date(ev.endDate).getTime();
  if (!(t >= a && t <= b)) return { ok: false, reason: "outside-event" };

  // Whitelist
  const wlOk = await passesWhitelist(eventId, senderId, receiverId, key);
  if (!wlOk) return { ok: false, reason: "whitelist" };

  // Virtual case: both virtual → OK inside event range
  const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
    senderId,
    receiverId
  );
  const bothVirtual = senderVirtual && receiverVirtual;
  if (bothVirtual) return { ok: true };

  // Otherwise must fall inside a B2B session window the same day
  const dayIso = new Date(key).toISOString().slice(0, 10);
  const dayStart = new Date(`${dayIso}T00:00:00.000Z`);
  const dayEndEx = new Date(`${dayIso}T24:00:00.000Z`);

  const sessions = await Schedule.find({
    $and: [
      { $or: [{ id_event: eventId }, { eventId }] },
      { track: { $regex: /b2b/i } },
      {
        $or: [
          {
            $and: [
              { startTime: { $lt: dayEndEx } },
              { endTime: { $gt: dayStart } },
            ],
          },
          {
            $and: [
              { startAt: { $lt: dayEndEx } },
              { endAt: { $gt: dayStart } },
            ],
          },
          { $and: [{ start: { $lt: dayEndEx } }, { end: { $gt: dayStart } }] },
        ],
      },
    ],
  })
    .select("track startTime endTime startAt endAt start end")
    .lean();

  if (!Array.isArray(sessions) || !sessions.length)
    return { ok: false, reason: "no-b2b-sessions" };

  const tms = new Date(key).getTime();
  const inside = sessions.some((s) => {
    const S = pickTime(s, "startTime", "startAt", "start");
    const E = pickTime(s, "endTime", "endAt", "end");
    if (!S || !E) return false;
    return tms >= S.getTime() && tms < E.getTime();
  });

  return inside ? { ok: true } : { ok: false, reason: "outside-b2b-window" };
}

// ──────────────────────────────────────────────────────────────────────────────
// ACTION
// ──────────────────────────────────────────────────────────────────────────────
exports.makeMeetingAction = asyncHandler(async (req, res) => {
  console.log("================ [makeMeetingAction] START ================");
  console.log("[makeMeetingAction:req.body]=", req.body);

  const { meetingId, action, actorId, proposedNewAt } = req.body || {};
  if (!mongoose.isValidObjectId(meetingId))
    return res.status(400).json({ message: "Bad meetingId" });

  const meId = String(req.user._id);
  const meRole = String(req.user.role || "").toLowerCase();
  const meIsAdmin = meRole === "admin";
  if (!meIsAdmin && actorId && String(actorId) !== meId)
    return res.status(403).json({ message: "Forbidden" });

  const meet = await MeetRequest.findById(meetingId).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });

  const { isSender, isReceiver } = whoAmI(meet, meId);
  if (!isSender && !isReceiver && !meIsAdmin)
    return res.status(403).json({ message: "Forbidden" });

  const prevStatus = String(meet.status || "").toLowerCase();
  const act = String(action || "").toLowerCase();
  const allowed = computeAllowedActions(meet, meId, meIsAdmin);
  if (!allowed.includes(act))
    return res
      .status(400)
      .json({ message: "Action not allowed for this user/state" });

  const now = new Date();
  const $set = { updatedAt: now };
  const $unset = {};
  let finalISO = null;

  if (act === "confirm") {
    const originalISO = normISO(meet.slotISO || meet.requestedAt);
    const reschedISO = normISO(meet.proposedNewAt);
    finalISO =
      prevStatus === "rescheduled" && reschedISO ? reschedISO : originalISO;
    if (!finalISO)
      return res.status(400).json({ message: "No slot to confirm" });

    // Ensure capacity doc exists (do NOT increment here)
    await ensureCapDoc(meet.eventId, finalISO);

    // compute virtuality BEFORE using it
    const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
      meet.senderId,
      meet.receiverId
    );
    const bothVirtual = senderVirtual && receiverVirtual;
    const halfVirtual = senderVirtual !== receiverVirtual;

    // lock actors on this slot (prevents future overlaps)
    await lockActors(meet.eventId, finalISO, meet.senderId, meet.receiverId);

    // always set virtual meet link (even for physical/hybrid)
    const FRONT_URL =
      (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
    $set.meetLink = `${FRONT_URL}/vmeet/${String(meet._id)}`;

    // assign physical/hybrid table id by namespace (hybrid -> "-h")
    if (!bothVirtual) {
      const kind = halfVirtual ? "hybrid" : "physical";
      $set.tableId = await nextTableIdForSlot(
        meet.eventId,
        finalISO,
        PER_LETTER,
        kind
      );
      console.log("[confirm] table assigned (%s) -> %s", kind, $set.tableId);
    } else {
      $unset.tableId = 1; // purely virtual → no table
    }

    // finalize mutation
    $set.status = "confirmed";
    $set.acceptedAt = now;
    $set.slotISO = new Date(finalISO);
    $unset.proposedNewAt = 1;
    $unset.proposedBy = 1;
    
  }

  // ───────── REJECT ─────────
  if (act === "reject") {
    $set.status = "rejected";
    $set.rejectedAt = now;
    $set.rejectedBy = req.user._id;

    const decISO = normISO(meet.slotISO || meet.requestedAt);
    if (decISO) {
      await decMeetingSlotUsed(meet.eventId, decISO);
      await unlockActors(meet.eventId, decISO, meet.senderId, meet.receiverId);
    }
    $unset.tableId = 1;
  }

  // ───────── CANCEL ─────────
  if (act === "cancel") {
    $set.status = "cancelled";
    $set.cancelledAt = now;
    $set.cancelledBy = req.user._id;

    const decISO = normISO(meet.slotISO || meet.requestedAt);
    if (decISO) {
      await unlockActors(meet.eventId, decISO, meet.senderId, meet.receiverId);
      await decMeetingSlotUsed(meet.eventId, decISO);
    }

    if (prevStatus === "confirmed") {
      await MeetingBlacklist.updateOne(
        { meetingId: meet._id },
        {
          $setOnInsert: {
            meetingId: meet._id,
            eventId: meet.eventId,
            actors: [meet.senderId, meet.receiverId],
            reason: "cancelled-after-confirmation",
            createdAt: now,
          },
        },
        { upsert: true }
      );
    }
    $unset.tableId = 1;
  }

  // ───────── RESCHEDULE (full checks like request; NO increment) ─────────
  if (act === "reschedule") {
    const tISO = normISO(proposedNewAt);
    if (!tISO)
      return res
        .status(400)
        .json({ message: "proposedNewAt must be a valid ISO datetime" });

    const v = await validateRescheduleSlot({
      eventId: meet.eventId,
      senderId: meet.senderId,
      receiverId: meet.receiverId,
      iso: tISO,
    });
    if (!v.ok) {
      const map = {
        "bad-iso": "Invalid time format",
        "no-event-range": "Event has no date range",
        "outside-event": "Selected time is outside event dates",
        whitelist: "Selected time is not allowed by whitelist",
        "no-b2b-sessions": "No B2B sessions are scheduled for this day",
        "outside-b2b-window": "Selected time is outside B2B session windows",
      };
      return res
        .status(409)
        .json({ message: map[v.reason] || "Selected time is not allowed" });
    }

    const actorIds = [String(meet.senderId), String(meet.receiverId)];
    const busy = await existsBusyAt(meet.eventId, tISO, actorIds, meet._id);
    if (busy)
      return res
        .status(409)
        .json({
          message: "One of the participants is busy at the proposed time",
        });

    await ensureCapDoc(meet.eventId, tISO);

    $set.status = "rescheduled";
    $set.proposedNewAt = new Date(tISO);
    $set.proposedBy = req.user._id;
    $unset.tableId = 1; // tables only on confirm
  }

  // ───────── DELETE ─────────
  if (act === "delete") {
    const { isReceiver } = whoAmI(meet, meId);
    if (!(prevStatus === "rejected" && isReceiver) && !meIsAdmin) {
      return res
        .status(400)
        .json({
          message: "Delete allowed only to receiver when status is rejected",
        });
    }

    const decISO = normISO(meet.slotISO || meet.requestedAt);
    if (decISO) {
      await unlockActors(meet.eventId, decISO, meet.senderId, meet.receiverId);
      await decMeetingSlotUsed(meet.eventId, decISO);
    }

    await MeetingBlacklist.updateOne(
      { meetingId: meet._id },
      {
        $setOnInsert: {
          meetingId: meet._id,
          eventId: meet.eventId,
          actors: [meet.senderId, meet.receiverId],
          reason: "deleted",
          createdAt: now,
        },
      },
      { upsert: true }
    );

    await MeetRequest.deleteOne({ _id: meet._id });
    console.log(
      "================ [makeMeetingAction] END (delete) ================"
    );
    return res.json({ success: true, message: "Deleted" });
  }

  // ───────── persist + emails ─────────
  await MeetRequest.updateOne(
    { _id: meetingId },
    { $set, ...(Object.keys($unset).length ? { $unset } : {}) }
  );

  const updated = await MeetRequest.findById(meetingId).lean();
  try {
      const meetUrl = `/meetings/${String(updated._id)}`;
      const actLabel =
        act === "confirm"
          ? "confirmed"
          : act === "reject"
          ? "rejected"
          : act === "reschedule"
          ? "rescheduled"
          : "cancelled";
      await ActorNotification.create([
        {
          actorId: updated.senderId,
          title: `Meeting ${actLabel}`,
          body: `Your meeting with ${String(
            updated.receiverId
          )} was ${actLabel}.`,
          link: meetUrl,
          priority: 4,
        },
        {
          actorId: updated.receiverId,
          title: `Meeting ${actLabel}`,
          body: `Your meeting with ${String(
            updated.senderId
          )} was ${actLabel}.`,
          link: meetUrl,
          priority: 4,
        },
      ]);
    } catch (e) {
      console.error("[notif][makeMeetingAction]", e?.message || e);
    }
  try {
    if (act === "confirm"){ await sendConfirmEmailsWithPDF(updated); await scheduleMeetingReminder(updated);
}
    
    else if (act === "reject") await sendActionEmail(updated, "rejected");
    else if (act === "reschedule")
      await sendActionEmail(updated, "rescheduled");
    else if (act === "cancel") await sendActionEmail(updated, "cancelled");
  } catch (e) {
    console.error("[emails] error:", e?.message || e);
  }

  const allowedAfter = computeAllowedActions(updated, meId, meIsAdmin);
  console.log("================ [makeMeetingAction] END (ok) ================");
  return res.json({
    success: true,
    message: "OK",
    data: { ...updated, allowedActions: allowedAfter },
  });
});

// GET /meets/suggested?actorId=...&eventId=...&limit=20&pool=50&search=...&role=attendee|exhibitor|speaker&lang=en&country=TN&open=1
exports.getSuggestedList = asyncHandler(async (req, res) => {
  const meId = req.user?._id || req.query.actorId;
  if (!mongoose.isValidObjectId(meId)) {
    return res.status(400).json({ message: "Bad actorId" });
  }
  console.log("[getSuggestedList] START", {
    meId: String(meId),
    qEventId: String(req.query.eventId || ""),
    qRole: String(req.query.role || ""),
    qLimit: String(req.query.limit || ""),
    qPool: String(req.query.pool || ""),
    qOpen: String(req.query.open || ""),
    qLang: req.query.lang,
    qCountry: req.query.country,
  });
  // ---- helpers ---------------------------------------------------
  const toStr = (v) => (v == null ? "" : String(v));
  const norm = (s) => toStr(s).trim().toLowerCase();
  const getp = (obj, path) =>
    path
      .split(".")
      .reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
  const arrify = (x) => (Array.isArray(x) ? x.filter(Boolean) : x ? [x] : []);
  const uniq = (a) => Array.from(new Set((a || []).filter(Boolean)));
  const words = (x) =>
    uniq(
      arrify(x)
        .flatMap((s) => String(s).split(/[,;/|]+|\s+/g))
        .map(norm)
        .filter((t) => t && t.length >= 2 && t !== "and" && t !== "or")
    );
  const extrasFromDoc = (role, doc) => {
    const r = String(role || "").toLowerCase();
    if (r === "attendee") {
      return {
        jobTitle: getp(doc, "organization.jobTitle") || "",
        orgName: getp(doc, "organization.orgName") || "",
        city: getp(doc, "personal.city") || "",
        country: getp(doc, "personal.country") || "",
        objectives: arrify(getp(doc, "matchingIntent.objectives"))
          .map(toStr)
          .filter(Boolean),
      };
    }
    if (r === "exhibitor") {
      return {
        jobTitle: "",
        orgName: getp(doc, "identity.orgName") || "",
        city: getp(doc, "identity.city") || "",
        country: getp(doc, "identity.country") || "",
        objectives: arrify(getp(doc, "commercial.lookingFor"))
          .map(toStr)
          .filter(Boolean),
      };
    }
    // speaker
    return {
      jobTitle: getp(doc, "organization.jobTitle") || "",
      orgName: getp(doc, "organization.orgName") || "",
      city: getp(doc, "personal.city") || "",
      country: getp(doc, "personal.country") || "",
      objectives: arrify(getp(doc, "b2bIntent.lookingFor"))
        .map(toStr)
        .filter(Boolean),
    };
  };

  const langAliases = {
    en: "english",
    eng: "english",
    english: "english",
    fr: "french",
    french: "french",
    ar: "arabic",
    arabic: "arabic",
    es: "spanish",
    spanish: "spanish",
    de: "german",
    german: "german",
    it: "italian",
    italian: "italian",
  };
  const langTokens = (x) => uniq(words(x).map((t) => langAliases[t] || t));

  const DEFAULT_PHOTO_RX = /\/default\/photodef\.png$/i;

  const getModelByRole = (role) => {
    const r = String(role || "").toLowerCase();
    if (r === "attendee") return attendee;
    if (r === "exhibitor") return Exhibitor;
    if (r === "speaker") return Speaker;
    return null;
  };

  const displayFromDoc = (role, doc) => {
    const r = String(role || "").toLowerCase();
    if (r === "attendee") {
      return {
        name: getp(doc, "personal.fullName") || "",
        photo: getp(doc, "personal.profilePic") || "",
      };
    }
    if (r === "exhibitor") {
      return {
        name:
          getp(doc, "identity.exhibitorName") ||
          getp(doc, "identity.orgName") ||
          getp(doc, "identity.contactName") ||
          "",
        photo: getp(doc, "identity.logo") || "",
      };
    }
    // speaker
    return {
      name: getp(doc, "personal.fullName") || "",
      photo: getp(doc, "personal.profilePic") || "",
    };
  };

  // vector extraction per role (keep light & robust)
  const VECTORS = {
    attendee: {
      langs: ["personal.preferredLanguages"],
      industry: ["businessProfile.primaryIndustry"],
      offering: ["businessProfile.offering"],
      looking: ["matchingIntent.objectives"],
      regions: [],
      openFlag: ["matchingIntent.openToMeetings"],
      event: ["id_event"],
    },
    exhibitor: {
      langs: ["identity.preferredLanguages"],
      industry: ["business.industry"],
      offering: ["commercial.offering"],
      looking: ["commercial.lookingFor"],
      regions: ["commercial.regionInterest"],
      openFlag: ["commercial.availableMeetings"],
      event: ["id_event"],
    },
    speaker: {
      langs: ["personal.preferredLanguages", "talk.language"],
      industry: ["b2bIntent.businessSector"],
      offering: ["b2bIntent.offering"],
      looking: ["b2bIntent.lookingFor"],
      regions: ["b2bIntent.regionsInterest"],
      openFlag: ["b2bIntent.openMeetings"],
      event: ["id_event"],
    },
  };

  const pickFirst = (doc, paths) => {
    for (const p of paths || []) {
      const v = getp(doc, p);
      if (v != null && v !== "") return v;
    }
    return undefined;
  };

  const extractVectors = (role, doc) => {
    const v = VECTORS[role];
    const eventId = pickFirst(doc, v.event) || null;
    const looking = words(v.looking.flatMap((p) => arrify(getp(doc, p))));
    const offering = words(v.offering.flatMap((p) => arrify(getp(doc, p))));
    const regions = words(v.regions.flatMap((p) => arrify(getp(doc, p)))).map(
      norm
    );
    const industries = words(
      v.industry.flatMap((p) => arrify(getp(doc, p)))
    ).map(norm);
    const languages = uniq(
      langTokens(v.langs.flatMap((p) => arrify(getp(doc, p))))
    );
    const open = v.openFlag.length
      ? v.openFlag.some((p) => !!getp(doc, p))
      : false;
    return { eventId, looking, offering, regions, industries, languages, open };
  };

  const scorePair = (meV, otherV) => {
    let s = 0;
    // intent complementarity
    const syn = (t) =>
      ({
        partners: "partnership",
        partner: "partnership",
        investment: "investor",
        invest: "investor",
        hire: "recruitment",
        recruit: "recruitment",
      }[t] || t);
    const meL = meV.looking.map(syn),
      meO = meV.offering.map(syn);
    const otL = otherV.looking.map(syn),
      otO = otherV.offering.map(syn);

    const lxo = meL.filter((t) => otO.includes(t)).length;
    s += lxo * 5.5; // +10%
    const oxl = meO.filter((t) => otL.includes(t)).length;
    s += oxl * 4.5; // +12.5%

    // context overlaps
    const reg = meV.regions.filter((t) => otherV.regions.includes(t)).length;
    s += reg * 2;
    const ind = meV.industries.filter((t) =>
      otherV.industries.includes(t)
    ).length;
    s += ind * 3;
    const lng = meV.languages.filter((t) =>
      otherV.languages.includes(t)
    ).length;
    s += lng * 1.5;
    return s; // raw semantic score
  };

  // ---- locate "me" & event context --------------------------------
  const qEvent = toStr(req.query.eventId || "");
  let meDoc = null,
    meRole = null,
    eventId = qEvent || null;

  for (const role of ["attendee", "exhibitor", "speaker"]) {
    const M = getModelByRole(role);
    const d = await M.findById(meId)
      .lean()
      .catch(() => null);
    if (d) {
      meDoc = d;
      meRole = role;
      if (!eventId) {
        const ev = extractVectors(role, d).eventId;
        if (ev) eventId = String(ev);
      }
      break;
    }
  }
  if (!meDoc) return res.status(404).json({ message: "Actor not found" });
  if (!eventId)
    return res
      .status(400)
      .json({ message: "eventId is required (could not infer)" });

  const meV = extractVectors(meRole, meDoc);
  if (String(meV.eventId) !== String(eventId)) {
    // enforce matching within the specified event
    meV.eventId = eventId;
  }

  // ---- build exclusions: existing threads + blocks -----------------
  const existing = await MeetRequest.find({
    eventId,
    $or: [{ senderId: meId }, { receiverId: meId }],
  })
    .select("senderId receiverId")
    .lean();

  const excludedIds = new Set([String(meId)]);
  existing.forEach((m) => {
    excludedIds.add(String(m.senderId));
    excludedIds.add(String(m.receiverId));
  });

  // optional: respect blocks if model exists
  let BlockModel = null;
  try {
    BlockModel = Block;
  } catch {
    BlockModel = null;
  }
  if (BlockModel?.find) {
    const bl = await BlockModel.find({
      $or: [{ blockerId: meId }, { blockedId: meId }],
    })
      .select("blockerId blockedId")
      .lean();
    for (const b of bl) {
      if (String(b.blockerId) === String(meId))
        excludedIds.add(String(b.blockedId));
      if (String(b.blockedId) === String(meId))
        excludedIds.add(String(b.blockerId));
    }
  }

  // ---- request parameters / filters --------------------------------
  const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 20));
  const poolCap = Math.max(limit, Math.min(200, Number(req.query.pool) || 50));

  const roleFilter = (req.query.role || "").toString().toLowerCase(); // optional single role
  const search = toStr(req.query.search || "");
  const rx = search
    ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;

  const countryF = toStr(req.query.country || "").toUpperCase(); // optional ISO key
  const langsF = uniq(arrify(req.query.lang).map((x) => norm(x))); // ?lang=en&lang=fr or lang=en,fr

  const openOnly = ["1", "true", "yes", "y"].includes(
    norm(req.query.open || "1")
  ); // default: true

  // ---- pull per-role candidates ------------------------------------
  const roleOrder = roleFilter
    ? [roleFilter]
    : ["attendee", "exhibitor", "speaker"];

  const baseFindFor = (role) => {
    // verified + adminVerified (for non-speakers) + event + open flag + search/country/lang filters
    const Model = getModelByRole(role);
    if (!Model) return { Model: null, q: null, proj: null };

    const v = VECTORS[role];

    const orAdmin =
      role === "speaker"
        ? [{}] // speakers may not always carry adminVerified in your DB
        : [{ adminVerified: "yes" }, { adminVerified: true }];

    const q = {
      id_event: eventId,
      _id: { $nin: Array.from(excludedIds) },
      $and: [{ $or: orAdmin }],
    };

    if (openOnly && v.openFlag.length) {
      q.$and.push({ $or: v.openFlag.map((p) => ({ [p]: true })) });
    }

    if (rx) {
      const nameOr = (
        role === "attendee"
          ? ["personal.fullName"]
          : role === "exhibitor"
          ? [
              "identity.exhibitorName",
              "identity.orgName",
              "identity.contactName",
            ]
          : ["personal.fullName"]
      ).map((p) => ({ [p]: rx }));
      q.$and.push({ $or: nameOr });
    }

    if (countryF) {
      const cPath =
        role === "exhibitor" ? "identity.country" : "personal.country";
      q.$and.push({ [cPath]: countryF });
    }

    if (langsF.length) {
      const lPaths =
        role === "exhibitor"
          ? ["identity.preferredLanguages"]
          : [
              "personal.preferredLanguages",
              ...(role === "speaker" ? ["talk.language"] : []),
            ];
      q.$and.push({
        $or: lPaths.map((p) => ({ [p]: { $in: langsF } })),
      });
    }

    // projection: fields used by display & scoring
    const proj = {
      createdAt: 1,
      updatedAt: 1,
      verified: 1,
      adminVerified: 1,
      virtualMeet: 1,
      // attendee
      "personal.fullName": 1,
      "personal.profilePic": 1,
      "personal.email": 1,
      "personal.country": 1,
      "personal.city": 1,
      "organization.orgName": 1,
      "organization.jobTitle": 1,
      "personal.preferredLanguages": 1,
      "businessProfile.primaryIndustry": 1,
      "businessProfile.offering": 1,
      "matchingIntent.objectives": 1,
      "matchingIntent.openToMeetings": 1,
      // exhibitor
      "identity.exhibitorName": 1,
      "identity.orgName": 1,
      "identity.contactName": 1,
      "identity.email": 1,
      "identity.city": 1,
      "identity.country": 1,
      "identity.logo": 1,
      "identity.preferredLanguages": 1,
      "business.industry": 1,
      "commercial.offering": 1,
      "commercial.lookingFor": 1,
      "commercial.regionInterest": 1,
      "commercial.availableMeetings": 1,
      // speaker
      "talk.language": 1,
      "b2bIntent.businessSector": 1,
      "b2bIntent.offering": 1,
      "b2bIntent.lookingFor": 1,
      "b2bIntent.regionsInterest": 1,
      "b2bIntent.openMeetings": 1,
      "organization.orgName": 1,
      "organization.jobTitle": 1,
      "personal.city": 1,
      id_event: 1,
    };

    return { Model, q, proj };
  };

  const candidates = [];
  for (const r of roleOrder) {
    const { Model, q, proj } = baseFindFor(r);
    if (!Model) continue;
    console.log("[getSuggestedList] Query role", r, {
      q,
      projKeys: Object.keys(proj || {}),
    });
    const rows = await Model.find(q, proj).limit(400).lean(); // hard cap per role
    console.log("[getSuggestedList] Pulled", rows.length, "docs for role", r);
    for (const d of rows) candidates.push({ role: r, doc: d });
  }

  if (!candidates.length) {
    return res.json({ success: true, count: 0, data: [], eventId });
  }

  // ---- scoring -----------------------------------------------------
  const now = Date.now();
  const normScore = (x, min, max) => {
    if (!Number.isFinite(x)) return 0;
    if (max <= min) return 1;
    return (x - min) / (max - min);
  };

  const scored = candidates.map(({ role, doc }) => {
    const disp = displayFromDoc(role, doc);
    const vec = extractVectors(role, doc);
    const ext = extrasFromDoc(role, doc);
    const semantic = scorePair(meV, vec);

    const hasPhoto =
      !!disp.photo && !DEFAULT_PHOTO_RX.test(String(disp.photo || ""));
    const verifiedBoost =
      (doc.verified ? 1 : 0) +
      (doc.adminVerified === "yes" || doc.adminVerified === true ? 0.5 : 0);
    const completeness =
      [
        disp.name,
        role === "exhibitor"
          ? getp(doc, "commercial.offering")
          : getp(doc, "businessProfile.offering") ||
            getp(doc, "b2bIntent.offering"),
        getp(
          doc,
          role === "exhibitor"
            ? "business.industry"
            : "businessProfile.primaryIndustry"
        ) || getp(doc, "b2bIntent.businessSector"),
        (vec.languages || []).length ? "x" : "",
        (vec.looking || []).length ? "x" : "",
        (vec.offering || []).length ? "x" : "",
      ].filter(Boolean).length / 6;

    const updated = new Date(doc.updatedAt || doc.createdAt || now).getTime();
    const recency =
      0.5 + 0.5 * Math.exp(-(now - updated) / (1000 * 60 * 60 * 24 * 60));

    let score =
      semantic * 1.0 + verifiedBoost * 2.0 + completeness * 3.0 + recency * 1.0;

    score *= hasPhoto ? 1.05 : 0.72;
    score *= 0.97 + Math.random() * 0.06;

    const rawTag =
      toStr(getp(doc, "commercial.lookingFor")) ||
      toStr(getp(doc, "matchingIntent.objectives")) ||
      toStr(getp(doc, "talk.topicCategory")) ||
      "";
    const tag = (rawTag.match(/\bB2[BCG]\b/i) || [null])[0] || "";

    return {
      id: String(doc._id),
      role,
      name: disp.name || "",
      photo: disp.photo || "",
      tag,
      virtual: !!doc.virtualMeet,
      eventId: String(vec.eventId || getp(doc, "id_event") || ""),
      jobTitle: ext.jobTitle,
      orgName: ext.orgName,
      city: ext.city,
      country: ext.country,
      objectives: ext.objectives,
      _score: Math.max(1e-6, score), // raw (pre-normalization)
    };
  });

  // scoring summary
  const min = Math.min(...scored.map((x) => x._score));
  const max = Math.max(...scored.map((x) => x._score));
  const avg = scored.reduce((a, b) => a + b._score, 0) / (scored.length || 1);
  console.log("[getSuggestedList] Scoring stats", {
    candidates: scored.length,
    scoreMin: Number.isFinite(min) ? min : 0,
    scoreMax: Number.isFinite(max) ? max : 0,
    scoreAvg: avg,
  });
  const rangeMin = Number.isFinite(min) ? min : 0;
  const rangeMax = Number.isFinite(max) ? max : 1;
  for (const p of scored) {
    const pct = normScore(p._score, rangeMin, rangeMax); // 0..1
    p.matchPct = Math.round(pct * 100); // 0..100 for UI
  }
  console.log("[getSuggestedList] Normalization", {
    min: rangeMin,
    max: rangeMax,
    sampleTop3: scored
      .slice(0, 3)
      .map((x) => ({ id: x.id, role: x.role, raw: x._score, pct: x.matchPct })),
  });
  // ---- build pool & weighted random  -------------------------------
  // take the top poolCap by score, then do weighted sampling without replacement (Efraimidis-Spirakis)
  scored.sort((a, b) => b._score - a._score);
  const pool = scored.slice(0, Math.min(poolCap, scored.length));

  // Compute keys k = u^(1/w) equivalently key = -ln(u)/w and take smallest keys
  const keyed = pool
    .map((p) => {
      const u = Math.random();
      const key = -Math.log(u) / p._score;
      return { key, p };
    })
    .sort((a, b) => a.key - b.key);

  const out = keyed.slice(0, limit).map(({ p }) => ({
    id: p.id,
    role: p.role,
    name: p.name,
    photo: p.photo,
    tag: p.tag,
    virtual: !!p.virtual,
    matchPct: p.matchPct,
    eventId: p.eventId,
    jobTitle: p.jobTitle,
    orgName: p.orgName,
    city: p.city,
    country: p.country,
    objectives: Array.isArray(p.objectives) ? p.objectives : [],
  }));

  console.log("[getSuggestedList] Pool/meta", {
    poolSize: pool.length,
    returned: out.length,
    sampleTop3: out
      .slice(0, 3)
      .map((x) => ({
        id: x.id,
        role: x.role,
        match: x.matchPct,
        virtual: x.virtual,
      })),
  });

  // small final shuffle so order changes across refreshes
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return res.json({
    success: true,
    eventId,
    me: { id: String(meId), role: meRole },
    meta: { poolSize: pool.length, totalCandidates: scored.length },
    count: out.length,
    data: out,
  });
});

/* ───────────────────── GET /events/:eventId/available-slots ───────
 *  Checks 09:00-17:00 (inclusive) in 30-min steps for a given date.
 *  Needs ?actorId=receiverId&date=YYYY-MM-DD
 */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function toLocalIso(Y, M /*0-based*/, D, h, m) {
  return `${Y}-${pad2(M + 1)}-${pad2(D)}T${pad2(h)}:${pad2(m)}:00`;
}
function pickTime(doc, ...keys) {
  for (const k of keys) {
    const v = doc?.[k];
    const d = v instanceof Date ? v : v ? new Date(v) : null;
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return null;
}
// ───────────────────── GET /events/:eventId/available-slots ───────
exports.listAvailableSlots = asyncHandler(async (req, res) => {
  const { eventId } = req.params || {};
  const dateParam = req.query?.date || req.params?.date; // YYYY-MM-DD
  const receiverId = req.query?.actorId || req.query?.receiverId;

  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });
  if (!receiverId || !mongoose.isValidObjectId(receiverId))
    return res
      .status(400)
      .json({
        message: "actorId (receiver) is required and must be an ObjectId",
      });
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateParam)))
    return res
      .status(400)
      .json({ message: "date is required as YYYY-MM-DD (UTC day)" });

  const senderId = req.user?._id;
  if (!senderId) return res.status(401).json({ message: "Unauthorized" });

  const loadActor = async (id) => {
    const proj = { virtualMeet: 1 };
    let doc = null;
    try {
      doc = await (global.attendee || attendee)?.findById(id, proj).lean();
    } catch {}
    if (!doc) {
      try {
        doc = await (global.Exhibitor || Exhibitor)?.findById(id, proj).lean();
      } catch {}
    }
    if (!doc) {
      try {
        doc = await (global.Speaker || Speaker)?.findById(id, proj).lean();
      } catch {}
    }
    return doc;
  };

  const [senderDoc, receiverDoc] = await Promise.all([
    loadActor(senderId),
    loadActor(receiverId),
  ]);
  const senderVirtual = !!senderDoc?.virtualMeet;
  const receiverVirtual = !!receiverDoc?.virtualMeet;
  const bothVirtual = senderVirtual && receiverVirtual;
  const halfVirtual = senderVirtual !== receiverVirtual;

  // capacity defaults
  let capDefault = 45;
  if (Event) {
    try {
      const ev = await Event.findById(eventId).select("b2bCapacity").lean();
      if (Number(ev?.b2bCapacity) > 0) capDefault = Number(ev.b2bCapacity);
    } catch {}
  }
  let capHybridDefault = 5;
  if (Event) {
    try {
      const ev2 = await Event.findById(eventId).select("postsCount").lean();
      if (Number(ev2?.postsCount) > 0)
        capHybridDefault = Number(ev2.postsCount);
    } catch {}
  }
  if (!Schedule)
    return res
      .status(500)
      .json({ message: "Schedule model not found on server" });

  // day window
  const dayStart = new Date(`${dateParam}T00:00:00.000Z`);
  const dayEndEx = new Date(`${dateParam}T24:00:00.000Z`);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEndEx.getTime();

  // base grid (30-min)
  const slotSet = new Set();
  if (bothVirtual) {
    for (
      let t = Math.ceil(dayStartMs / STEP_MS) * STEP_MS;
      t <= dayEndMs;
      t += STEP_MS
    ) {
      slotSet.add(new Date(t).toISOString());
    }
  } else {
    const b2bRx = /b2b/i;
    const sessions = await Schedule.find({
      $and: [
        { $or: [{ id_event: eventId }, { eventId }] },
        { track: { $regex: b2bRx } },
        {
          $or: [
            {
              $and: [
                { startTime: { $lt: dayEndEx } },
                { endTime: { $gt: dayStart } },
              ],
            },
            {
              $and: [
                { startAt: { $lt: dayEndEx } },
                { endAt: { $gt: dayStart } },
              ],
            },
            {
              $and: [{ start: { $lt: dayEndEx } }, { end: { $gt: dayStart } }],
            },
          ],
        },
      ],
    })
      .select("track startTime endTime startAt endAt start end")
      .lean();

    if (Array.isArray(sessions) && sessions.length) {
      for (const s of sessions) {
        const S = pickTime(s, "startTime", "startAt", "start");
        const E = pickTime(s, "endTime", "endAt", "end");
        if (!S || !E) continue;
        const segStart = Math.max(S.getTime(), dayStartMs);
        const segEnd = Math.min(E.getTime(), dayEndMs);
        if (segEnd - segStart < STEP_MS) continue;
        for (
          let t = Math.ceil(segStart / STEP_MS) * STEP_MS;
          t <= segEnd;
          t += STEP_MS
        ) {
          slotSet.add(new Date(t).toISOString());
        }
      }
    }
  }
  if (!slotSet.size)
    return res.json({ success: true, count: 0, data: [], tz: "UTC" });

  // ─────────────────────────────────────────────────────────────
  // PATCH: Ensure receiver has a whitelist; if missing or empty,
  // create it with ALL slots of this day (non-destructive to existing).
  // ─────────────────────────────────────────────────────────────
  let createdReceiverWhitelist = false;
  try {
    const wl = await SlotWhitelist.findOne({ eventId, actorId: receiverId })
      .select("_id slots")
      .lean();
    if (!wl || !Array.isArray(wl.slots) || wl.slots.length === 0) {
      const slotsAsDates = Array.from(slotSet).map((s) => new Date(s));
      await SlotWhitelist.updateOne(
        { eventId, actorId: receiverId },
        {
          $setOnInsert: { eventId, actorId: receiverId, createdAt: new Date() },
          $set: { updatedAt: new Date() },
          $addToSet: { slots: { $each: slotsAsDates } }, // only adds if not present
        },
        { upsert: true }
      );
      createdReceiverWhitelist = true;
    }
  } catch (e) {
    console.warn(
      "[listAvailableSlots] ensure whitelist failed:",
      e?.message || e
    );
  }
  // (If you also want to auto-create for the sender, repeat the same block for actorId: senderId)

  // busy (locks + requests)
  const dayStartISO = dayStart.toISOString();
  const dayEndISO = dayEndEx.toISOString();
  const [locks, requests] = await Promise.all([
    SlotIndex.find({
      eventId,
      actorId: { $in: [senderId, receiverId] },
      slotISO: { $gte: dayStartISO, $lt: dayEndISO },
    })
      .select("slotISO")
      .lean(),
    MeetRequest.find({
      eventId,
      status: {
        $in: [
          "pending",
          "accepted",
          "confirmed",
          "reschedule-proposed",
          "rescheduled",
        ],
      },
      $and: [
        {
          $or: [
            { senderId: senderId },
            { receiverId: senderId },
            { senderId: receiverId },
            { receiverId: receiverId },
          ],
        },
        {
          $or: [
            { requestedAt: { $gte: dayStart, $lt: dayEndEx } },
            { proposedNewAt: { $gte: dayStart, $lt: dayEndEx } },
          ],
        },
      ],
    })
      .select("requestedAt proposedNewAt")
      .lean(),
  ]);
  const busy = new Set([
    ...locks.map((b) => iso(b.slotISO)),
    ...requests.flatMap((r) => {
      const out = [];
      if (r.requestedAt) out.push(iso(r.requestedAt));
      if (r.proposedNewAt) out.push(iso(r.proposedNewAt));
      return out;
    }),
  ]);
  const allFreeGrid = Array.from(slotSet).filter((isoStr) => !busy.has(isoStr));
  if (!allFreeGrid.length) {
    return res.json({
      success: true,
      count: 0,
      data: [],
      tz: "UTC",
      createdReceiverWhitelist,
      allFreeCount: 0,
      filteredOut: 0,
      enforced: false,
      ignoreWhitelist: false,
    });
  }

  // whitelist (load after potential creation)
  const ignoreWhitelist = String(req.query?.ignoreWhitelist || "") === "1";
  const [wSender, wReceiver] = await Promise.all([
    SlotWhitelist.findOne({ eventId, actorId: senderId })
      .select("slots")
      .lean(),
    SlotWhitelist.findOne({ eventId, actorId: receiverId })
      .select("slots")
      .lean(),
  ]);

  const senderHasWl = !!wSender?.slots?.length;
  const receiverHasWl = !!wReceiver?.slots?.length;

  const wS = senderHasWl
    ? toSetISO(
        (wSender.slots || []).filter((d) => d >= dayStart && d < dayEndEx)
      )
    : null;
  const wR = receiverHasWl
    ? toSetISO(
        (wReceiver.slots || []).filter((d) => d >= dayStart && d < dayEndEx)
      )
    : null;

  // Enforce whitelist if (a) NOT ignoring and (b) at least one list exists
  let grid = allFreeGrid;
  let filteredOut = 0;
  const shouldEnforce = !ignoreWhitelist && (senderHasWl || receiverHasWl);
  if (shouldEnforce) {
    grid = allFreeGrid.filter((sISO) => {
      const passSender = !senderHasWl || (wS && wS.has(sISO));
      const passReceiver = !receiverHasWl || (wR && wR.has(sISO));
      return passSender && passReceiver;
    });
    filteredOut = allFreeGrid.length - grid.length;
  }

  // capacities
  let countMap = new Map();
  if (!bothVirtual && grid.length) {
    try {
      if (halfVirtual) {
        const rowsH = await HybridMeetingSlot.find({
          eventId,
          slotISO: { $in: grid.map((s) => new Date(s)) },
        })
          .select("slotISO used cap")
          .lean();
        countMap = new Map(
          rowsH.map((r) => [
            iso(r.slotISO),
            {
              used: Number(r.used || 0),
              cap: Number(r.cap || capHybridDefault),
            },
          ])
        );
      } else {
        const rowsP = await MeetingSlot.find({
          eventId,
          slotISO: { $in: grid.map((s) => new Date(s)) },
        })
          .select("slotISO used cap")
          .lean();
        countMap = new Map(
          rowsP.map((r) => [
            iso(r.slotISO),
            { used: Number(r.used || 0), cap: Number(r.cap || capDefault) },
          ])
        );
      }
    } catch (e) {
      console.warn("[listAvailableSlots] slot read failed:", e?.message);
    }
  }

  const data = grid.sort().map((sISO) => {
    if (bothVirtual) {
      return {
        iso: sISO,
        used: 0,
        cap: Number.POSITIVE_INFINITY,
        isCap: true,
        kind: "virtual",
      };
    }
    const info = countMap.get(sISO);
    const used = info?.used ?? 0;
    const cap = info?.cap ?? (halfVirtual ? capHybridDefault : capDefault);
    const hardCeil = 30;
    const isCap = used < cap && (halfVirtual ? used < cap : used < hardCeil);
    return {
      iso: sISO,
      used,
      cap,
      isCap,
      kind: halfVirtual ? "hybrid" : "physical",
    };
  });

  const actorHasWhitelist = senderHasWl;
  const receiverHasWhitelist = receiverHasWl;
  const whitelistStatus =
    actorHasWhitelist && receiverHasWhitelist
      ? "both"
      : actorHasWhitelist
      ? "sender"
      : receiverHasWhitelist
      ? "receiver"
      : "none";

  return res.json({
    success: true,
    count: data.length,
    data,
    tz: "UTC",
    actorHasWhitelist,
    receiverHasWhitelist,
    whitelistStatus,
    allFreeCount: allFreeGrid.length,
    filteredOut,
    enforced: shouldEnforce,
    ignoreWhitelist,
    createdReceiverWhitelist,
  });
});

exports.cancelMeeting = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).exec();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });
  if (meet.status !== "accepted")
    return res
      .status(400)
      .json({ message: "Only accepted meetings can be cancelled" });

  const IamParticipant =
    (meet.senderId.toString() === meId && meet.senderRole === meRole) ||
    (meet.receiverId.toString() === meId && meet.receiverRole === meRole);
  const isAdmin = meRole === "admin";
  if (!IamParticipant && !isAdmin)
    return res.status(403).json({ message: "Not allowed" });

  /* remove slot lock */
  await SlotIndex.deleteMany({
    eventId: meet.eventId,
    actorId: { $in: [meet.senderId, meet.receiverId] },
    slotISO: slotKey(meet.requestedAt),
  });

  meet.status = "cancelled";
  meet.history.push({ actorId: meId, action: "cancelled" });
  await meet.save();

  /* notify */
  const [sDoc, rDoc] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
  ]);
  const emailOf = (doc, role) =>
    role === "exhibitor" ? doc.identity.email : doc.personal.email;

  await Promise.all([
    sendMail(
      emailOf(sDoc, meet.senderRole),
      "Meeting cancelled",
      `Your meeting scheduled for ${meet.requestedAt.toUTCString()} has been cancelled.`
    ),
    sendMail(
      emailOf(rDoc, meet.receiverRole),
      "Meeting cancelled",
      `Your meeting scheduled for ${meet.requestedAt.toUTCString()} has been cancelled.`
    ),
  ]);

  res.json({ success: true, message: "Meeting cancelled" });
});

/* ───────────────────────── 2. .ics download ──────────────────────── */
exports.getMeetingICS = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const meId = req.user._id.toString();
  const meRole = req.user.role;

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });
  if (meet.status !== "accepted")
    return res
      .status(400)
      .json({ message: "ICS available only for accepted meetings" });

  const IamParticipant =
    (meet.senderId.toString() === meId && meet.senderRole === meRole) ||
    (meet.receiverId.toString() === meId && meet.receiverRole === meRole);
  const isAdmin = meRole === "admin";
  if (!IamParticipant && !isAdmin)
    return res.status(403).json({ message: "Not allowed" });

  const event = await Event.findById(meet.eventId).lean();

  const cal = ical({ name: `Meeting @ ${event.title}` });
  cal.createEvent({
    id: meet._id.toString(),
    start: meet.requestedAt,
    end: new Date(new Date(meet.requestedAt).getTime() + 30 * 60 * 1000),
    summary: meet.subject,
    description: `B2B Meeting – ${meet.subject}`,
    location: `${event.title} venue`,
    status: "CONFIRMED",
  });

  res.setHeader("Content-Type", "text/calendar");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="meeting_${id}.ics"`
  );
  res.send(cal.toString());
});

const JOB_NAME = "meeting:remind";
let agenda; // Agenda instance shared by all modules

/* ───────────────────── init – call from server.js ────────────────── */
exports.initMeetingReminderEngine = async (app) => {
  if (agenda) return; // avoid double-init in dev hot-reload

  const mongoUri = process.env.REMINDER_DB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error("Missing REMINDER_DB_URI (or MONGO_URI) for Agenda");

  agenda = new Agenda({
    db: { address: mongoUri, collection: "agendaJobs" },
  });

  /* existing 1h-before job */
  agenda.define(JOB_NAME, async (job) => {
    const { meetingId } = job.attrs.data || {};
    const meet = await MeetRequest.findById(meetingId).lean();
    // Use the real confirmed meeting
    if (!meet || meet.status !== "confirmed") return job.remove();

    const event = await Event.findById(meet.eventId).lean();
    if (!event) return job.remove();

    const [sDoc, rDoc] = await Promise.all([
      ROLE_MODEL[meet.senderRole]?.findById(meet.senderId).lean(),
      ROLE_MODEL[meet.receiverRole]?.findById(meet.receiverId).lean(),
    ]);

    const emailOf = (doc, role) =>
      role === "exhibitor" ? doc?.identity?.email : doc?.personal?.email;

    const whenText = new Date(meet.slotISO || meet.requestedAt).toUTCString();

    await Promise.all([
      sendMail(
        emailOf(sDoc, meet.senderRole),
        "Reminder: your meeting in 1 hour",
        `<p>This is a reminder for your B2B meeting.</p><p>Time: ${whenText}</p>`
      ),
      sendMail(
        emailOf(rDoc, meet.receiverRole),
        "Reminder: your meeting in 1 hour",
        `<p>This is a reminder for your B2B meeting.</p><p>Time: ${whenText}</p>`
      ),
    ]);
  });


  app.locals.agenda = agenda;
};

/* ────────────────── helper to schedule one reminder ──────────────── */
const scheduleMeetingReminder = async (meetDoc) => {
  if (!agenda) return; // ensure init called

  /* F  ire 60 min before meeting start */
  const runAt = new Date(
    new Date(meetDoc.requestedAt).getTime() - 60 * 60 * 1000
  );
  if (runAt <= Date.now()) return; // meeting in < 1h : skip

  await agenda
    .create(JOB_NAME, { meetingId: meetDoc._id })
    .unique({ "data.meetingId": meetDoc._id })
    .schedule(runAt)
    .save();
};
exports.scheduleMeetingReminder = scheduleMeetingReminder;

/* ─────────────── GET /meets/reminders/:eventId (admin) ───────────── */
exports.listMeetingReminders = asyncHandler(async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ message: "Admin only" });

  const { eventId } = req.params;
  if (!agenda)
    return res.status(500).json({ message: "Reminder engine not running" });

  const jobs = await agenda.jobs({ name: JOB_NAME, "data.eventId": eventId });
  const rows = jobs.map((j) => ({
    jobId: j.attrs._id,
    meetingId: j.attrs.data.meetingId,
    runAt: j.attrs.nextRunAt,
  }));
  res.json({ success: true, count: rows.length, data: rows });
});
exports.checkMeetingExist = asyncHandler(async (req, res) => {
  const { senderId, receiverId } = req.body || {};

  if (!senderId) return res.status(401).json({ message: "Unauthorized" });
  if (!receiverId || !mongoose.isValidObjectId(receiverId))
    return res.status(400).json({ message: "Bad receiverId" });

  // Find any latest request between the two, regardless of direction
  const doc = await MeetRequest.findOne({
    $or: [
      { senderId, receiverId },
      { senderId: receiverId, receiverId: senderId },
    ],
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  if (!doc) return res.json({ success: true, exist: "no" });

  const st = String(doc.status || "").toLowerCase();

  // Map to the requested buckets:
  // - "yes"     → accepted (confirmed)
  // - "pending" → pending or reschedule-proposed
  // - "refused" → declined or cancelled
  // Fallback: treat unknown but present as "pending".
  let exist = "pending";
  if (st === "accepted") exist = "yes";
  else if (st === "pending" || st === "reschedule-proposed") exist = "pending";
  else if (st === "declined" || st === "cancelled") exist = "refused";

  return res.json({ success: true, exist });
});
exports.adminListMeets = asyncHandler(async (req, res) => {
  const { eventId, status, from, to, q } = req.query || {};
  const find = {};
  if (eventId && mongoose.isValidObjectId(eventId)) find.eventId = eventId;
  if (status) find.status = status;

  if (from || to) {
    find.slotISO = {};
    if (from) find.slotISO.$gte = new Date(from);
    if (to) find.slotISO.$lte = new Date(to);
  }
  if (q) {
    const rx = new RegExp(
      String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );
    find.$or = [{ subject: rx }, { message: rx }];
  }

  const rows = await MeetRequest.find(find)
    .sort({ slotISO: 1, requestedAt: 1 })
    .lean();

  const data = await attachParticipants(rows);
  return res.json({ success: true, count: data.length, data });
});

/* ──────────────────────── ADMIN: get one meeting ─────────────────────── */
// GET /admin/meets/:id
exports.adminGetMeet = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });

  const row = await MeetRequest.findById(id).lean();
  if (!row) return res.status(404).json({ message: "Not found" });

  const [enriched] = await attachParticipants([row]);
  const attendance = await MeetingAttendance.find({ meetingId: id }).lean();
  return res.json({ success: true, data: { ...enriched, attendance } });
});

/* ───────────────────────── ADMIN: calendar feed ──────────────────────── */
// GET /admin/meets/calendar?eventId=&from=&to=
exports.adminCalendar = asyncHandler(async (req, res) => {
  const eventId = req.query?.eventId;
  const fromISO = req.query?.from;
  const toISO = req.query?.to;

  if (!mongoose.isValidObjectId(eventId)) {
    return res.status(400).json({ message: "Bad id" });
  }
  const from = fromISO ? new Date(fromISO) : null;
  const to = toISO ? new Date(toISO) : null;

  // Load slots from both physical and hybrid buckets within range (optional)
  const slotQ = { eventId };
  if (from && to) slotQ.slotISO = { $gte: from, $lte: to };

  const [phys, hybrid] = await Promise.all([
    MeetingSlot.find(slotQ).select("slotISO used cap").lean(),
    HybridMeetingSlot.find(slotQ).select("slotISO used cap").lean(),
  ]);

  // Index by slotISO string
  const byISO = new Map();
  const asKey = (d) => new Date(d).toISOString();

  for (const r of phys) {
    const k = asKey(r.slotISO);
    if (!byISO.has(k))
      byISO.set(k, {
        slotISO: k,
        capPhysical: 0,
        usedPhysical: 0,
        capHybrid: 0,
        usedHybrid: 0,
        cnt: { physical: 0, hybrid: 0, virtual: 0 },
      });
    const it = byISO.get(k);
    it.capPhysical = Math.max(it.capPhysical, Number(r.cap || 0));
    it.usedPhysical = Math.max(it.usedPhysical, Number(r.used || 0)); // peak usage for the slot
  }
  for (const r of hybrid) {
    const k = asKey(r.slotISO);
    if (!byISO.has(k))
      byISO.set(k, {
        slotISO: k,
        capPhysical: 0,
        usedPhysical: 0,
        capHybrid: 0,
        usedHybrid: 0,
        cnt: { physical: 0, hybrid: 0, virtual: 0 },
      });
    const it = byISO.get(k);
    it.capHybrid = Math.max(it.capHybrid, Number(r.cap || 0));
    it.usedHybrid = Math.max(it.usedHybrid, Number(r.used || 0));
  }

  // Count meetings per mode at each slot
  const meetQ = { eventId };
  if (from && to) {
    meetQ.slotISO = { $gte: from, $lte: to };
  }
  const meets = await MeetRequest.find(meetQ)
    .select(
      "slotISO senderId senderRole receiverId receiverRole status tableId"
    )
    .lean();

  // Cache virtual flags per actor
  const vCache = new Map();
  async function getVirtual(role, id) {
    const key = `${role}:${id}`;
    if (vCache.has(key)) return vCache.get(key);
    const meta = await readActorMeta(role, id);
    vCache.set(key, meta.virtual);
    return meta.virtual;
  }

  for (const m of meets) {
    const k = asKey(m.slotISO);
    if (!byISO.has(k)) {
      byISO.set(k, {
        slotISO: k,
        capPhysical: 0,
        usedPhysical: 0,
        capHybrid: 0,
        usedHybrid: 0,
        cnt: { physical: 0, hybrid: 0, virtual: 0 },
      });
    }
  }

  // Resolve modes (batched to reduce round trips)
  const toResolve = [];
  for (const m of meets) {
    toResolve.push([m.senderRole, m.senderId]);
    toResolve.push([m.receiverRole, m.receiverId]);
  }
  // de-dup & resolve
  const uniqPairs = Array.from(
    new Set(toResolve.map(([r, i]) => `${r}:${i}`))
  ).map((s) => s.split(":"));
  await Promise.all(
    uniqPairs.map(async ([role, id]) => {
      await getVirtual(role, id);
    })
  );

  for (const m of meets) {
    const k = asKey(m.slotISO);
    const sV = await getVirtual(m.senderRole, m.senderId);
    const rV = await getVirtual(m.receiverRole, m.receiverId);
    const mode = computeMode(sV, rV);
    const it = byISO.get(k);
    it.cnt[mode] = (it.cnt[mode] || 0) + 1;
  }

  // Add localized labels for UI/export
  const tz = await readEventTZ(eventId);
  const data = Array.from(byISO.values())
    .sort((a, b) => new Date(a.slotISO) - new Date(b.slotISO))
    .map((s) => {
      const loc = localizeSlot(s.slotISO, tz);
      return {
        ...s,
        tz,
        localDate: loc.localDate,
        localTime: loc.localTime,
        // totals per slot
        totalMeetings:
          (s.cnt.physical || 0) + (s.cnt.hybrid || 0) + (s.cnt.virtual || 0),
      };
    });

  return res.json({ success: true, data, count: data.length, tz });
});

/* ───────────────────────── ADMIN: create meeting ─────────────────────── */
// POST /admin/meets  { eventId, senderId, senderRole, receiverId, receiverRole, slotISO, subject, message }
exports.adminCreateMeet = asyncHandler(async (req, res) => {
  const {
    eventId,
    senderId,
    senderRole,
    receiverId,
    receiverRole,
    slotISO,
    subject,
    message,
  } = req.body || {};
  for (const [k, v] of Object.entries({
    eventId,
    senderId,
    receiverId,
    slotISO,
    subject,
  })) {
    if (!v) return res.status(400).json({ message: `Missing ${k}` });
  }
  if (
    ![senderRole, receiverRole].every((r) =>
      ["attendee", "exhibitor", "speaker"].includes(String(r).toLowerCase())
    )
  )
    return res.status(400).json({ message: "Bad roles" });

  const iso = new Date(slotISO);
  if (isNaN(iso.getTime()))
    return res.status(400).json({ message: "Bad slotISO" });

  // busy/conflict guard
  const busy = await existsBusyAt(eventId, iso.toISOString(), [
    senderId,
    receiverId,
  ]);
  if (busy)
    return res
      .status(409)
      .json({ message: "One of the participants is busy at that time" });

  // virtual flags (decide counters + table)
  const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
    senderId,
    receiverId
  );
  const bothVirtual = senderVirtual && receiverVirtual;
  const halfVirtual = senderVirtual !== receiverVirtual;

  // ensure counter doc & capacity
  if (!bothVirtual) await ensureCapDoc(eventId, iso.toISOString());

  // increment correct counter
  if (!bothVirtual) {
    if (halfVirtual) {
      let hDoc = await HybridMeetingSlot.findOne({
        eventId,
        slotISO: iso,
      }).lean();
      if (!hDoc) {
        const ev = await Event.findById(eventId).select("postsCount").lean();
        const cap = Number(ev?.postsCount) > 0 ? Number(ev.postsCount) : 10;
        try {
          hDoc = await HybridMeetingSlot.create({
            eventId,
            slotISO: iso,
            used: 0,
            cap,
          });
        } catch {
          hDoc = await HybridMeetingSlot.findOne({
            eventId,
            slotISO: iso,
          }).lean();
        }
      }
      if (Number(hDoc.used || 0) >= Number(hDoc.cap || 0))
        return res.status(409).json({ message: "Hybrid slot full" });
      await HybridMeetingSlot.updateOne(
        { eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
    } else {
      await MeetingSlot.updateOne(
        { eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
    }
  }

  // create meet (confirmed by admin right away)
  const doc = await MeetRequest.create({
    eventId,
    senderId,
    senderRole,
    receiverId,
    receiverRole,
    subject: String(subject || ""),
    message: String(message || ""),
    requestedAt: iso,
    slotISO: iso,
    status: "confirmed",
  });

  // lock both actors, set table and meet link
  await lockActors(eventId, iso.toISOString(), senderId, receiverId);

  const FRONT_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
  const upd = { meetLink: `${FRONT_URL}/vmeet/${String(doc._id)}` };
  if (!bothVirtual) {
    const idx = await reserveTableIndex(eventId, iso);
    upd.tableId = tableCodeFromIndex(idx, 3);
  }
  await MeetRequest.updateOne({ _id: doc._id }, { $set: upd });

  const finalDoc = await MeetRequest.findById(doc._id).lean();
  try {
    await sendConfirmEmailsWithPDF(finalDoc);
  } catch (e) {
    console.warn("[adminCreateMeet] email failed", e?.message);
  }

  return res.status(201).json({ success: true, data: finalDoc });
});

/* ───────────────────────── ADMIN: delete meeting ───────────────────── */
// DELETE /admin/meets/:id
exports.adminDeleteMeet = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message: "Not found" });

  // unlock actors + decrement counters (if confirmed)
  const slotISO = meet.slotISO ? new Date(meet.slotISO).toISOString() : null;
  if (slotISO)
    await unlockActors(meet.eventId, slotISO, meet.senderId, meet.receiverId);

  // decide which counter to decrement (best effort)
  try {
    const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
      meet.senderId,
      meet.receiverId
    );
    if (!(senderVirtual && receiverVirtual) && slotISO) {
      const half = senderVirtual !== receiverVirtual;
      if (half) {
        await HybridMeetingSlot.updateOne(
          {
            eventId: meet.eventId,
            slotISO: new Date(slotISO),
            used: { $gt: 0 },
          },
          { $inc: { used: -1 } }
        );
      } else {
        await MeetingSlot.updateOne(
          {
            eventId: meet.eventId,
            slotISO: new Date(slotISO),
            used: { $gt: 0 },
          },
          { $inc: { used: -1 } }
        );
      }
    }
  } catch {}

  await MeetingAttendance.deleteMany({ meetingId: id });
  await MeetRequest.deleteOne({ _id: id });
  return res.json({ success: true, message: "Deleted" });
});
/* ───────────────────────── ADMIN: create meeting ─────────────────────── */
// POST /admin/meets  { eventId, senderId, senderRole, receiverId, receiverRole, slotISO, subject, message }
exports.adminCreateMeet = asyncHandler(async (req, res) => {
  const {
    eventId,
    senderId,
    senderRole,
    receiverId,
    receiverRole,
    slotISO,
    subject,
    message,
  } = req.body || {};
  for (const [k, v] of Object.entries({
    eventId,
    senderId,
    receiverId,
    slotISO,
    subject,
  })) {
    if (!v) return res.status(400).json({ message: `Missing ${k}` });
  }
  if (
    ![senderRole, receiverRole].every((r) =>
      ["attendee", "exhibitor", "speaker"].includes(String(r).toLowerCase())
    )
  )
    return res.status(400).json({ message: "Bad roles" });

  const iso = new Date(slotISO);
  if (isNaN(iso.getTime()))
    return res.status(400).json({ message: "Bad slotISO" });

  // busy/conflict guard
  const busy = await existsBusyAt(eventId, iso.toISOString(), [
    senderId,
    receiverId,
  ]);
  if (busy)
    return res
      .status(409)
      .json({ message: "One of the participants is busy at that time" });

  // virtual flags (decide counters + table)
  const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
    senderId,
    receiverId
  );
  const bothVirtual = senderVirtual && receiverVirtual;
  const halfVirtual = senderVirtual !== receiverVirtual;

  // ensure counter doc & capacity
  if (!bothVirtual) await ensureCapDoc(eventId, iso.toISOString());

  // increment correct counter
  if (!bothVirtual) {
    if (halfVirtual) {
      let hDoc = await HybridMeetingSlot.findOne({
        eventId,
        slotISO: iso,
      }).lean();
      if (!hDoc) {
        const ev = await Event.findById(eventId).select("postsCount").lean();
        const cap = Number(ev?.postsCount) > 0 ? Number(ev.postsCount) : 10;
        try {
          hDoc = await HybridMeetingSlot.create({
            eventId,
            slotISO: iso,
            used: 0,
            cap,
          });
        } catch {
          hDoc = await HybridMeetingSlot.findOne({
            eventId,
            slotISO: iso,
          }).lean();
        }
      }
      if (Number(hDoc.used || 0) >= Number(hDoc.cap || 0))
        return res.status(409).json({ message: "Hybrid slot full" });
      await HybridMeetingSlot.updateOne(
        { eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
    } else {
      await MeetingSlot.updateOne(
        { eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
    }
  }

  // create meet (confirmed by admin right away)
  const doc = await MeetRequest.create({
    eventId,
    senderId,
    senderRole,
    receiverId,
    receiverRole,
    subject: String(subject || ""),
    message: String(message || ""),
    requestedAt: iso,
    slotISO: iso,
    status: "confirmed",
  });

  // lock both actors, set table and meet link
  await lockActors(eventId, iso.toISOString(), senderId, receiverId);

  const FRONT_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
  const upd = { meetLink: `${FRONT_URL}/vmeet/${String(doc._id)}` };
  if (!bothVirtual) {
    const idx = await reserveTableIndex(eventId, iso);
    upd.tableId = tableCodeFromIndex(idx, 3);
  }
  await MeetRequest.updateOne({ _id: doc._id }, { $set: upd });

  const finalDoc = await MeetRequest.findById(doc._id).lean();
  try {
    await sendConfirmEmailsWithPDF(finalDoc);
  } catch (e) {
    console.warn("[adminCreateMeet] email failed", e?.message);
  }

  return res.status(201).json({ success: true, data: finalDoc });
});

/* ───────────────────────── ADMIN: delete meeting ───────────────────── */
// DELETE /admin/meets/:id
exports.adminDeleteMeet = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message: "Not found" });

  // unlock actors + decrement counters (if confirmed)
  const slotISO = meet.slotISO ? new Date(meet.slotISO).toISOString() : null;
  if (slotISO)
    await unlockActors(meet.eventId, slotISO, meet.senderId, meet.receiverId);

  // decide which counter to decrement (best effort)
  try {
    const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
      meet.senderId,
      meet.receiverId
    );
    if (!(senderVirtual && receiverVirtual) && slotISO) {
      const half = senderVirtual !== receiverVirtual;
      if (half) {
        await HybridMeetingSlot.updateOne(
          {
            eventId: meet.eventId,
            slotISO: new Date(slotISO),
            used: { $gt: 0 },
          },
          { $inc: { used: -1 } }
        );
      } else {
        await MeetingSlot.updateOne(
          {
            eventId: meet.eventId,
            slotISO: new Date(slotISO),
            used: { $gt: 0 },
          },
          { $inc: { used: -1 } }
        );
      }
    }
  } catch {}

  await MeetingAttendance.deleteMany({ meetingId: id });
  await MeetRequest.deleteOne({ _id: id });
  return res.json({ success: true, message: "Deleted" });
});
/* ─────────────── ADMIN: mark attendance (physical or virtual) ───────────── */
// POST /admin/meets/:id/attendance { actorId, kind: 'physical'|'virtual', attended: true|false }
exports.adminMarkAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { actorId, kind = "physical", attended = true } = req.body || {};
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: "Bad ids" });
  if (!["physical", "virtual"].includes(kind))
    return res.status(400).json({ message: "Bad kind" });

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });

  await MeetingAttendance.updateOne(
    { meetingId: id, actorId, kind },
    {
      $set: {
        meetingId: id,
        eventId: meet.eventId,
        actorId,
        kind,
        attended: !!attended,
        at: new Date(),
        by: req.user._id,
      },
    },
    { upsert: true }
  );
  const recs = await MeetingAttendance.find({ meetingId: id }).lean();
  return res.json({ success: true, data: recs });
});

/* ─────────────── ADMIN: generate/set Google Meet (or redirect link) ──────── */
// POST /admin/meets/:id/link { link? }  -> if link omitted, we set your redirect link
exports.adminSetVirtualLink = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { link } = req.body || {};
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });

  const meet = await MeetRequest.findById(id).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });

  const FRONT_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "#";
  const meetLink =
    link && /^https?:\/\//i.test(link)
      ? link
      : `${FRONT_URL}/vmeet/${String(meet._id)}`;
  await MeetRequest.updateOne({ _id: id }, { $set: { meetLink } });

  const updated = await MeetRequest.findById(id).lean();
  return res.json({
    success: true,
    data: { id: String(updated._id), meetLink: updated.meetLink },
  });
});
/* ───────────────────────── ADMIN: stats for an event ───────────────────── */
// GET /admin/meets/stats/:eventId
exports.adminMeetStats = asyncHandler(async (req, res) => {
  const { eventId } = req.params || {};
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });

  const base = { eventId: new mongoose.Types.ObjectId(eventId) };

  const byStatus = await MeetRequest.aggregate([
    { $match: base },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);

  const byDay = await MeetRequest.aggregate([
    { $match: base },
    {
      $project: {
        day: {
          $dateToString: {
            date: "$slotISO",
            timezone: "UTC",
            format: "%Y-%m-%d",
          },
        },
      },
    },
    { $group: { _id: "$day", n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  // physical/hybrid/virtual breakdown (approx by current virtual flags)
  const rows = await MeetRequest.find(base)
    .select("senderId receiverId slotISO")
    .lean();
  let phys = 0,
    hybrid = 0,
    virt = 0;
  for (const r of rows) {
    const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
      r.senderId,
      r.receiverId
    );
    if (senderVirtual && receiverVirtual) virt++;
    else if (senderVirtual !== receiverVirtual) hybrid++;
    else phys++;
  }

  // attendance
  const att = await MeetingAttendance.aggregate([
    { $match: base },
    {
      $group: { _id: { kind: "$kind", attended: "$attended" }, n: { $sum: 1 } },
    },
  ]);

  return res.json({
    success: true,
    data: {
      counts: Object.fromEntries(
        byStatus.map((x) => [x._id || "unknown", x.n])
      ),
      byDay: byDay.map((x) => ({ day: x._id, count: x.n })),
      modes: { physical: phys, hybrid, virtual: virt },
      attendance: att.map((x) => ({
        kind: x._id.kind,
        attended: !!x._id.attended,
        count: x.n,
      })),
    },
  });
});
// === PATCH START: adminListSlots (calendar-safe id + per-slot stats) ===
// GET /admin/meets/slots?eventId=...&from=...&to=...&tz=Africa/Tunis
exports.adminListSlots = asyncHandler(async (req, res) => {
  const {
    eventId,
    from,
    to,
    tz = process.env.TZ || "Africa/Tunis",
  } = req.query || {};
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });

  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(start.getTime() + 24 * 3600 * 1000);
  if (isNaN(start) || isNaN(end) || end <= start)
    return res.status(400).json({ message: "Bad range" });

  // Build 30-min slots
  const grid = [];
  let t = new Date(Math.floor(start.getTime() / 60000) * 60000);
  while (t < end) {
    grid.push(new Date(t).toISOString());
    t = new Date(t.getTime() + 30 * 60000);
  }

  // Pull caps/usage for physical tables
  const [physDocs, hybDocs] = await Promise.all([
    MeetingSlot.find({ eventId, slotISO: { $gte: start, $lt: end } }).lean(),
    HybridMeetingSlot.find({
      eventId,
      slotISO: { $gte: start, $lt: end },
    }).lean(),
  ]);

  const physMap = new Map();
  const hybMap = new Map();
  let capDefault = 0,
    hybridCap = 0;

  for (const d of physDocs) {
    const k = new Date(d.slotISO).toISOString();
    physMap.set(k, { used: Number(d.used || 0), cap: Number(d.cap || 0) });
    capDefault = Math.max(capDefault, Number(d.cap || 0));
  }
  for (const d of hybDocs) {
    const k = new Date(d.slotISO).toISOString();
    hybMap.set(k, { used: Number(d.used || 0), cap: Number(d.cap || 0) });
    hybridCap = Math.max(hybridCap, Number(d.cap || 0));
  }

  // Count virtual-eligible meetings per slot (both participants marked virtual)
  const meets = await MeetRequest.find({
    eventId,
    slotISO: { $gte: start, $lt: end },
    status: { $in: ["pending", "rescheduled", "confirmed"] },
  })
    .select("slotISO senderId receiverId")
    .lean();

  // cache actor virtual flags in bulk
  const idSet = new Set();
  for (const m of meets) {
    idSet.add(String(m.senderId));
    idSet.add(String(m.receiverId));
  }
  const [as, xs, ss] = await Promise.all([
    attendee
      .find({ _id: { $in: Array.from(idSet) } })
      .select("virtualMeet")
      .lean(),
    Exhibitor.find({ _id: { $in: Array.from(idSet) } })
      .select("virtualMeet")
      .lean(),
    Speaker.find({ _id: { $in: Array.from(idSet) } })
      .select("virtualMeet")
      .lean(),
  ]);
  const vmap = new Map();
  for (const d of [...as, ...xs, ...ss])
    vmap.set(String(d._id), !!d.virtualMeet); // ← small bugfix to your prev snippet

  const virtCount = new Map();
  for (const m of meets) {
    const sV = !!vmap.get(String(m.senderId));
    const rV = !!vmap.get(String(m.receiverId));
    if (sV && rV && m.slotISO) {
      const k = new Date(m.slotISO).toISOString();
      virtCount.set(k, (virtCount.get(k) || 0) + 1);
    }
  }

  const fmtTZDate = (iso, z) =>
    new Date(iso).toLocaleDateString("en-GB", { timeZone: z });
  const fmtTZTime = (iso, z) =>
    new Date(iso).toLocaleTimeString([], {
      timeZone: z,
      hour: "2-digit",
      minute: "2-digit",
    });

  const data = grid.map((iso) => {
    const p = physMap.get(iso) || { used: 0, cap: capDefault };
    const h = hybMap.get(iso) || { used: 0, cap: hybridCap };
    const v = virtCount.get(iso) || 0;
    return {
      iso,
      physical: { used: p.used, cap: p.cap },
      hybrid: { used: h.used, cap: h.cap },
      virtual: { used: v },
      localDate: fmtTZDate(iso, tz),
      localTime: fmtTZTime(iso, tz),
    };
  });

  return res.json({ success: true, tz, caps: { capDefault, hybridCap }, data });
});
// PUT /admin/meets/:id/reschedule
exports.adminReschedule = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { slotISO } = req.body || {};
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });
  const iso = new Date(slotISO);
  if (isNaN(iso)) return res.status(400).json({ message: "Bad slotISO" });

  const meet = await MeetRequest.findById(id);
  if (!meet) return res.status(404).json({ message: "Not found" });

  // unlock old
  if (meet.slotISO)
    await unlockActors(
      meet.eventId,
      new Date(meet.slotISO).toISOString(),
      meet.senderId,
      meet.receiverId
    );

  // conflict guard
  if (
    await existsBusyAt(meet.eventId, iso.toISOString(), [
      meet.senderId,
      meet.receiverId,
    ])
  )
    return res.status(409).json({ message: "Busy at that time" });

  // place into counters like adminCreateMeet
  const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
    meet.senderId,
    meet.receiverId
  );
  const bothVirtual = senderVirtual && receiverVirtual;
  const halfVirtual = senderVirtual !== receiverVirtual;
  if (!bothVirtual) {
    await ensureCapDoc(meet.eventId, iso.toISOString());
    if (halfVirtual)
      await HybridMeetingSlot.updateOne(
        { eventId: meet.eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
    else
      await MeetingSlot.updateOne(
        { eventId: meet.eventId, slotISO: iso },
        { $inc: { used: 1 } },
        { upsert: true }
      );
  }

  meet.slotISO = iso;
  meet.status = "rescheduled";
  await meet.save();
  await lockActors(
    meet.eventId,
    iso.toISOString(),
    meet.senderId,
    meet.receiverId
  );
  return res.json({
    success: true,
    data: await MeetRequest.findById(id).lean(),
  });
});

// PUT /admin/meets/:id/table
exports.adminSetTable = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { tableId } = req.body || {};
  if (!mongoose.isValidObjectId(id))
    return res.status(400).json({ message: "Bad id" });
  await MeetRequest.updateOne(
    { _id: id },
    { $set: { tableId: String(tableId || "").toUpperCase() } }
  );
  return res.json({ success: true });
});
exports.setWhitelist = asyncHandler(async (req, res) => {
  const actorId = req.body?.actorId || req.user?._id;
  const { eventId } = req.body || {};
  const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];

  if (!mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: "Bad actorId" });
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });

  // normalize to 30-min UTC grid & unique
  const normalized = Array.from(new Set(slots.map(norm30).map(Number))).map(
    (n) => new Date(n)
  );

  const doc = await SlotWhitelist.findOneAndUpdate(
    { eventId, actorId },
    { $set: { slots: normalized } },
    { upsert: true, new: true }
  ).lean();

  res.json({
    success: true,
    data: { eventId, actorId, slots: doc.slots.map(iso) },
  });
});
exports.adminSetWhitelist = asyncHandler(async (req, res) => {
  // requires your admin auth middleware
  const { actorId, eventId, slots } = req.body || {};
  if (!mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: "Bad actorId" });
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });
  const normalized = Array.from(
    new Set((Array.isArray(slots) ? slots : []).map(norm30).map(Number))
  ).map((n) => new Date(n));
  const doc = await SlotWhitelist.findOneAndUpdate(
    { eventId, actorId },
    { $set: { slots: normalized } },
    { upsert: true, new: true }
  ).lean();
  res.json({
    success: true,
    data: { eventId, actorId, slots: doc.slots.map(iso) },
  });
});

exports.adminRepairEvent = asyncHandler(async (req, res) => {
  const {
    eventId: rawEventId,
    apply = false,
    mode = "cancel",
    syncCounters = true,
  } = req.body || {};

  const byEvent = (id) =>
    rawEventId ? String(id) === String(rawEventId) : true;
  const EID =
    rawEventId && mongoose.isValidObjectId(rawEventId)
      ? new mongoose.Types.ObjectId(rawEventId)
      : null;

  const report = {
    scope: EID ? { eventId: String(EID) } : "ALL EVENTS",
    dryRun: !apply,
    missingActors: {
      totalMeets: 0,
      cancelled: 0,
      deleted: 0,
      whitelistRemoved: 0,
      slotLocksRemoved: 0,
    },
    slotUsed: { recomputedPhysical: 0, recomputedHybrid: 0 },
    slotLocks: { deleted: 0, inserted: 0 },
    counters: { adjusted: 0 },
    notes: [],
  };

  // ─────────────────────────────────────────────────────────────
  // Helpers (local)
  const normISO = (dt) => {
    if (!dt) return null;
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return null;
    d.setSeconds(0, 0);
    return d.toISOString();
  };

  const ROLE_MODEL_SAFE = global.ROLE_MODEL || {
    attendee:
      global.Attendee || (typeof Attendee !== "undefined" ? Attendee : null),
    exhibitor:
      global.Exhibitor || (typeof Exhibitor !== "undefined" ? Exhibitor : null),
    speaker:
      global.Speaker || (typeof Speaker !== "undefined" ? Speaker : null),
  };

  async function actorExistsByRole(role, id) {
    const m =
      ROLE_MODEL_SAFE?.[String(role || "").toLowerCase()] ||
      ROLE_MODEL_SAFE.attendee ||
      ROLE_MODEL_SAFE.exhibitor ||
      ROLE_MODEL_SAFE.speaker;
    if (!m) return false;
    const doc = await m.findById(id).select("_id").lean();
    return !!doc;
  }

  async function bothVirtualFlags(sid, rid) {
    try {
      const { senderVirtual, receiverVirtual } = await loadVirtualFlags(
        sid,
        rid
      );
      return {
        senderVirtual,
        receiverVirtual,
        bothVirtual: senderVirtual && receiverVirtual,
        halfVirtual: senderVirtual !== receiverVirtual,
      };
    } catch {
      // Fallback if loadVirtualFlags is unavailable
      return {
        senderVirtual: false,
        receiverVirtual: false,
        bothVirtual: false,
        halfVirtual: false,
      };
    }
  }

  // Optional Hybrid model presence
  const HybridModel =
    typeof HybridMeetingSlot !== "undefined" ? HybridMeetingSlot : null;

  // Filter for meets
  const meetFilter = EID ? { eventId: EID } : {};
  const meets = await MeetRequest.find(meetFilter).lean();

  // ─────────────────────────────────────────────────────────────
  // 1) Handle missing actors per meeting
  for (const m of meets) {
    const eok = byEvent(m.eventId);
    if (!eok) continue;

    const [senderOk, receiverOk] = await Promise.all([
      actorExistsByRole(m.senderRole, m.senderId),
      actorExistsByRole(m.receiverRole, m.receiverId),
    ]);
    const missing = !senderOk || !receiverOk;

    if (missing) {
      report.missingActors.totalMeets += 1;

      // Remove whitelist for missing actors
      const toPurge = [];
      if (!senderOk) toPurge.push(m.senderId);
      if (!receiverOk) toPurge.push(m.receiverId);
      for (const aid of toPurge) {
        if (apply)
          await SlotWhitelist.deleteMany({ eventId: m.eventId, actorId: aid });
        report.missingActors.whitelistRemoved += 1;
      }

      // Remove slot locks for this meet/actors/slot(s)
      const slots = [
        normISO(m.slotISO),
        normISO(m.requestedAt),
        normISO(m.proposedNewAt),
      ].filter(Boolean);
      if (slots.length) {
        const delQ = {
          eventId: m.eventId,
          actorId: { $in: [m.senderId, m.receiverId] },
          slotISO: { $in: slots },
        };
        if (apply) {
          const r = await SlotIndex.deleteMany(delQ);
          report.missingActors.slotLocksRemoved += r?.deletedCount || 0;
        } else {
          const r = await SlotIndex.find(delQ).select("_id").lean();
          report.missingActors.slotLocksRemoved += r?.length || 0;
        }
      }

      // Fix capacity for confirmed meet with missing actor
      if (String(m.status).toLowerCase() === "confirmed") {
        const iso = normISO(m.slotISO || m.requestedAt);
        if (iso) {
          // Recompute phase later overwrites, but be conservative here too
          if (apply) {
            // physical vs hybrid split
            const vf = await bothVirtualFlags(m.senderId, m.receiverId);
            if (vf.bothVirtual) {
              // nothing to do (virtual not counted)
            } else if (vf.halfVirtual && HybridModel) {
              await HybridModel.updateOne(
                {
                  eventId: m.eventId,
                  slotISO: new Date(iso),
                  used: { $gt: 0 },
                },
                { $inc: { used: -1 } }
              );
            } else {
              await MeetingSlot.updateOne(
                {
                  eventId: m.eventId,
                  slotISO: new Date(iso),
                  used: { $gt: 0 },
                },
                { $inc: { used: -1 } }
              );
            }
          }
        }
      }

      // Finally cancel or delete the meet
      if (apply) {
        if (mode === "delete") {
          await MeetRequest.deleteOne({ _id: m._id });
          report.missingActors.deleted += 1;
        } else {
          await MeetRequest.updateOne(
            { _id: m._id },
            {
              $set: {
                status: "cancelled",
                cancelledAt: new Date(),
                cancelledBy: null,
                cancelledReason: "actor-missing",
                tableId: null,
              },
            }
          );
          report.missingActors.cancelled += 1;
        }
      } else {
        if (mode === "delete") report.missingActors.deleted += 1;
        else report.missingActors.cancelled += 1;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2) Recompute used per slot from confirmed meetings
  //    physical vs hybrid counts
  const confFilter = EID
    ? { eventId: EID, status: "confirmed" }
    : { status: "confirmed" };
  const confirmed = await MeetRequest.find(confFilter)
    .select("eventId slotISO senderId receiverId")
    .lean();

  // Aggregate counts
  const physMap = new Map(); // key: eventId|iso => count
  const hybrMap = new Map(); // if HybridMeetingSlot exists
  for (const m of confirmed) {
    const keyISO = normISO(m.slotISO);
    if (!keyISO) continue;
    const vf = await bothVirtualFlags(m.senderId, m.receiverId);
    const ek = `${String(m.eventId)}|${keyISO}`;
    if (vf.bothVirtual) {
      // ignore (virtual not counted)
    } else if (vf.halfVirtual && HybridModel) {
      hybrMap.set(ek, (hybrMap.get(ek) || 0) + 1);
    } else {
      physMap.set(ek, (physMap.get(ek) || 0) + 1);
    }
  }

  // Upsert + set used for physical slots
  for (const [ek, used] of physMap.entries()) {
    const [id, iso] = ek.split("|");
    if (apply) {
      // keep cap as-is or create with default from ensureCapDoc-like logic
      const ev = await Event.findById(id).select("b2bCapacity").lean();
      const capDefault =
        Number(ev?.b2bCapacity) > 0 ? Number(ev.b2bCapacity) : 30;
      await MeetingSlot.updateOne(
        { eventId: id, slotISO: new Date(iso) },
        {
          $setOnInsert: {
            eventId: id,
            slotISO: new Date(iso),
            cap: capDefault,
          },
          $set: { used },
        },
        { upsert: true }
      );
    }
    report.slotUsed.recomputedPhysical += 1;
  }

  // Zero out physical slots that no longer have meetings (only within scope)
  if (apply) {
    const slotQ = EID ? { eventId: EID } : {};
    const allSlots = await MeetingSlot.find(slotQ)
      .select("eventId slotISO used")
      .lean();
    for (const s of allSlots) {
      const k = `${String(s.eventId)}|${normISO(s.slotISO)}`;
      if (!physMap.has(k) && s.used !== 0) {
        await MeetingSlot.updateOne({ _id: s._id }, { $set: { used: 0 } });
      }
    }
  }

  // Hybrid used (if model exists)
  if (HybridModel) {
    for (const [ek, used] of hybrMap.entries()) {
      const [id, iso] = ek.split("|");
      if (apply) {
        await HybridModel.updateOne(
          { eventId: id, slotISO: new Date(iso) },
          {
            $setOnInsert: { eventId: id, slotISO: new Date(iso), cap: 9999 },
            $set: { used },
          }, // cap placeholder for hybrid
          { upsert: true }
        );
      }
      report.slotUsed.recomputedHybrid += 1;
    }
    if (apply) {
      const hQ = EID ? { eventId: EID } : {};
      const allH = await HybridModel.find(hQ)
        .select("eventId slotISO used")
        .lean();
      for (const s of allH) {
        const k = `${String(s.eventId)}|${normISO(s.slotISO)}`;
        if (!hybrMap.has(k) && s.used !== 0) {
          await HybridModel.updateOne({ _id: s._id }, { $set: { used: 0 } });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3) Rebuild SlotIndex locks from truth (confirmed meets)
  // Expected locks: for each confirmed meeting, 2 docs (sender/receiver)
  const expected = new Set();
  for (const m of confirmed) {
    const iso = normISO(m.slotISO);
    if (!iso) continue;
    expected.add(`${String(m.eventId)}|${String(m.senderId)}|${iso}`);
    expected.add(`${String(m.eventId)}|${String(m.receiverId)}|${iso}`);
  }

  const lockQ = EID ? { eventId: EID } : {};
  const locks = await SlotIndex.find(lockQ)
    .select("eventId actorId slotISO _id")
    .lean();
  const existing = new Map(); // key=>_id
  for (const L of locks) {
    const k = `${String(L.eventId)}|${String(L.actorId)}|${normISO(L.slotISO)}`;
    existing.set(k, L._id);
  }

  // Delete extras
  for (const [k, id] of existing.entries()) {
    if (!expected.has(k)) {
      report.slotLocks.deleted += 1;
      if (apply) await SlotIndex.deleteOne({ _id: id });
    }
  }
  // Insert missing
  for (const k of expected) {
    if (!existing.has(k)) {
      report.slotLocks.inserted += 1;
      if (apply) {
        const [eid, aid, iso] = k.split("|");
        await SlotIndex.updateOne(
          { eventId: eid, actorId: aid, slotISO: iso },
          { $setOnInsert: { eventId: eid, actorId: aid, slotISO: iso } },
          { upsert: true }
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 4) Sync MeetingTableCounter (optional; only useful if you still consume it)
  if (syncCounters && typeof MeetingTableCounter !== "undefined") {
    // Compute physical count per (eventId, slotISO)
    const physCounts = new Map(); // ek -> count
    for (const m of confirmed) {
      const iso = normISO(m.slotISO);
      if (!iso) continue;
      const vf = await bothVirtualFlags(m.senderId, m.receiverId);
      if (!vf.bothVirtual && !vf.halfVirtual) {
        const ek = `${String(m.eventId)}|${iso}`;
        physCounts.set(ek, (physCounts.get(ek) || 0) + 1);
      }
    }

    for (const [ek, n] of physCounts.entries()) {
      const [eid, iso] = ek.split("|");
      if (apply) {
        const doc = await MeetingTableCounter.findOneAndUpdate(
          { eventId: eid, slotISO: new Date(iso) },
          {
            $setOnInsert: { eventId: eid, slotISO: new Date(iso), next: n },
            $set: { next: n },
          },
          { new: true, upsert: true }
        ).lean();
        if (doc?.next !== n) {
          await MeetingTableCounter.updateOne(
            { _id: doc._id },
            { $set: { next: n } }
          );
        }
      }
      report.counters.adjusted += 1;
    }
  }

  return res.json({ success: true, apply, mode, report });
});

function toYMD(d) {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
function normISOToStep(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setSeconds(0, 0);
  const snap = Math.floor(d.getTime() / STEP_MS) * STEP_MS;
  return new Date(snap);
}
function dayBoundsUTC(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const start = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0));
  const endEx = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, endEx };
}

// GET /api/availability/:eventId/my?date=YYYY-MM-DD
exports.getMyWhitelist = async (req, res) => {
  const { eventId } = req.params || {};
  const { date } = req.query || {};
  const { actorId } = req.query || {};
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });
  const me =
    actorId && mongoose.isValidObjectId(actorId) ? actorId : req.user?._id;
  if (!me) return res.status(401).json({ message: "Unauthorized" });
  const rng = dayBoundsUTC(date);
  if (!rng) return res.status(400).json({ message: "Bad date" });

  const doc = await SlotWhitelist.findOne({ eventId, actorId: me })
    .select("slots")
    .lean();

  const all = Array.isArray(doc?.slots) ? doc.slots : [];
  const daySlots = all
    .map((v) => (v instanceof Date ? v : new Date(v)))
    .filter((v) => v >= rng.start && v < rng.endEx)
    .sort((a, b) => a - b);

  return res.json({
    success: true,
    eventId,
    date,
    hasWhitelist: !!all.length,
    data: daySlots.map((d) => d.toISOString()),
  });
};

// POST /api/availability/:eventId/my  { date, slots:[iso...] }
exports.setMyWhitelist = async (req, res) => {
  const { eventId } = req.params || {};
  const { date, slots } = req.body || {};
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });
  const me = req.body.actorId || req.user?._id;
  console.log(req.body);
  if (!me) return res.status(401).json({ message: "Unauthorized" });

  const rng = dayBoundsUTC(date);
  if (!rng) return res.status(400).json({ message: "Bad date" });

  if (!Array.isArray(slots))
    return res.status(400).json({ message: "slots must be an array" });

  // Normalize & keep only slots inside this day
  const nextDaySlots = [];
  for (const s of slots) {
    const d = normISOToStep(s);
    if (!d) continue;
    if (d >= rng.start && d < rng.endEx) nextDaySlots.push(d);
  }
  // Dedupe
  const dedup = new Map(nextDaySlots.map((d) => [d.getTime(), d]));
  const payloadDay = Array.from(dedup.values()).sort((a, b) => a - b);

  // Upsert document; remove any existing slots for THIS day, then add payloadDay
  const doc = await SlotWhitelist.findOne({ eventId, actorId: me });
  if (!doc) {
    const created = await SlotWhitelist.create({
      eventId,
      actorId: me,
      slots: payloadDay,
    });
    return res.json({
      success: true,
      eventId,
      date,
      data: created.slots.map((d) => d.toISOString()),
    });
  }

  const all = Array.isArray(doc.slots) ? doc.slots : [];
  const kept = all.filter((v) => v < rng.start || v >= rng.endEx);
  doc.slots = kept.concat(payloadDay);
  await doc.save();

  const dayOut = doc.slots
    .filter((v) => v >= rng.start && v < rng.endEx)
    .sort((a, b) => a - b)
    .map((d) => d.toISOString());

  return res.json({ success: true, eventId, date, data: dayOut });
};

// helper: find actor & role across attendee/exhibitor/speaker for an event
async function probeActorRoleAndDoc(eventId, actorId) {
  const [att, exh, spk] = await Promise.all([
    typeof attendee !== "undefined"
      ? attendee
          .findOne({ _id: actorId, id_event: eventId })
          .select("personal organization id_event")
          .lean()
      : null,
    typeof exhibitor !== "undefined"
      ? exhibitor
          .findOne({ _id: actorId, id_event: eventId })
          .select("contact organization companyName logo id_event")
          .lean()
      : null,
    typeof speaker !== "undefined"
      ? speaker
          .findOne({ _id: actorId, id_event: eventId })
          .select("personal identity organization id_event")
          .lean()
      : null,
  ]);
  if (att) return { role: "attendee", doc: att };
  if (exh) return { role: "exhibitor", doc: exh };
  if (spk) return { role: "speaker", doc: spk };
  return null;
}

function shapeActor(role, d) {
  if (!d) return {};
  if (role === "attendee") {
    return {
      name: d?.personal?.fullName || "",
      email: d?.personal?.email || "",
      organization: d?.organization?.orgName || "",
      gender: d?.personal?.gender || "",
      avatar: d?.personal?.profilePic || "",
    };
  }
  if (role === "exhibitor") {
    return {
      name:
        d?.organization?.orgName || d?.companyName || d?.contact?.name || "",
      email: d?.contact?.email || "",
      organization: d?.organization?.orgName || d?.companyName || "",
      gender: d?.contact?.gender || "",
      avatar: d?.logo || "",
    };
  }
  // speaker
  return {
    name: d?.personal?.fullName || d?.identity?.fullName || "",
    email: d?.personal?.email || d?.identity?.email || "",
    organization: d?.organization?.orgName || "",
    gender: d?.personal?.gender || d?.identity?.gender || "",
    avatar: d?.personal?.profilePic || d?.identity?.avatar || "",
  };
}

// controllers/adminScanActorAttend.js (or wherever this lives)
exports.adminScanActorAttend = asyncHandler(async (req, res) => {
  let { eventId, actorId, actorRole, token, preview } = req.body || {};

  // token support (unchanged)
  if (token && !eventId && !actorId) {
    try {
      const o = JSON.parse(
        Buffer.from(String(token), "base64url").toString("utf8")
      );
      eventId = o.eventId || eventId;
      actorId = o.actorId || actorId;
      actorRole = o.actorRole || actorRole;
    } catch {}
  }

  if (
    !mongoose.isValidObjectId(eventId) ||
    !mongoose.isValidObjectId(actorId)
  ) {
    return res.status(400).json({ message: "Bad ids" });
  }

  let role = (actorRole || "").trim().toLowerCase();
  let actorDoc = null;

  // If role not provided, probe all three collections
  if (!role) {
    const found = await probeActorRoleAndDoc(eventId, actorId);
    if (!found) return res.status(404).json({ message: "Actor not in event" });
    role = found.role;
    actorDoc = found.doc;
  } else {
    // Validate given role and fetch doc for return
    const Model = resolveActorModel(role);
    if (!Model) return res.status(400).json({ message: "Bad actorRole" });
    actorDoc = await Model.findOne({ _id: actorId, id_event: eventId }).lean();
    if (!actorDoc)
      return res.status(404).json({ message: "Actor not in event" });
  }

  // Check existing check-in BEFORE preview/confirm
  const existing = await EventCheckin.findOne({
    eventId,
    actorId,
    actorRole: role,
  })
    .select("at")
    .lean();
  const alreadyCheckedIn = !!existing;
  const lastCheckinAt = existing?.at || null;

  if (preview) {
    // Preview: return identity + whether already checked-in
    return res.json({
      success: true,
      data: {
        preview: true,
        actorRole: role,
        actor: shapeActor(role, actorDoc),
        alreadyCheckedIn,
        lastCheckinAt,
      },
    });
  }

  // Confirm (upsert)
  await EventCheckin.updateOne(
    { eventId, actorId, actorRole: role },
    {
      $set: {
        eventId,
        actorId,
        actorRole: role,
        at: new Date(),
        by: req.user?._id || null,
      },
    },
    { upsert: true }
  );
  try {
    await scheduleFeedbackPrompt({
      kind: 'event',
      eventId,
      actorId,
      refId: eventId,
      role: role,
      at: new Date(Date.now() + 60 * 60 * 1000),
    });
    console.log("[feedback][queued] kind=event ref=%s actor=%s", String(eventId), String(actorId));

  } catch (e) {
    console.error('[feedback][event] schedule failed:', e?.message || e);
  }
  const count = await EventCheckin.countDocuments({ eventId });
  
  return res.json({
    success: true,
    data: {
      checkedIn: true,
      eventCheckins: count,
      actorRole: role,
      actor: shapeActor(role, actorDoc),
      alreadyCheckedIn, // report whether it was already checked before this confirm
      lastCheckinAt,
    },
  });
});

exports.adminScanSession = asyncHandler(async (req, res) => {
  let {
    sessionId,
    eventId,
    actorId,
    actorRole,
    token,
    preview,
    mark = true,
  } = req.body || {};

  // Optional token support (base64url JSON: { eventId, sessionId, actorId, actorRole })
  if (token && (!eventId || !sessionId || !actorId)) {
    try {
      const o = JSON.parse(
        Buffer.from(String(token), "base64url").toString("utf8")
      );
      eventId = o.eventId || eventId;
      sessionId = o.sessionId || sessionId;
      actorId = o.actorId || actorId;
      actorRole = o.actorRole || actorRole;
    } catch {}
  }

  if (
    !mongoose.isValidObjectId(eventId) ||
    !mongoose.isValidObjectId(sessionId)
  )
    return res.status(400).json({ message: "Bad ids" });
  if (!mongoose.isValidObjectId(actorId))
    return res.status(400).json({ message: "Bad ids" });

  // Resolve role + load doc
  let role = String(actorRole || "")
    .trim()
    .toLowerCase();
  let actorDoc = null;

  if (!role) {
    const found = await probeActorRoleAndDoc(eventId, actorId);
    if (!found) return res.status(404).json({ message: "Actor not in event" });
    role = found.role;
    actorDoc = found.doc;
  } else {
    const Model = resolveActorModel(role);
    if (!Model) return res.status(400).json({ message: "Bad actorRole" });
    actorDoc = await Model.findOne({ _id: actorId, id_event: eventId }).lean();
    if (!actorDoc)
      return res.status(404).json({ message: "Actor not in event" });
  }

  // Is actor assigned to this session? (ignore cancelled)
  const reg = await SessionRegistration.findOne({
    sessionId,
    actorId,
    eventId,
    status: { $ne: "cancelled" },
  })
    .select("status")
    .lean();
  const assigned = !!reg;

  // Prior session attendance?
  const existing = await SessionAttendance.findOne({
    sessionId,
    eventId,
    actorId,
  })
    .select("at")
    .lean();
  const alreadyCheckedIn = !!existing;
  const lastCheckinAt = existing?.at || null;

  // Preview only -> do not mark
  if (preview) {
    return res.json({
      success: true,
      data: {
        preview: true,
        actorRole: role,
        actor: shapeActor(role, actorDoc),
        assigned,
        alreadyCheckedIn,
        lastCheckinAt,
      },
    });
  }

  // Confirm (mark) only if assigned
  let marked = false;
  if (mark && assigned) {
    await SessionAttendance.updateOne(
      { sessionId, eventId, actorId },
      {
        $set: {
          sessionId,
          eventId,
          actorId,
          actorRole: role,
          at: new Date(),
          by: req.user?._id || null,
        },
      },
      { upsert: true }
    );
    marked = true;
  }

  const sessionCheckins = await SessionAttendance.countDocuments({ sessionId });
  try {
      await scheduleFeedbackPrompt({
        kind: 'session',
        eventId,
        refId: sessionId,
        actorId,
        role: role,
        at: new Date(Date.now() + 60 * 60 * 1000),
      });
      console.log("[feedback][queued] kind=session ref=%s actor=%s", String(sessionId), String(actorId));
    } catch (e) {
      console.error('[feedback][session] schedule failed:', e?.message || e);
    }
  return res.json({
    success: true,
    data: {
      marked,
      assigned,
      alreadyCheckedIn,
      lastCheckinAt,
      actorRole: role,
      actor: shapeActor(role, actorDoc),
      sessionCheckins,
    },
  });
});
exports.adminScanMeet = asyncHandler(async (req, res) => {
  let { meetId, actorId, kind = "physical", preview } = req.body || {};
  if (!mongoose.isValidObjectId(meetId) || !mongoose.isValidObjectId(actorId)) {
    return res.status(400).json({ message: "Bad ids" });
  }
  if (!["physical", "virtual"].includes(String(kind))) {
    return res.status(400).json({ message: "Bad kind" });
  }

  const meet = await MeetRequest.findById(meetId).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });

  // verify actor belongs to this meet
  const senderId = String(meet.senderId || "");
  const receiverId = String(meet.receiverId || "");
  const youId = String(actorId);
  const isSender = youId === senderId;
  const isReceiver = youId === receiverId;
  if (!isSender && !isReceiver) {
    return res
      .status(403)
      .json({ message: "Actor is not a participant of this meeting" });
  }

  const youRole = isSender ? meet.senderRole : meet.receiverRole;
  const otherId = isSender ? receiverId : senderId;
  const otherRole = isSender ? meet.receiverRole : meet.senderRole;

  // helper to read current checkins
  async function readState() {
    const recs = await MeetingAttendance.find({ meetingId: meetId }).lean();
    const youRec = recs.find((r) => String(r.actorId) === youId);
    const otherRec = recs.find((r) => String(r.actorId) === otherId);
    const both = recs.filter((r) => !!r.attended).length;
    const happened = both >= 2;

    // earliest check-in
    let firstArrived = null;
    if (recs.length) {
      const sorted = [...recs].sort((a, b) => new Date(a.at) - new Date(b.at));
      if (sorted[0]?.at)
        firstArrived = { actorId: String(sorted[0].actorId), at: sorted[0].at };
    }

    return {
      recs,
      happened,
      youCheckedInAt: youRec?.at || null,
      otherCheckedInAt: otherRec?.at || null,
      firstArrived,
      youWereFirst: firstArrived
        ? String(firstArrived.actorId) === youId
        : false,
      alreadyCheckedIn: !!youRec?.attended,
      otherCheckedIn: !!otherRec?.attended,
    };
  }

  // PREVIEW — do not mark, only report membership & current state
  if (preview) {
    const s = await readState();
    return res.json({
      success: true,
      data: {
        preview: true,
        you: { actorId: youId, role: youRole },
        other: { actorId: otherId, role: otherRole },
        happened: s.happened,
        alreadyCheckedIn: s.alreadyCheckedIn,
        otherCheckedIn: s.otherCheckedIn,
        youCheckedInAt: s.youCheckedInAt,
        otherCheckedInAt: s.otherCheckedInAt,
        firstArrived: s.firstArrived,
        youWereFirst: s.youWereFirst,
      },
    });
  }

  // MARK — upsert your attendance
  await MeetingAttendance.updateOne(
    { meetingId: meetId, actorId: youId, kind },
    {
      $set: {
        meetingId: meetId,
        eventId: meet.eventId,
        actorId: youId,
        kind,
        attended: true,
        at: new Date(),
        by: req.user?._id || null,
      },
    },
    { upsert: true }
  );

  // if first arrival not stored, set it (kept as extra fields without schema migration)
  await MeetRequest.updateOne(
    { _id: meetId, "firstArrived.actorId": { $exists: false } },
    { $set: { firstArrived: { actorId: youId, at: new Date() } } }
  );
  try {
    await scheduleFeedbackPrompt({
      kind: 'meet',
      eventId: meet.eventId,
      meetId,
      actorId: youId,
      role: youRole,
      refId: meetId,
      at: new Date(Date.now() + 60 * 60 * 1000),
    });
    console.log("[feedback][queued] kind=meet ref=%s actor=%s", String(meetId), String(youId));

  } catch (e) {
    console.error('[feedback][meet] schedule failed:', e?.message || e);
  }
  // recompute final state
  const state = await readState();

  // if both present, stamp happenedAt (once)
  if (state.happened) {
    await MeetRequest.updateOne(
      { _id: meetId, happenedAt: { $exists: false } },
      { $set: { happenedAt: new Date() } }
    );
  }

  return res.json({
    success: true,
    data: {
      checkedIn: true,
      happened: state.happened,
      you: { actorId: youId, role: youRole },
      other: { actorId: otherId, role: otherRole },
      alreadyCheckedIn: state.alreadyCheckedIn,
      otherCheckedIn: state.otherCheckedIn,
      youCheckedInAt: state.youCheckedInAt,
      otherCheckedInAt: state.otherCheckedInAt,
      firstArrived: state.firstArrived,
      youWereFirst: state.youWereFirst,
    },
  });
});

exports.exportConfirmedMeetsCSV = asyncHandler(async (req, res) => {
  const { eventId } = req.query || {};
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message: "Bad eventId" });

  const rows = await MeetRequest.find({ eventId, status: "confirmed" })
    .select("slotISO senderId receiverId tableId meetLink happenedAt")
    .populate({
      path: "senderId",
      select: "personal.fullName identity.exhibitorName identity.contactName",
    })
    .populate({
      path: "receiverId",
      select: "personal.fullName identity.exhibitorName identity.contactName",
    })
    .lean();

  const csv = ["meetId,slotISO,sender,receiver,tableId,meetLink,happenedAt"]
    .concat(
      rows.map((r) => {
        const sName =
          r.senderId?.personal?.fullName ||
          r.senderId?.identity?.contactName ||
          r.senderId?.identity?.exhibitorName ||
          "";
        const rName =
          r.receiverId?.personal?.fullName ||
          r.receiverId?.identity?.contactName ||
          r.receiverId?.identity?.exhibitorName ||
          "";
        return [
          r._id,
          r.slotISO ? new Date(r.slotISO).toISOString() : "",
          JSON.stringify(sName),
          JSON.stringify(rName),
          r.tableId || "",
          r.meetLink || "",
          r.happenedAt ? new Date(r.happenedAt).toISOString() : "",
        ].join(",");
      })
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="confirmed_meetings_${eventId}.csv"`
  );
  return res.end(csv);
});
const ActorNotification = require("../models/actorNotification"); // existing schema
const toId = (v) => new mongoose.Types.ObjectId(String(v));
const suggIdOf = (a, b) => {
  const [x, y] = [String(a), String(b)].sort();
  return `${x}_${y}`;
};
const words = (x = []) =>
  Array.from(
    new Set(
      []
        .concat(x)
        .flatMap((s) => String(s || "").split(/[,/|]+|\s+/g))
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  );

async function bpFor(actorId, eventId) {
  const bp = await BusinessProfile.findOne({
    "owner.actor": actorId,
    event: eventId,
  })
    .select(
      "industries offering seeking languages countries name slug owner logo images"
    )
    .lean();
  return bp || null;
}

const t = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
function intersectSortedTimes(aTimes, bTimes) {
  // aTimes/bTimes are ascending arrays of Numbers (ms)
  const res = [];
  let i = 0,
    j = 0;
  while (i < aTimes.length && j < bTimes.length) {
    if (aTimes[i] === bTimes[j]) {
      res.push(aTimes[i]);
      i++;
      j++;
    } else if (aTimes[i] < bTimes[j]) i++;
    else j++;
  }
  return res;
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const A = new Set(a),
    B = new Set(b);
  let inter = 0;
  A.forEach((v) => {
    if (B.has(v)) inter++;
  });
  const uni = A.size + B.size - inter;
  return inter / (uni || 1);
}

function scorePair(meA, meB, metaA = {}, metaB = {}) {
  // Cross-intent hits (offering⇄seeking) both ways
  const lxo = meA.seeking.filter((t) => meB.offering.includes(t)).length;
  const oxl = meA.offering.filter((t) => meB.seeking.includes(t)).length;
  // Jaccard similarities
  const ind = jaccard(meA.industries, meB.industries);
  const lng = jaccard(meA.languages, meB.languages);
  const cnt = jaccard(meA.countries, meB.countries);
  // verified boost (tiny)
  const ver = (metaA.verified ? 0.05 : 0) + (metaB.verified ? 0.05 : 0);
  // weighted sum (tuned quickly) — DO NOT CHANGE
  return lxo * 5 + oxl * 5 + ind * 3 + lng * 1.5 + cnt * 2 + ver;
}

// ========== SUGGESTIONS ==========
exports.getSuggestedListAdmin = asyncHandler(async (req, res) => {
  // Admin calls this. If token has actor, we accept it; otherwise require eventId in query
  const q = req.query || {};
  const eventId =
    q.eventId && mongoose.isValidObjectId(q.eventId) ? toId(q.eventId) : null;
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  const pool = Math.min(2000, Math.max(2, Number(q.pool || 400))); // candidates considered

  if (!eventId) return res.status(400).json({ message: "eventId is required" });

  // Pool: attendees in event who are open to meetings
  const base = {
    id_event: eventId,
    "matchingIntent.openToMeetings": { $ne: false },
  };
  const rows = await attendee
    .find(base)
    .select(
      "_id personal.fullName personal.country personal.preferredLanguages organization.orgName verified personal.profilePic"
    )
    .limit(pool)
    .lean();

  // Preload SlotWhitelist for all candidates
  let wlMap = new Map();
  if (SlotWhitelist) {
    const ids = rows.map((r) => r._id);
    const wls = await SlotWhitelist.find({ eventId, actorId: { $in: ids } })
      .select("actorId slots")
      .lean();
    wlMap = new Map(
      wls.map((w) => [
        String(w.actorId),
        (w.slots || []).map(t).sort((a, b) => a - b),
      ])
    );
  }

  // Preload busy slots from existing requests for these actors (blockers only)
  const idStrs = rows.map((r) => String(r._id));
  const busy = new Map(); // actorId -> Set(ms)
  const busyDocs = await MeetRequest.find({
    eventId,
    status: { $in: ["pending", "accepted", "reschedule-proposed"] },
    $or: [{ senderId: { $in: idStrs } }, { receiverId: { $in: idStrs } }],
  })
    .select("senderId receiverId slotISO")
    .lean();
  for (const d of busyDocs) {
    const ms = t(d.slotISO);
    const sId = String(d.senderId),
      rId = String(d.receiverId);
    if (!busy.has(sId)) busy.set(sId, new Set());
    if (!busy.has(rId)) busy.set(rId, new Set());
    busy.get(sId).add(ms);
    busy.get(rId).add(ms);
  }

  // Prepare feature vectors using BusinessProfile if exists; also keep a tiny bp cache for logo fallback
  const vectors = new Map(); // actorId -> vector
  const bpLogo = new Map(); // actorId -> logo url if any
  await Promise.all(
    rows.map(async (r) => {
      const bp = await bpFor(r._id, eventId);
      const v = {
        actorId: String(r._id),
        industries: words(bp?.industries || []),
        offering: words(bp?.offering || []),
        seeking: words(bp?.seeking || []),
        languages: words(
          bp?.languages || r?.personal?.preferredLanguages || []
        ),
        countries: words(
          bp?.countries || [r?.personal?.country].filter(Boolean)
        ),
      };
      vectors.set(String(r._id), v);
      const logo =
        bp?.logo?.url ||
        bp?.logo ||
        (Array.isArray(bp?.images) ? bp.images[0] : null);
      if (logo) bpLogo.set(String(r._id), String(logo));
    })
  );

  // Helper to extract a photo from attendee row or bp cache
  const photoOf = (row) => {
    console.log("row >>", row);
    const r = row || {};
    return (
      r?.personal?.profilePic ||
      r?.personal?.photo ||
      bpLogo.get(String(r?._id)) ||
      ""
    );
  };

  const ids = rows.map((r) => String(r._id));
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = vectors.get(ids[i]);
      const B = vectors.get(ids[j]);
      const metaA = rows[i] || {},
        metaB = rows[j] || {};
      const sc = scorePair(A, B, metaA, metaB) + scorePair(B, A, metaB, metaA);
      if (sc > 0) pairs.push({ a: ids[i], b: ids[j], score: sc });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const used = new Set();
  const picked = [];
  for (const p of pairs) {
    if (picked.length >= limit) break;
    if (used.has(p.a) || used.has(p.b)) continue;

    const wa = wlMap.get(String(p.a)) || [];
    const wb = wlMap.get(String(p.b)) || [];
    if (!wa.length || !wb.length) continue; // missing whitelist => skip

    // common whitelist times
    const common = intersectSortedTimes(wa, wb);
    if (!common.length) continue;

    // find first slot free for BOTH actors (no meeting request at that time)
    const busyA = busy.get(String(p.a)) || new Set();
    const busyB = busy.get(String(p.b)) || new Set();
    let chosen = null;
    for (const ms of common) {
      if (!busyA.has(ms) && !busyB.has(ms)) {
        chosen = ms;
        break;
      }
    }
    if (!chosen) continue; // all common slots are busy

    used.add(p.a);
    used.add(p.b);
    picked.push({ ...p, slotMs: chosen });
  }

  // Attach payload for UI (guaranteed slotISO)
  const actorsMap = new Map(rows.map((r) => [String(r._id), r]));
  const data = [];
  for (const p of picked) {
    const [aId, bId] = [p.a, p.b];
    const ra = actorsMap.get(aId),
      rb = actorsMap.get(bId);
    data.push({
      suggId: suggIdOf(aId, bId),
      eventId: String(eventId),
      score: p.score,
      slotISO: new Date(p.slotMs).toISOString(),
      slotReason: "ok",
      a: {
        id: aId,
        name: ra?.personal?.fullName || "",
        role: "attendee",
        photo: photoOf(ra),
        adminLinks: { attendee: `/admin/members/attendees?id=${aId}` },
      },
      b: {
        id: bId,
        name: rb?.personal?.fullName || "",
        role: "attendee",
        photo: photoOf(rb),
        adminLinks: { attendee: `/admin/members/attendees?id=${bId}` },
      },
    });
  }

  return res.json({ success: true, count: data.length, data });
});
// ───────────────────────── ADMIN: generate Google Meet (platform link) ─────────────────────────
// POST /admin/meets/:id/gmeet
exports.adminGenerateGoogleMeetLink = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Bad id" });

  const row = await MeetRequest.findById(id);
  if (!row) return res.status(404).json({ message: "Meeting not found" });

  // use same platform link scheme you already use for virtual room
  const FRONT = process.env.FRONTEND_URL || "";
  const vlink = `${FRONT}/vmeet/${String(row._id)}`; // same pattern as elsewhere
  row.meetLink = vlink; // persists/overwrites as the “Google Meet link” entry point
  row.markModified?.('meetLink');
  await row.save();

  // notify both parties (reuse your mailer template utilities)
  const subj = "Your virtual meeting room is ready";
  const html = `
    <p>Hello,</p>
    <p>The virtual room for your meeting on <b>${new Date(row.slotISO).toLocaleString()}</b> is now available.</p>
    <p><a href="${vlink}">Open the virtual room</a></p>
    <p><em>Important:</em> Please join exactly on time and avoid leaving once you enter.</p>
  `;

  // sender + receiver emails via your existing participant helpers (attachParticipants/getMeta)
  const [enriched] = await attachParticipants([row.toObject()]);
  const toList = []
    .concat(enriched?.sender?.email || [])
    .concat(enriched?.receiver?.email || [])
    .filter(Boolean);

  // use the same sendMail helper already used in this controller
  for (const to of toList) {
    try { await sendMail({ to, subject: subj, html }); } catch (_) {}
  }

  return res.json({ success: true, link: vlink });
});
// ───────────────────────── ACTOR: get link & mark virtual attendance ─────────────────────────
// GET /meets/:meetId/vlink/:actorId
// - returns the platform link if generated
// - also upserts a virtual attendance record for that actor (same method as adminScanMeet)
exports.actorGetVirtualLinkAndAttend = asyncHandler(async (req, res) => {
  const { meetId, actorId } = req.params || {};
  if (!mongoose.isValidObjectId(meetId) || !mongoose.isValidObjectId(actorId)) {
    return res.status(400).json({ message: "Bad ids" });
  }

  const meet = await MeetRequest.findById(meetId).lean();
  if (!meet) return res.status(404).json({ message: "Meeting not found" });

  // membership check — same logic used in adminScanMeet
  const senderId   = String(meet.senderId || "");
  const receiverId = String(meet.receiverId || "");
  const youId      = String(actorId);
  const isSender   = youId === senderId;
  const isReceiver = youId === receiverId;
  if (!isSender && !isReceiver) {
    return res.status(403).json({ message: "Actor is not a participant of this meeting" });
  } // :contentReference[oaicite:4]{index=4}

  if (!meet.meetLink) return res.status(409).json({ message: "Virtual link not generated yet" });

  const youRole = isSender ? meet.senderRole : meet.receiverRole;

  // mark attendance like adminScanMeet does (upsert with time/by)
  await MeetingAttendance.updateOne(
    { meetingId: meetId, actorId: youId },
    {
      $set: {
        meetingId: meetId,
        actorId: youId,
        actorRole: youRole,
        kind: "virtual",
        attended: true,
        at: new Date(),
        by: youId
      }
    },
    { upsert: true }
  ); // :contentReference[oaicite:5]{index=5}

  return res.json({ success: true, link: meet.meetLink });
});
// ───────────────────────── ADMIN: list virtual & hybrid meets (+link existence) ───────────────
// GET /admin/meets/virtual-list?eventId=&status=accepted
exports.adminListVirtualHybridWithLink = asyncHandler(async (req, res) => {
  const { eventId, status } = req.query || {};
  const find = {};
  if (eventId && mongoose.isValidObjectId(eventId)) find.eventId = eventId;
  if (status) find.status = status;

  const rows = await MeetRequest.find(find).sort({ slotISO: 1 }).lean();

  const out = [];
  for (const r of rows) {
    // compute virtual flags exactly like elsewhere via loadVirtualFlags()
    const flags = await loadVirtualFlags(r.senderRole, r.senderId, r.receiverRole, r.receiverId, r.eventId);
    const bothVirtual = !!(flags?.senderVirtual && flags?.receiverVirtual);
    const halfVirtual = !!((flags?.senderVirtual && !flags?.receiverVirtual) || (!flags?.senderVirtual && flags?.receiverVirtual));
    const mode = bothVirtual ? "virtual" : halfVirtual ? "hybrid" : "physical";

    if (mode === "physical") continue; // show only virtual/hybrid as requested

    out.push({
      _id: r._id,
      eventId: r.eventId,
      slotISO: r.slotISO,
      mode,
      hasLink: !!r.meetLink,
      meetLink: r.meetLink || null,
      sender: { role: r.senderRole, actorId: r.senderId },
      receiver: { role: r.receiverRole, actorId: r.receiverId },
    });
  }

  return res.json({ success: true, count: out.length, data: out });
});
const JOB_NUDGE_PENDING = "meeting:pending-nudge";

/** Internal: scan all pending-like requests and email receivers once */
async function _sendPendingInvitesNudges({ eventId } = {}) {
  // pending buckets
  const PENDING_ST = ["pending", "reschedule-proposed"];

  const q = { status: { $in: PENDING_ST } };
  if (eventId) q.eventId = eventId;

  // We only need who must take action => the receiver
  const list = await MeetRequest.find(q)
    .select("receiverId receiverRole eventId")
    .lean();

  if (!list.length) return { scanned: 0, recipients: 0, sent: 0 };

  // de-dup per actor (role+id)
  const uniqKeys = new Set(list.map(r => `${r.receiverRole}:${r.receiverId}`));

  // resolve docs+emails
  const recipients = [];
  for (const key of uniqKeys) {
    const [role, id] = key.split(":");
    const Model = ROLE_MODEL[role];
    if (!Model) continue;
    const doc = await Model.findById(id).lean();
    if (!doc) continue;
    const email =
      role === "exhibitor" ? doc?.identity?.email : doc?.personal?.email;
    const displayName =
      role === "exhibitor"
        ? (doc?.identity?.exhibitorName || doc?.name || "there")
        : (doc?.personal?.fullName || "there");
    if (!email) continue;
    recipients.push({ key, role, id, email, displayName });
  }

  // Compose once
  const FRONT =
    process.env.MEETINGS_URL+"/meetings" ||
    process.env.FRONTEND_URL+"/meetings" ||
    process.env.FRONT_URL+"/meetings" ||
    "https://eventra.cloud/meetings";
  const subject = "You have pending B2B meeting invitations";
  const html = `
    <p>Hello,</p>
    <p>We noticed that you still have pending B2B meeting invitations on the platform.</p>
    <p>Please take a moment to review and confirm your invitations before they expire, this ensures you don’t miss valuable networking opportunities during the event.</p>
    <p>To do so, simply log in to your Eventra account, go to <em>“View Meetings”</em> under your profile, and check your pending invitations.</p>
    <p>If you need any assistance, feel free to reach out to our support team.<br/>
    Let’s make your B2B experience a success!</p>
    <p>Best regards,<br/>The Eventra Team</p>
    <p><a href="${FRONT}" target="_blank" rel="noopener noreferrer">View Meetings</a></p>
  `;

  let sent = 0;
  await Promise.all(
    recipients.map((r) =>
      sendMail(r.email, subject, html).then(() => (sent += 1))
    )
  );

  return { scanned: list.length, recipients: recipients.length, sent };
}

/** POST /api/admin/meets/remind-pending[?eventId=...]  (admin) */
// --- ADMIN: send reminder emails to all actors who still have pending meeting invites.
// POST /meets/admin/remind-pending?eventId=<optional>
exports.adminNudgePendingInvitesNow = asyncHandler(async (req, res) => {
  if (!req.user || String(req.user.role) !== 'admin') {
    return res.status(403).json({ ok:false, error:'Admin only' });
  }

  const eventId = req.query.eventId && isId(req.query.eventId) ? req.query.eventId : null;

  // pending buckets we consider “needs nudge”
  const match = { status: { $in: ['pending', 'reschedule-proposed'] } };
  if (eventId) match.eventId = eventId;

  const meets = await MeetRequest.find(match)
    .select('_id eventId senderId senderRole receiverId receiverRole')
    .lean();

  // collect unique actors (avoid spamming same person if they have many pending)
  const byRole = { attendee:new Set(), exhibitor:new Set(), speaker:new Set() };
  for (const m of meets) {
    byRole[m.senderRole]?.add(String(m.senderId));
    byRole[m.receiverRole]?.add(String(m.receiverId));
  }

  // hydrate actors by role in bulk
  const roleDocs = {};
  await Promise.all(Object.keys(byRole).map(async role => {
    const ids = Array.from(byRole[role]);
    const Model = ROLE_MODEL[role];
    if (!Model || !ids.length) { roleDocs[role] = {}; return; }
    const docs = await Model.find({ _id: { $in: ids } }).lean();
    const map = {};
    docs.forEach(d => { map[String(d._id)] = d; });
    roleDocs[role] = map;
  }));

  // email extractor per role
  const emailOf = (doc, role) => {
    if (!doc) return '';
    if (role === 'exhibitor') return doc.identity?.email || '';
    if (role === 'speaker')   return doc.personal?.email || '';
    return doc.personal?.email || ''; // attendee default
  };
  const FRONT =
    "https://eventra.cloud/meetings";
  const subject = 'Reminder: you have pending B2B meetings';
  const html = `
    <p>Hello,</p>
    <p>We noticed that you still have pending B2B meeting invitations on the platform.</p>
    <p>Please take a moment to review and confirm your invitations before they expire, this ensures you don’t miss valuable networking opportunities during the event.</p>
    <p>To do so, simply log in to your Eventra account, go to <em>“View Meetings”</em> under your profile, and check your pending invitations.</p>
    <p>If you need any assistance, feel free to reach out to our support team.<br/>
    Let’s make your B2B experience a success!</p>
    <p>Best regards,<br/>The Eventra Team</p>
    <p><a href="${FRONT}" target="_blank" rel="noopener noreferrer">View Meetings</a></p>
  `;

  let targeted = 0, sent = 0, skipped = 0;
  for (const role of Object.keys(byRole)) {
    for (const actorId of byRole[role]) {
      targeted += 1;
      try {
        const doc = roleDocs[role]?.[actorId];
        const to = emailOf(doc, role);
        if (!to) { skipped += 1; continue; }
        await sendMail(to, subject, html);
        sent += 1;
      } catch (e) {
        skipped += 1;
      }
    }
  }

  return res.json({
    ok: true,
    scope: eventId ? { eventId } : 'all-events',
    matchedMeets: meets.length,
    targetedActors: targeted,
    sent,
    skipped
  });
});

exports.adminListSessionAttendance = asyncHandler(async (req, res) => {
  const eventId   = req.params.eventId || req.query.eventId;
  const sessionId = req.params.sessionId || req.query.sessionId;
  const qTxt      = String(req.query.q || "").trim();
  const includeEmpty = String(req.query.includeEmpty || "") === "1";

  if (!mongoose.isValidObjectId(eventId)) {
    return res.status(400).json({ message: "Bad eventId" });
  }

  const $match = { eventId: new mongoose.Types.ObjectId(eventId) };
  if (sessionId && mongoose.isValidObjectId(sessionId)) {
    $match.sessionId = new mongoose.Types.ObjectId(sessionId);
  }

  // 1) Load all scans for the event (or session)
  const scans = await SessionAttendance.find($match).sort({ at: -1 }).lean();

  // 2) Collect ids for batching
  const sessionIds = Array.from(new Set(scans.map(s => String(s.sessionId))));
  const roleIds = { attendee: new Set(), exhibitor: new Set(), speaker: new Set() };
  for (const s of scans) {
    const r = String(s.actorRole || "").toLowerCase();
    if (roleIds[r]) roleIds[r].add(String(s.actorId));
  }

  // 3) Load sessions meta
  const sesIdsForQuery = sessionId
    ? [new mongoose.Types.ObjectId(sessionId)]
    : sessionIds.map(id => new mongoose.Types.ObjectId(id));

  const sessions = await EventSchedule.find(
      sesIdsForQuery.length ? { _id: { $in: sesIdsForQuery } } : { id_event: new mongoose.Types.ObjectId(eventId) }
    )
    .select("_id sessionTitle startTime endTime room roomId track")
    .sort({ startTime: 1, _id: 1 })
    .lean();

  // 4) Load actors by role (only the ones scanned)
  const [attDocs, exDocs, spDocs] = await Promise.all([
    roleIds.attendee.size
      ? attendee.find({ _id: { $in: Array.from(roleIds.attendee) } })
          .select("_id personal.fullName personal.email")
          .lean()
      : [],
    roleIds.exhibitor.size
      ? Exhibitor.find({ _id: { $in: Array.from(roleIds.exhibitor) } })
          .select("_id identity.exhibitorName identity.email")
          .lean()
      : [],
    roleIds.speaker.size
      ? Speaker.find({ _id: { $in: Array.from(roleIds.speaker) } })
          .select("_id personal.fullName personal.email")
          .lean()
      : [],
  ]);

  // 5) Index helpers
  const mapById = (arr) => {
    const m = new Map();
    for (const d of arr || []) m.set(String(d._id), d);
    return m;
  };
  const sessionMap = mapById(sessions);
  const attMap = mapById(attDocs);
  const exMap  = mapById(exDocs);
  const spMap  = mapById(spDocs);

  const labelFor = (role, doc) => {
    if (!doc) return { name: "—", email: "" };
    if (role === "exhibitor") {
      return { name: doc.identity?.exhibitorName || "Exhibitor", email: doc.identity?.email || "" };
    }
    return { name: doc.personal?.fullName || (role === "speaker" ? "Speaker" : "Attendee"),
             email: doc.personal?.email || "" };
  };

  // 6) Group scans under their session
  const groups = new Map();
  for (const s of scans) {
    const sid = String(s.sessionId);
    const sess = sessionMap.get(sid);
    if (!sess) continue;

    const g = groups.get(sid) || {
      sessionId: sid,
      title: sess.sessionTitle || "Session",
      startAt: sess.startTime || null,
      endAt:   sess.endTime   || null,
      room:    sess.room || null,
      track:   sess.track || "",
      attendees: []
    };

    let doc;
    if (s.actorRole === "exhibitor") doc = exMap.get(String(s.actorId));
    else if (s.actorRole === "speaker") doc = spMap.get(String(s.actorId));
    else doc = attMap.get(String(s.actorId));

    const { name, email } = labelFor(s.actorRole, doc);
    g.attendees.push({
      actorId: String(s.actorId),
      role: s.actorRole,
      name,
      email,
      at: s.at,
      by: s.by ? String(s.by) : null,
    });

    groups.set(sid, g);
  }

  // 7) Optionally include empty sessions (no scans yet)
  if (includeEmpty) {
    for (const sess of sessions) {
      const sid = String(sess._id);
      if (!groups.has(sid)) {
        groups.set(sid, {
          sessionId: sid,
          title: sess.sessionTitle || "Session",
          startAt: sess.startTime || null,
          endAt:   sess.endTime   || null,
          room:    sess.room || null,
          track:   sess.track || "",
          attendees: []
        });
      }
    }
  }

  // 8) Text filter (name/email)
  const q = qTxt.toLowerCase();
  let data = Array.from(groups.values()).sort((a,b) => (a.startAt || 0) - (b.startAt || 0));

  if (q) {
    data = data
      .map(g => ({
        ...g,
        attendees: g.attendees.filter(a =>
          (a.name || "").toLowerCase().includes(q) || (a.email || "").toLowerCase().includes(q)
        )
      }))
      .filter(g => g.attendees.length);
  }

  return res.json({ success: true, count: data.length, data });
});

exports.adminListEventAttendance = asyncHandler(async (req, res) => {
  const eventId = req.query.eventId && isId(req.query.eventId) ? req.query.eventId : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!eventId) return res.status(400).json({ ok: false, error: 'eventId required' });

  // Pull scans and sort by newest first. NOTE: EventCheckin uses { actorRole, at, by }
  const scans = await EventCheckin
    .find({ eventId })
    .sort({ at: -1 })
    .lean();

  // Group actor ids by role from scan docs (role key is s.actorRole)
  const idsByRole = scans.reduce((acc, s) => {
    const role = String(s.actorRole || '').toLowerCase();
    if (!role) return acc;
    if (!acc[role]) acc[role] = new Set();
    acc[role].add(String(s.actorId));
    return acc;
  }, {});

  // Bulk fetch minimal docs per role
  const roleDocs = {};
  await Promise.all(
    Object.keys(idsByRole).map(async (role) => {
      const ids = Array.from(idsByRole[role]);
      const Model = (typeof resolveActorModel === 'function')
        ? resolveActorModel(role)
        : (ROLE_MODEL ? ROLE_MODEL[role] : null);
      if (!Model || ids.length === 0) { roleDocs[role] = {}; return; }

      const docs = await Model
        .find({ _id: { $in: ids } })
        .lean();

      const map = {};
      docs.forEach(d => { map[String(d._id)] = d; });
      roleDocs[role] = map;
    })
  );

  // Normalize a doc into {name, org, email}
  const normActor = (role, doc) => {
    if (!doc) return { name: '', org: '', email: '' };

    // exhibitor
    if (role === 'exhibitor') {
      return {
        name:  doc.identity?.contactName || doc.identity?.exhibitorName || '',
        org:   doc.identity?.exhibitorName || doc.identity?.orgName || '',
        email: doc.identity?.email || ''
      };
    }

    // speaker
    if (role === 'speaker') {
      return {
        name:  doc.personal?.fullName || '',
        org:   doc.organization?.orgName || '',
        email: doc.personal?.email || ''
      };
    }

    // attendee (default)
    return {
      name:  doc.personal?.fullName || '',
      org:   doc.organization?.orgName || '',
      email: doc.personal?.email || ''
    };
  };

  // Shape response rows
  const data = scans.map((s) => {
    const role = String(s.actorRole || '').toLowerCase();
    const id   = String(s.actorId || '');
    const doc  = roleDocs[role]?.[id];
    const meta = normActor(role, doc);

    return {
      actorId  : id,
      role     : role,
      name     : meta.name,
      org      : meta.org,
      email    : meta.email,
      scannedAt: s.at || s.scannedAt || s.createdAt || null,
      scannerId: s.by || s.scannerId || null,
      source   : s.source || 'qr',
    };
  });

  // Count by role
  const byRole = data.reduce((acc, r) => {
    acc[r.role] = (acc[r.role] || 0) + 1;
    return acc;
  }, { attendee: 0, exhibitor: 0, speaker: 0 });

  // Optional text filter
  const filtered = q
    ? data.filter(x => (`${x.name} ${x.org} ${x.email} ${x.role}`).toLowerCase().includes(q))
    : data;

  res.json({
    ok: true,
    eventId,
    total: filtered.length,
    byRole,
    data: filtered,
  });
});



exports.adminListMeetingAttendance = asyncHandler(async (req, res) => {
  const eventId = req.params.eventId || req.query.eventId && isId(req.query.eventId) ? req.query.eventId : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!eventId) return res.status(400).json({ ok: false, error: 'eventId required' });

  // Pull accepted/active meets for the event
  const meets = await MeetRequest.find({
    eventId,
    status: { $in: ['accepted', 'confirmed', 'rescheduled'] }
  })
    .select('_id subject slotISO requestedAt senderId senderRole receiverId receiverRole vmeetLink')
    .sort({ slotISO: -1, requestedAt: -1 })
    .lean();

  const meetIds = meets.map((m) => m._id);
  const allAttendance = meetIds.length
    ? await MeetingAttendance.find({ meetId: { $in: meetIds } }).lean()
    : [];

  // collect all actorIds by role to hydrate once
  const need = { attendee: new Set(), exhibitor: new Set(), speaker: new Set() };
  for (const m of meets) {
    if (m.senderRole && ROLE_MODEL[m.senderRole]) need[m.senderRole].add(String(m.senderId));
    if (m.receiverRole && ROLE_MODEL[m.receiverRole]) need[m.receiverRole].add(String(m.receiverId));
  }
  for (const a of allAttendance) {
    if (a.role && ROLE_MODEL[a.role]) need[a.role].add(String(a.actorId));
  }

  const roleDocs = {};
  await Promise.all(
    Object.keys(need).map(async (role) => {
      const Model = ROLE_MODEL[role];
      if (!Model) { roleDocs[role] = {}; return; }
      const ids = Array.from(need[role]);
      if (!ids.length) { roleDocs[role] = {}; return; }
      const docs = await Model.find({ _id: { $in: ids } })
        .select('personal organization identity') // minimal
        .lean();
      const map = {};
      docs.forEach((d) => { map[String(d._id)] = d; });
      roleDocs[role] = map;
    })
  );

  const normActor = (role, doc) => {
    if (!doc) return { name: '', org: '', email: '' };
    if (role === 'exhibitor') {
      return {
        name: doc.identity?.contactName || doc.identity?.exhibitorName || '',
        org: doc.identity?.exhibitorName || doc.identity?.orgName || '',
        email: doc.identity?.email || '',
      };
    }
    if (role === 'speaker') {
      return {
        name: doc.personal?.fullName || '',
        org: doc.organization?.orgName || '',
        email: doc.personal?.email || '',
      };
    }
    // attendee default
    return {
      name: doc.personal?.fullName || '',
      org: doc.organization?.orgName || '',
      email: doc.personal?.email || '',
    };
  };

  // group attendance by meetId
  const attByMeet = new Map();
  for (const a of allAttendance) {
    const k = String(a.meetId);
    if (!attByMeet.has(k)) attByMeet.set(k, []);
    const doc = roleDocs[a.role]?.[String(a.actorId)];
    const meta = normActor(a.role, doc);
    attByMeet.get(k).push({
      actorId: String(a.actorId),
      role: a.role,
      name: meta.name,
      org: meta.org,
      email: meta.email,
      attendedAt: a.attendedAt || a.createdAt || null,
      scannerId: a.scannerId || null,
      source: a.source || 'qr',
    });
  }

  // build blocks
  let data = meets.map((m) => {
    const whenISO = m.slotISO || m.requestedAt || null;
    const senderDoc = roleDocs[m.senderRole]?.[String(m.senderId)];
    const receiverDoc = roleDocs[m.receiverRole]?.[String(m.receiverId)];
    const sender = { role: m.senderRole, id: String(m.senderId), ...normActor(m.senderRole, senderDoc) };
    const receiver = { role: m.receiverRole, id: String(m.receiverId), ...normActor(m.receiverRole, receiverDoc) };
    const attendance = attByMeet.get(String(m._id)) || [];

    // compute attended-by flags (0/2)
    const attendedSender = attendance.some(x => x.actorId === sender.id);
    const attendedReceiver = attendance.some(x => x.actorId === receiver.id);

    return {
      meetId: String(m._id),
      subject: m.subject || '',
      when: whenISO,
      hasVLink: !!m.vmeetLink,
      sender,
      receiver,
      attendedCount: (attendedSender ? 1 : 0) + (attendedReceiver ? 1 : 0),
      attendedBy: {
        sender: attendedSender,
        receiver: attendedReceiver
      },
      attendance
    };
  });

  // q filter (subject/participants/email/org)
  if (q) {
    const hits = (blk) => {
      const base = `${blk.subject} ${blk.sender.name} ${blk.sender.org} ${blk.sender.email} ${blk.receiver.name} ${blk.receiver.org} ${blk.receiver.email}`.toLowerCase();
      const att = blk.attendance.map(x => `${x.name} ${x.org} ${x.email}`.toLowerCase()).join(' ');
      return (base + ' ' + att).includes(q);
    };
    data = data.filter(hits);
  }

  res.json({
    ok: true,
    eventId,
    totalMeets: data.length,
    totalAttendance: data.reduce((n, b) => n + b.attendance.length, 0),
    data,
  });
});

// guard re-definition in dev

// Helper: schedule a prompt exactly +60 minutes from a given base time
async function _scheduleFeedback({ eventId, kind, refId, actorId, role, baseTime }) {
  const due = new Date((baseTime ? new Date(baseTime) : new Date()).getTime() + 60 * 60 * 1000);
  try {
    await FeedbackPrompt.updateOne(
      { kind, refId, actorId },
      {
        $setOnInsert: {
          eventId, kind, refId, actorId, role,
          dueAt: due,
          status: 'pending',
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    // ignore duplicate key races
    if (!String(e?.message || '').includes('duplicate key')) throw e;
  }
}

// PUBLIC export to be called from your existing attendance flows:
//
// - When you mark a meeting attendance → call with kind:'meet', refId:meetId
// - When you mark a session attendance → call with kind:'session', refId:sessionId
// - When you check in at event gate → call with kind:'event', refId:eventId
//
const scheduleFeedbackPrompt = async ({ eventId, kind, refId, actorId, role, at }) => {
  if (!eventId || !kind || !refId || !actorId || !role) return;
  await _scheduleFeedback({ eventId, kind, refId, actorId, role, at });
};
exports.scheduleFeedbackPrompt = scheduleFeedbackPrompt;
// Actor: fetch due prompts (now or overdue) that are not completed/expired
exports.actorGetPendingFeedback = asyncHandler(async (req, res) => {
  const meId = req.user?._id;
  const meRole = String(req.user?.role || '').toLowerCase();
  if (!meId) return res.status(401).json({ ok:false, error:'auth-required' });

  const now = new Date();
  const rows = await FeedbackPrompt.find({
    actorId: meId,
    status: { $in: ['pending','shown'] },
    dueAt: { $lte: now }
  })
  .sort({ dueAt: 1, createdAt: 1 })
  .limit(5)
  .lean();

  res.json({
    ok: true,
    count: rows.length,
    data: rows.map(r => ({
      id: String(r._id),
      eventId: String(r.eventId || ''),
      kind: r.kind,
      refId: String(r.refId),
      dueAt: r.dueAt,
      status: r.status,
    }))
  });
});

// Actor: mark prompt as shown (so we don’t flicker it every fetch)
exports.actorMarkFeedbackShown = asyncHandler(async (req, res) => {
  const meId = String(req.user?._id || '');
  const { promptId } = req.body || {};
  if (!mongoose.isValidObjectId(promptId)) return res.status(400).json({ ok:false, error:'bad-promptId' });

  const upd = await FeedbackPrompt.findOneAndUpdate(
    { _id: promptId, actorId: meId, status: { $in: ['pending','shown'] } },
    { $set: { status: 'shown', shownAt: new Date() } },
    { new: true }
  ).lean();

  if (!upd) return res.status(404).json({ ok:false, error:'not-found' });
  res.json({ ok:true });
});

// Actor: submit feedback (stars/comment) → completes the prompt
exports.actorSubmitFeedback = asyncHandler(async (req, res) => {
  const meId = String(req.user?._id || '');
  const meRole = String(req.user?.role || '').toLowerCase();
  const { promptId, stars, comment } = req.body || {};

  if (!mongoose.isValidObjectId(promptId)) return res.status(400).json({ ok:false, error:'bad-promptId' });
  const v = Number(stars);
  if (!(v >= 1 && v <= 5)) return res.status(400).json({ ok:false, error:'stars-must-be-1-5' });

  const prompt = await FeedbackPrompt.findOne({ _id: promptId, actorId: meId }).lean();
  if (!prompt) return res.status(404).json({ ok:false, error:'prompt-not-found' });
  if (prompt.status === 'completed') return res.json({ ok:true, already:true });

  await FeedbackResponse.create({
    promptId: prompt._id,
    eventId : prompt.eventId,
    kind    : prompt.kind,
    refId   : prompt.refId,
    actorId : prompt.actorId,
    role    : prompt.role,
    stars   : v,
    comment : String(comment || '').slice(0, 1000)
  });

  await FeedbackPrompt.updateOne(
    { _id: prompt._id },
    { $set: { status:'completed', completedAt: new Date() } }
  );

  res.json({ ok:true });
});

