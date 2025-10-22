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
const PDFDocument = require('pdfkit');

/* ─────────────────── helper maps ──────────────────── */
const ROLE_MODEL = {
  attendee: attendee,
  exhibitor: Exhibitor,
  speaker: Speaker,
};
function getEmail(doc, role) {
  switch (role) {
    case "attendee":
      return doc.personal.email;
    case "speaker":
      return doc.personal.email;
    case "exhibitor":
      return doc.identity.email;
  }
}
function isOpenToMeetings(doc, role) {
  switch (role) {
    case "attendee":
      return doc.matchingIntent?.openToMeetings ?? false;
    case "speaker":
      return doc.b2bIntent?.openMeetings ?? false;
    case "exhibitor":
      return doc.commercial?.availableMeetings ?? false;
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
  let sh = evS.getUTCHours(),
    sm = evS.getUTCMinutes();
  let eh = evE.getUTCHours(),
    em = evE.getUTCMinutes();

  // Unusable or inverted window? fallback to 10–16
  const unusable =
    eh < sh ||
    (eh === sh && em <= sm) ||
    (sh === 0 && sm === 0 && eh === 0 && em === 0);
  if (unusable) {
    sh = 10;
    sm = 0;
    eh = 16;
    em = 0;
  }

  const start = Date.UTC(y, m - 1, d, sh, sm, 0, 0);
  const end = Date.UTC(y, m - 1, d, eh, em, 0, 0);
  return { dayStartUTC: start, dayEndUTC: end };
}

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === "string" ? v.trim() : "");
const firstText = (...vals) => vals.find((v) => text(v)) || "";

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
    <div style="max-width:640px;margin:12px auto 0;color:#64748b;font-size:12px">This is an automated message from GITS.</div>
  </div>`;
}
exports.requestMeeting = asyncHandler(async (req, res) => {
  // Body expected from your UI:
  // { eventId, receiverId, receiverRole, dateTimeISO, subject, message }
  const senderId = req.user?._id;
  const senderRole = req.user?.role;
  const eventId = req.body?.eventId;
  const receiverId = req.body?.receiverId;
  const receiverRole = req.body?.receiverRole;
  const slotISO = req.body?.dateTimeISO; // 30-min ISO (UTC recommended)
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();

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

  // Prevent duplicate active thread for same pair + event
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
    return res
      .status(409)
      .json({
        message:
          "Active meeting already exists for these participants and event",
      });
  }

  // Read capacity
  let capMax =
    Number(process.env.MEETING_SLOT_CAP) &&
    Number(process.env.MEETING_SLOT_CAP) > 0
      ? Number(process.env.MEETING_SLOT_CAP)
      : 40;
  if (Event) {
    try {
      const ev = await Event.findById(eventId)
        .select("b2bCapacity timezone title name")
        .lean();
      if (Number(ev?.b2bCapacity) > 0) capMax = Number(ev.b2bCapacity);
    } catch {}
  }

  // Check / upsert slot counter (atomic-ish)
  let slotDoc = await MeetingSlot.findOne({ eventId, slotISO }).lean();
  if (!slotDoc) {
    try {
      slotDoc = await MeetingSlot.create({
        eventId,
        slotISO,
        used: 0,
        cap: capMax,
      });
    } catch (e) {
      // race: created by another request; re-read
      slotDoc = await MeetingSlot.findOne({ eventId, slotISO }).lean();
    }
  }

  // If full, block (UI now disables, but race-proof here)
  const used = Number(slotDoc?.used || 0);
  const limit = Number(slotDoc?.cap || capMax);
  if (used >= limit) {
    return res
      .status(409)
      .json({ message: "Slot is full, please choose another time" });
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
  await MeetingSlot.updateOne(
    { eventId, slotISO },
    { $inc: { used: 1 }, $set: { cap: limit || capMax } },
    { upsert: true }
  );

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

  // Sender mail
  const htmlSender = renderEmail({
    title: "Your meeting request was sent",
    intro: `Thanks ${senderDisp.name || ""}! We sent your request to <b>${
      receiverDisp.name || "participant"
    }</b>. You’ll receive an email when they respond.`,
    rows: [
      ...rowsCommon,
      ["To", receiverDisp.name || receiverDisp.email || "—"],
    ],
    ctaHref: `${FRONT}/meetings`,
    ctaLabel: "Open my meetings",
  });

  // Receiver mail
  const htmlReceiver = renderEmail({
    title: "You have a new meeting request",
    intro: `Hello ${
      receiverDisp.name || ""
    }, you received a meeting request from <b>${
      senderDisp.name || "a participant"
    }</b>.`,
    rows: [
      ...rowsCommon,
      ["From", senderDisp.name || senderDisp.email || "—"],
      ["Message", message || "(no message)"],
    ],
    ctaHref: `${FRONT}/meetings`,
    ctaLabel: "Review request",
  });

  const mailErrors = [];
  try {
    if (senderDisp.email)
      await sendMail(senderDisp.email, "GITS · Request sent", htmlSender);
  } catch (e) {
    mailErrors.push("sender");
  }
  try {
    if (receiverDisp.email)
      await sendMail(
        receiverDisp.email,
        "GITS · New meeting request",
        htmlReceiver
      );
  } catch (e) {
    mailErrors.push("receiver");
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
      slotCounter: { used: used + 1, cap: limit }, // post-increment view
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
  const buckets = {
    attendee: new Set(),
    exhibitor: new Set(),
    speaker: new Set(),
  };

  for (const m of rows) {
    const iAmSender = String(m.senderId) === meId;
    const otherRole = iAmSender ? m.receiverRole : m.senderRole;
    const otherId = iAmSender ? m.receiverId : m.senderId;
    if (ROLE_MODEL[otherRole] && mongoose.isValidObjectId(otherId)) {
      buckets[otherRole].add(String(otherId));
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
          ? "identity.logo identity.exhibitorName identity.orgName identity.contactName identity.email"
          : "personal.fullName personal.email personal.profilePic enrichments.profilePic"
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

    return {
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
    'MeetingBlacklist',
    new mongoose.Schema(
      {
        meetingId: { type: mongoose.Schema.Types.ObjectId, index: true, unique: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, index: true },
        actors: [{ type: mongoose.Schema.Types.ObjectId }],
        reason: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
      },
      { collection: 'meeting_blacklist' }
    )
  );

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const asStr = (x) => String(x || '');

function whoAmI(meet, meId) {
  const s = asStr(meet.senderId) === asStr(meId);
  const r = asStr(meet.receiverId) === asStr(meId);
  return { isSender: s, isReceiver: r };
}

function computeAllowedActions(meet, meId, isAdmin = false) {
  if (isAdmin) return ['confirm', 'reject', 'cancel', 'reschedule', 'delete'];
  const st = String(meet.status || '').toLowerCase();
  const { isSender, isReceiver } = whoAmI(meet, meId);
  const proposedBy = asStr(meet.proposedBy || '');

  if (st === 'pending') {
    if (isReceiver) return ['confirm', 'reject', 'reschedule'];
    if (isSender) return ['cancel', 'reschedule'];
    return [];
  }
  if (st === 'rescheduled') {
    if (proposedBy && asStr(proposedBy) === asStr(meId)) return ['cancel', 'reject'];
    return ['confirm', 'reject'];
  }
  if (st === 'confirmed') return ['reschedule', 'cancel'];
  if (st === 'rejected') return isReceiver ? ['delete'] : [];
  if (st === 'cancelled' || st === 'canceled') return [];
  return [];
}

async function lockActors(eventId, slotISO, a, b) {
  console.log('[lockActors] eventId=%s slotISO=%s a=%s b=%s', eventId, slotISO, a, b);
  const docs = [{ eventId, actorId: a, slotISO }, { eventId, actorId: b, slotISO }];
  for (const d of docs) {
    const r = await SlotIndex.updateOne(
      { eventId: d.eventId, actorId: d.actorId, slotISO: d.slotISO },
      { $setOnInsert: d },
      { upsert: true }
    );
    console.log('[lockActors] upsert result=', r);
  }
}

async function unlockActors(eventId, slotISO, a, b) {
  if (!slotISO) return;
  console.log('[unlockActors] eventId=%s slotISO=%s actors=[%s,%s]', eventId, slotISO, a, b);
  const r = await SlotIndex.deleteMany({ eventId, actorId: { $in: [a, b] }, slotISO });
  console.log('[unlockActors] deleteMany result=', r);
}

async function ensureCapDoc(eventId, slotISO) {
  const ev = await Event.findById(eventId).select('b2bCapacity').lean();
  const capDefault = Number(ev?.b2bCapacity) > 0 ? Number(ev.b2bCapacity) : 30;
  const doc = await MeetingSlot.findOneAndUpdate(
    { eventId, slotISO },
    { $setOnInsert: { eventId, slotISO, used: 0, cap: capDefault } },
    { new: true, upsert: true }
  ).lean();
  console.log('[ensureCapDoc] eventId=%s slotISO=%s ->', eventId, slotISO, doc);
  return doc;
}

async function decCapIfExists(eventId, slotISO) {
  if (!slotISO) return;
  const row = await MeetingSlot.findOne({ eventId, slotISO }).lean();
  console.log('[decCapIfExists] pre row=', row);
  if (!row) return;
  const nextUsed = Math.max(0, Number(row.used || 0) - 1);
  const r = await MeetingSlot.updateOne({ eventId, slotISO }, { $set: { used: nextUsed } });
  console.log('[decCapIfExists] set used=%d result=', nextUsed, r);
}

function getMeta(doc, role) {
  const r = (role || '').toLowerCase();
  if (r === 'exhibitor') {
    const out = {
      name: doc?.identity?.exhibitorName || doc?.identity?.orgName || 'Exhibitor',
      email:
        doc?.identity?.email ||
        doc?.identity?.contactEmail ||
        doc?.organization?.email ||
        doc?.personal?.email ||
        '',
      org: doc?.identity?.orgName || doc?.organization?.orgName || '',
    };
    console.log('[getMeta:exhibitor]', out);
    return out;
  }
  const out = {
    name: doc?.personal?.fullName || 'User',
    email: doc?.personal?.email || doc?.personal?.firstEmail || '',
    org: doc?.organization?.orgName || '',
  };
  console.log('[getMeta:%s]', r || 'attendee/speaker', out);
  return out;
}

function fmtLocal(iso, tz) {
  const d = new Date(iso);
  const out = {
    date: d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz || 'UTC' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC' }),
  };
  console.log('[fmtLocal] iso=%s tz=%s =>', iso, tz, out);
  return out;
}

// IMPORTANT: ignore the current meeting when checking busy
async function existsBusyAt(eventId, slotISO, actorIds = [], ignoreMeetId = null) {
  console.log('[existsBusyAt] start', { eventId: String(eventId), slotISO, actorIds, ignoreMeetId: String(ignoreMeetId || '') });

  // Check per-actor locks (confirmed holds)
  const lock = await SlotIndex.findOne({ eventId, actorId: { $in: actorIds }, slotISO }).lean();
  console.log('[existsBusyAt] slot lock found?', !!lock, lock?._id || null);
  if (lock) return true;

  // Check overlapping MeetRequest at the exact slot for either actor,
  // but EXCLUDE the current meeting if provided
  const q = {
    eventId,
    _id: ignoreMeetId ? { $ne: ignoreMeetId } : { $exists: true },
    status: { $in: ['pending', 'rescheduled', 'confirmed'] },
    $and: [
      { $or: [{ senderId: { $in: actorIds } }, { receiverId: { $in: actorIds } }] },
      { $or: [{ requestedAt: new Date(slotISO) }, { proposedNewAt: new Date(slotISO) }, { slotISO: new Date(slotISO) }] },
    ],
  };
  const other = await MeetRequest.findOne(q).select('_id status senderId receiverId slotISO requestedAt proposedNewAt').lean();
  console.log('[existsBusyAt] conflicting request found?', !!other, other || null);
  return !!other;
}

// PDF helpers
function pdfToBuffer(makeDoc) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    makeDoc(doc);
    doc.end();
  });
}

async function buildMeetingPDF({ meet, eventObj, actor, other, qrPngBuffer }) {
  const tz = eventObj?.timezone || 'UTC';
  const when = fmtLocal(meet.slotISO, tz);
  const evTitle = eventObj?.title || eventObj?.name || 'Event';

  return pdfToBuffer((doc) => {
    doc.fontSize(18).text(`${evTitle} — B2B Meeting`, { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#333').text(`Meeting ID: ${String(meet._id)}`);
    doc.text(`Status: ${String(meet.status).toUpperCase()}`);
    doc.text(`Timezone: ${tz}`);
    doc.moveDown();
    doc.fontSize(14).fillColor('#000').text('Details', { underline: true });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor('#333');
    doc.text(`Date: ${when.date}`);
    doc.text(`Time: ${when.time} (${tz})`);
    doc.text(`Subject: ${meet.subject || '—'}`);
    if (meet.message) doc.text(`Message: ${meet.message}`);
    doc.moveDown();
    doc.fontSize(14).fillColor('#000').text('Participants', { underline: true });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor('#333');
    doc.text(`You: ${actor.name}${actor.org ? ` (${actor.org})` : ''}`);
    doc.text(`Partner: ${other.name}${other.org ? ` (${other.org})` : ''}`);
    doc.moveDown(1);
    const imgSize = 220;
    try {
      doc.fontSize(14).fillColor('#000').text('Check-in QR', { underline: true });
      doc.moveDown(0.25);
      doc.image(qrPngBuffer, { fit: [imgSize, imgSize] });
      doc.moveDown(0.5);
      const FRONT = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
      const checkinUrl = `${FRONT || '#'}\/admin/marking?meetId=${meet._id}&actorId=${actor._id}`;
      doc.fontSize(10).fillColor('#333').text(`Scan at the B2B desk or open: ${checkinUrl}`);
    } catch (e) {
      doc.fontSize(10).fillColor('red').text(`QR render failed: ${e?.message || e}`);
    }
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#666').text('Keep this PDF handy. Arrive 5 minutes before your slot. Each attendee has a unique QR.');
  });
}

async function decMeetingSlotUsed(eventId, slotISO) {
  if (!eventId || !slotISO) return;
  console.log('[decMeetingSlotUsed] eventId=%s slotISO=%s', String(eventId), slotISO);
  // Avoid negatives: only decrement when used > 0
  const r = await MeetingSlot.updateOne(
    { eventId, slotISO, used: { $gt: 0 } },
    { $inc: { used: -1 } }
  );
  console.log('[decMeetingSlotUsed] updateOne result=', r);
  if (!r.matchedCount) {
    console.log('[decMeetingSlotUsed] no decrement (missing doc or used==0)');
  }
}


// NOTE: FIXED — use your 5-arg sendMail(to, subject, html, text, attachments)
async function sendConfirmEmailsWithPDF(meet) {
  console.log('[sendConfirmEmailsWithPDF] meetingId=', String(meet._id));
  const [senderDoc, receiverDoc, ev] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
    Event.findById(meet.eventId).select('title name timezone city country venue').lean(),
  ]);
  const s = { ...getMeta(senderDoc, meet.senderRole), _id: meet.senderId };
  const r = { ...getMeta(receiverDoc, meet.receiverRole), _id: meet.receiverId };
  console.log('[sendConfirmEmailsWithPDF] s=', s, 'r=', r, 'ev=', ev);

  const FRONT = (process.env.FRONTEND_URL || '').replace(/\/+$/, '') || '#';
  const tz = ev?.timezone || 'UTC';
  const when = fmtLocal(meet.slotISO, tz);
  const evTitle = ev?.title || ev?.name || 'Event';
  const urlFor = (actorId) => `${FRONT}/admin/marking?meetId=${meet._id}&actorId=${actorId}`;

  const [qrS, qrR] = await Promise.all([
    QRCode.toBuffer(urlFor(meet.senderId), { type: 'png', errorCorrectionLevel: 'M', scale: 8, margin: 1 }),
    QRCode.toBuffer(urlFor(meet.receiverId), { type: 'png', errorCorrectionLevel: 'M', scale: 8, margin: 1 }),
  ]);
  console.log('[sendConfirmEmailsWithPDF] QR generated: s=%d bytes r=%d bytes', qrS.length, qrR.length);

  const [pdfS, pdfR] = await Promise.all([
    buildMeetingPDF({ meet, eventObj: ev, actor: s, other: r, qrPngBuffer: qrS }),
    buildMeetingPDF({ meet, eventObj: ev, actor: r, other: s, qrPngBuffer: qrR }),
  ]);
  console.log('[sendConfirmEmailsWithPDF] PDFs generated: s=%d bytes r=%d bytes', pdfS.length, pdfR.length);

  const htmlBase = (whoName, otherName) => `
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
                  Hi ${whoName || 'there'}, your meeting is set ✅
                </td>
              </tr>
              <tr>
                <td style="padding:0 20px 4px;color:#334155;font:500 14px/1.6 Inter,Segoe UI,Roboto,Arial,sans-serif">
                  You’re meeting with <b>${otherName}</b>.
                </td>
              </tr>
              <tr>
                <td style="padding:12px 20px 0">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
                    <tr>
                      <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">When</td>
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${when.date} — ${when.time} (${tz})</td>
                    </tr>
                    <tr style="background:#fafafa">
                      <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">Subject</td>
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${meet.subject || '—'}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 20px 0;color:#334155;font:500 13px/1.6 Inter">
                  Your <b>PDF ticket</b> with your personal QR code is attached to this email.
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
              This is an automated message from GITS.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;

  // 5-arg signature: to, subject, html, text, attachments[]
  const textSummary = `Your meeting is confirmed. Date: ${when.date} — ${when.time} (${tz}). Subject: ${meet.subject || '—'}. A PDF ticket is attached.`;
  const attS = [{ filename: `Meeting-${String(meet._id)}-YOU.pdf`, content: pdfS, contentType: 'application/pdf' }];
  const attR = [{ filename: `Meeting-${String(meet._id)}-YOU.pdf`, content: pdfR, contentType: 'application/pdf' }];
  console.log('[sendConfirmEmailsWithPDF] attachments lengths:', { sender: attS[0].content.length, receiver: attR[0].content.length });

  const tasks = [];
  if (s.email) {
    console.log('[sendConfirmEmailsWithPDF] sending to sender via 5-arg sendMail:', s.email);
    tasks.push(sendMail(s.email, `${evTitle} · Meeting confirmed`, htmlBase(s.name, r.name), textSummary, attS));
  } else {
    console.warn('[sendConfirmEmailsWithPDF] sender has no email, skipping attachment.');
  }
  if (r.email) {
    console.log('[sendConfirmEmailsWithPDF] sending to receiver via 5-arg sendMail:', r.email);
    tasks.push(sendMail(r.email, `${evTitle} · Meeting confirmed`, htmlBase(r.name, s.name), textSummary, attR));
  } else {
    console.warn('[sendConfirmEmailsWithPDF] receiver has no email, skipping attachment.');
  }
  await Promise.all(tasks);
  console.log('[sendConfirmEmailsWithPDF] done (with PDF attachments).');
}

async function sendActionEmail(meet, type) {
  console.log('[sendActionEmail] meetingId=%s type=%s', String(meet._id), type);
  const [senderDoc, receiverDoc, ev] = await Promise.all([
    ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
    ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
    Event.findById(meet.eventId).select('title name timezone').lean(),
  ]);
  const s = { ...getMeta(senderDoc, meet.senderRole), _id: meet.senderId };
  const r = { ...getMeta(receiverDoc, meet.receiverRole), _id: meet.receiverId };
  const FRONT = (process.env.FRONTEND_URL || '').replace(/\/+$/, '') || '#';
  const tz = ev?.timezone || 'UTC';
  const when = fmtLocal(meet.slotISO || meet.proposedNewAt || meet.requestedAt, tz);
  const evTitle = ev?.title || ev?.name || 'Event';

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
      intro: `${(meet.proposedBy && asStr(meet.proposedBy) === asStr(s._id)) ? s.name : r.name} proposed a new time.`,
    },
  };
  const t = types[type];
  if (!t) { console.log('[sendActionEmail] unknown type -> skip'); return; }

  const html = `
    <div style="background:#f6f7f9;padding:24px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;border-collapse:separate;border-spacing:0">
        <tr>
          <td style="padding:0">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
              <tr>
                <td style="padding:18px 20px;background:#0ea5e9;color:#fff;font:700 18px/1.2 Inter,Segoe UI,Roboto,Arial,sans-serif">
                  ${t.subj.replace(`${evTitle} · `, '')}
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
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${meet.subject || '—'}</td>
                    </tr>
                    <tr style="background:#fafafa">
                      <td style="padding:10px 12px;width:140px;color:#64748b;font:600 12px Inter">When</td>
                      <td style="padding:10px 12px;color:#0f172a;font:700 13px Inter">${when.date} — ${when.time} (${tz})</td>
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
              This is an automated message from GITS.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;

  const tasks = [];
  if (s.email) { console.log('[sendActionEmail] -> sender', s.email); tasks.push(sendMail(s.email, t.subj, html)); }
  if (r.email) { console.log('[sendActionEmail] -> receiver', r.email); tasks.push(sendMail(r.email, t.subj, html)); }
  await Promise.all(tasks);
  console.log('[sendActionEmail] done.');
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────
exports.makeMeetingAction = asyncHandler(async (req, res) => {
  console.log('================ [makeMeetingAction] START ================');
  console.log('[makeMeetingAction:req.body]=', req.body);

  const slotKeyT = (dt) => {
    const d = new Date(dt);
    d.setSeconds(0, 0);
    const iso = d.toISOString();
    console.log('[slotKeyT] in=%s out=%s', dt, iso);
    return iso;
  };

  const { meetingId, action, actorId, proposedNewAt } = req.body || {};
  if (!mongoose.isValidObjectId(meetingId)) {
    console.error('[makeMeetingAction] Bad meetingId', meetingId);
    return res.status(400).json({ message: 'Bad meetingId' });
  }

  const meId = String(req.user._id);
  const meRole = String(req.user.role || '').toLowerCase();
  const meIsAdmin = meRole === 'admin';
  if (!meIsAdmin && actorId && String(actorId) !== meId) {
    console.error('[makeMeetingAction] Forbidden actorId mismatch', { actorId, meId });
    return res.status(403).json({ message: 'Forbidden' });
  }

  const meet = await MeetRequest.findById(meetingId).lean();
  console.log('[makeMeetingAction:meet]=', meet && { _id: String(meet._id), status: meet.status, senderId: String(meet.senderId), receiverId: String(meet.receiverId), eventId: String(meet.eventId), slotISO: meet.slotISO, requestedAt: meet.requestedAt, proposedNewAt: meet.proposedNewAt });
  if (!meet) return res.status(404).json({ message: 'Meeting not found' });

  const { isSender, isReceiver } = whoAmI(meet, meId);
  console.log('[makeMeetingAction:whoAmI]=', { isSender, isReceiver, meIsAdmin });
  if (!isSender && !isReceiver && !meIsAdmin) return res.status(403).json({ message: 'Forbidden' });

  const prevStatus = String(meet.status || '').toLowerCase();
  const act = String(action || '').toLowerCase();
  console.log('[makeMeetingAction:state]=', { prevStatus, act });

  const allowed = computeAllowedActions(meet, meId, meIsAdmin);
  console.log('[makeMeetingAction:allowed]=', allowed);
  if (!allowed.includes(act)) {
    console.warn('[makeMeetingAction] Action not allowed for this user/state');
    return res.status(400).json({ message: 'Action not allowed for this user/state' });
  }

  const now = new Date();
  const $set = { updatedAt: now };
  const $unset = {};
  let finalISO = null;

  // CONFIRM
  if (act === 'confirm') {
    finalISO =
      prevStatus === 'rescheduled' && meet.proposedNewAt
        ? slotKeyT(meet.proposedNewAt)
        : slotKeyT(meet.slotISO || meet.requestedAt);
    console.log('[confirm] finalISO=', finalISO);

    if (!finalISO) {
      console.error('[confirm] No slot to confirm');
      return res.status(400).json({ message: 'No slot to confirm' });
    }

    const actorIds = [meet.senderId, meet.receiverId].map(String);
    const busy = await existsBusyAt(meet.eventId, finalISO, actorIds, meet._id);
    console.log('[confirm] existsBusyAt (ignoring self)=', busy);
    if (busy) {
      console.warn('[confirm] Busy conflict detected (not self)');
      return res.status(409).json({ message: 'One of the participants is busy at that time' });
    }

    await ensureCapDoc(meet.eventId, finalISO);

    $set.status = 'confirmed';
    $set.acceptedAt = now;
    $set.slotISO = new Date(finalISO);
    $unset.proposedNewAt = 1;
    $unset.proposedBy = 1;

    await lockActors(meet.eventId, finalISO, meet.senderId, meet.receiverId);
  }

  // REJECT
  if (act === 'reject') {
    $set.status = 'rejected';
    $set.rejectedAt = now;
    $set.rejectedBy = req.user._id;
    const slotToRelease = meet?.slotISO ? slotKeyT(meet?.slotISO) : null;
    console.log('[reject] slotToRelease=', slotToRelease);
    if (slotToRelease) {
      await decMeetingSlotUsed(meet?.eventId, slotToRelease);
    } else {
      console.log('[reject] no slotISO on meeting; nothing to decrement');
    }
  }

  // CANCEL
  if (act === 'cancel') {
    $set.status = 'cancelled';
    $set.cancelledAt = now;
    $set.cancelledBy = req.user._id;

    const slotsToUnlock = [
      meet.slotISO ? slotKeyT(meet.slotISO) : null,
      meet.requestedAt ? slotKeyT(meet.requestedAt) : null,
      meet.proposedNewAt ? slotKeyT(meet.proposedNewAt) : null,
    ].filter(Boolean);
    console.log('[cancel] slotsToUnlock=', slotsToUnlock);
    for (const iso of Array.from(new Set(slotsToUnlock))) {
      await unlockActors(meet.eventId, iso, meet.senderId, meet.receiverId);
      if (iso === slotKeyT(meet.slotISO)) {
        await decMeetingSlotUsed(meet.eventId, iso);
      }
    }

    if (prevStatus === 'confirmed') {
      const r = await MeetingBlacklist.updateOne(
        { meetingId: meet._id },
        {
          $setOnInsert: {
            meetingId: meet._id,
            eventId: meet.eventId,
            actors: [meet.senderId, meet.receiverId],
            reason: 'cancelled-after-confirmation',
            createdAt: now,
          },
        },
        { upsert: true }
      );
      console.log('[cancel] blacklisted (after confirmation) ->', r);
    }
  }

  // RESCHEDULE (propose)
  if (act === 'reschedule') {
    const t = new Date(proposedNewAt);
    console.log('[reschedule] proposedNewAt=', proposedNewAt, 'parsed=', t);
    if (!proposedNewAt || isNaN(t.getTime())) {
      console.error('[reschedule] invalid proposedNewAt');
      return res.status(400).json({ message: 'proposedNewAt must be a valid ISO datetime' });
    }
    const iso = slotKeyT(t);
    const actorIds = [meet.senderId, meet.receiverId].map(String);
    const busy = await existsBusyAt(meet.eventId, iso, actorIds, meet._id);
    console.log('[reschedule] existsBusyAt (ignoring self)=', busy);
    if (busy) return res.status(409).json({ message: 'One of the participants is busy at the proposed time' });

    await ensureCapDoc(meet.eventId, iso);

    $set.status = 'rescheduled';
    $set.proposedNewAt = new Date(iso);
    $set.proposedBy = req.user._id;
  }

  // DELETE
  if (act === 'delete') {
    const { isReceiver } = whoAmI(meet, meId);
    if (!(prevStatus === 'rejected' && isReceiver) && !meIsAdmin) {
      console.warn('[delete] not allowed (only receiver on rejected or admin)');
      return res.status(400).json({ message: 'Delete allowed only to receiver when status is rejected' });
    }

    const slotsToUnlock = [
      meet.slotISO ? slotKeyT(meet.slotISO) : null,
      meet.requestedAt ? slotKeyT(meet.requestedAt) : null,
      meet.proposedNewAt ? slotKeyT(meet.proposedNewAt) : null,
    ].filter(Boolean);
    console.log('[delete] slotsToUnlock=', slotsToUnlock);
    for (const iso of Array.from(new Set(slotsToUnlock))) {
      await unlockActors(meet.eventId, iso, meet.senderId, meet.receiverId);
    }

    const rBL = await MeetingBlacklist.updateOne(
      { meetingId: meet._id },
      {
        $setOnInsert: {
          meetingId: meet._id,
          eventId: meet.eventId,
          actors: [meet.senderId, meet.receiverId],
          reason: 'deleted',
          createdAt: now,
        },
      },
      { upsert: true }
    );
    console.log('[delete] blacklisted ->', rBL);

    const rDel = await MeetRequest.deleteOne({ _id: meet._id });
    console.log('[delete] deleted ->', rDel);
    console.log('================ [makeMeetingAction] END (delete) ================');
    return res.json({ success: true, message: 'Deleted' });
  }

  // Apply update
  console.log('[update] $set=', $set, '$unset=', $unset);
  const rUpd = await MeetRequest.updateOne({ _id: meetingId }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
  console.log('[update] updateOne result=', rUpd);

  const updated = await MeetRequest.findById(meetingId).lean();
  console.log('[updated]=', updated && { _id: String(updated._id), status: updated.status, slotISO: updated.slotISO, proposedNewAt: updated.proposedNewAt });

  // Emails
  try {
    if (act === 'confirm') {
      await sendConfirmEmailsWithPDF(updated); // <-- now sends with PDF via your 5-arg sendMail
    } else if (act === 'reject') {
      await sendActionEmail(updated, 'rejected');
    } else if (act === 'reschedule') {
      await sendActionEmail(updated, 'rescheduled');
    } else if (act === 'cancel') {
      await sendActionEmail(updated, 'cancelled');
    }
  } catch (e) {
    console.error('[emails] error:', e?.message || e);
  }

  const allowedAfter = computeAllowedActions(updated, meId, meIsAdmin);
  console.log('[allowedAfter]=', allowedAfter);

  console.log('================ [makeMeetingAction] END (ok) ================');
  return res.json({ success: true, message: 'OK', data: { ...updated, allowedActions: allowedAfter } });
});





// GET /meets/suggested?actorId=...&eventId=...&limit=20&pool=50&search=...&role=attendee|exhibitor|speaker&lang=en&country=TN&open=1
exports.getSuggestedList = asyncHandler(async (req, res) => {
  const meId = req.user?._id || req.query.actorId;
  if (!mongoose.isValidObjectId(meId)) {
    return res.status(400).json({ message: "Bad actorId" });
  }

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
    const lxo = meV.looking.filter((t) => otherV.offering.includes(t)).length;
    s += lxo * 5;
    const oxl = meV.offering.filter((t) => otherV.looking.includes(t)).length;
    s += oxl * 4;
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
      // attendee
      "personal.fullName": 1,
      "personal.profilePic": 1,
      "personal.email": 1,
      "personal.country": 1,
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
      id_event: 1,
    };

    return { Model, q, proj };
  };

  const candidates = [];
  for (const r of roleOrder) {
    const { Model, q, proj } = baseFindFor(r);
    if (!Model) continue;
    const rows = await Model.find(q, proj).limit(400).lean(); // hard cap per role
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

    const semantic = scorePair(meV, vec); // 0..~

    // trust / completeness / recency
    const hasPhoto =
      !!disp.photo && !DEFAULT_PHOTO_RX.test(String(disp.photo || ""));
    const verifiedBoost =
      (doc.verified ? 1 : 0) +
      (doc.adminVerified === "yes" || doc.adminVerified === true ? 0.5 : 0);
    const completeness =
      // 0..1 roughly: count filled buckets
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
      0.5 + 0.5 * Math.exp(-(now - updated) / (1000 * 60 * 60 * 24 * 60)); // ~60d half-life

    // combine:
    let score =
      semantic * 1.0 + verifiedBoost * 2.0 + completeness * 3.0 + recency * 1.0;

    // Photo weighting: penalize default; slight bonus for real photo
    score *= hasPhoto ? 1.05 : 0.72;

    // tiny jitter so equal scores shuffle
    score *= 0.97 + Math.random() * 0.06; // 0.97..1.03

    // tag guess
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
      matchPct: Math.round(Math.max(0, Math.min(100, score))), // clamp to 0..100
      _score: Math.max(1e-6, score),
    };
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
    matchPct: p.matchPct,
  }));

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
// Query: ?actorId=<receiverId>&date=YYYY-MM-DD// GET /events/:eventId/available-slots?actorId=<receiverId>&date=YYYY-MM-DD
// GET /events/:eventId/available-slots?actorId=<receiverId>&date=YYYY-MM-DD
exports.listAvailableSlots = asyncHandler(async (req, res) => {
  const { eventId } = req.params || {};
  const dateParam = req.query?.date || req.params?.date; // YYYY-MM-DD
  const receiverId = req.query?.actorId || req.query?.receiverId;
  console.log(
    "eventId",
    eventId,
    "\n receiverId",
    receiverId,
    "\n dateParam",
    dateParam
  );

  if (!mongoose.isValidObjectId(eventId)) {
    return res.status(400).json({ message: "Bad eventId" });
  }
  if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
    return res
      .status(400)
      .json({
        message: "actorId (receiver) is required and must be an ObjectId",
      });
  }
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateParam))) {
    return res
      .status(400)
      .json({ message: "date is required as YYYY-MM-DD (UTC day)" });
  }

  const senderId = req.user?._id;
  if (!senderId) return res.status(401).json({ message: "Unauthorized" });
  console.log("senderId :", senderId);

  // Optional: read event capacity
  let capDefault = 30;
  if (Event) {
    try {
      const ev = await Event.findById(eventId).select("b2bCapacity").lean();
      if (Number(ev?.b2bCapacity) > 0) capDefault = Number(ev.b2bCapacity);
    } catch {
      /* ignore */
    }
  }
  console.log("capDefault", capDefault);

  if (!Schedule) {
    return res
      .status(500)
      .json({ message: "Schedule model not found on server" });
  }

  // Day bounds in UTC
  const dayStart = new Date(`${dateParam}T00:00:00.000Z`);
  const dayEndEx = new Date(`${dateParam}T24:00:00.000Z`); // exclusive
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEndEx.getTime();
  const STEP = 30 * 60 * 1000;

  // 1) Load ALL B2B sessions overlapping that UTC day
  const b2bRx = /b2b/i;
  const sessions = await Schedule.find({
    $and: [
      { $or: [{ id_event: eventId }, { eventId }] },
      { track: { $regex: b2bRx } },
      {
        $or: [
          // Support startTime/endTime (your log shows those)
          {
            $and: [
              { startTime: { $lt: dayEndEx } },
              { endTime: { $gt: dayStart } },
            ],
          },
          // Also support startAt/endAt or start/end if present
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

  console.log("sessions found:", Array.isArray(sessions) ? sessions.length : 0);
  if (!sessions || sessions.length === 0) {
    return res.json({ success: true, count: 0, data: [], tz: "UTC" });
  }

  // 2) Build 30-min grid inside each session and union them
  const slotSet = new Set();
  for (const s of sessions) {
    const S = pickTime(s, "startTime", "startAt", "start");
    const E = pickTime(s, "endTime", "endAt", "end");
    if (!S || !E) continue;

    // Intersect with requested day
    const segStart = Math.max(S.getTime(), dayStartMs);
    const segEnd = Math.min(E.getTime(), dayEndMs);
    if (segEnd - segStart < STEP) continue;

    // Round up segStart to 30min grid
    let t = Math.ceil(segStart / STEP) * STEP;
    for (; t < segEnd; t += STEP) {
      slotSet.add(new Date(t).toISOString());
    }
  }

  console.log("raw slots in B2B sessions:", slotSet.size);
  if (!slotSet.size) {
    return res.json({ success: true, count: 0, data: [], tz: "UTC" });
  }

  // 3) Busy set for BOTH participants:
  const dayStartISO = dayStart.toISOString();
  const dayEndISO = dayEndEx.toISOString();

  const [locks, requests] = await Promise.all([
    // Accepted/confirmed locks
    SlotIndex.find({
      eventId,
      actorId: { $in: [senderId, receiverId] },
      slotISO: { $gte: dayStartISO, $lt: dayEndISO },
    })
      .select("slotISO")
      .lean(),

    // Requests occupying that day (either participant)
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
    ...locks.map((b) => new Date(b.slotISO).toISOString()),
    ...requests.flatMap((r) => {
      const out = [];
      if (r.requestedAt) out.push(new Date(r.requestedAt).toISOString());
      if (r.proposedNewAt) out.push(new Date(r.proposedNewAt).toISOString());
      return out;
    }),
  ]);
  console.log("busy slots for sender/receiver:", busy.size);

  // 4) Filter out busy slots
  const grid = Array.from(slotSet).filter((iso) => !busy.has(iso));
  console.log("free slots after busy filtering:", grid.length);

  if (!grid.length) {
    return res.json({ success: true, count: 0, data: [], tz: "UTC" });
  }

  // 5) Attach capacity from MeetingSlot (if the model exists)
  let countMap = new Map();
  if (MeetingSlot) {
    try {
      const msRows = await MeetingSlot.find({
        eventId,
        slotISO: { $in: grid.map((iso) => new Date(iso)) },
      })
        .select("slotISO used cap")
        .lean();

      countMap = new Map(
        msRows.map((r) => [
          new Date(r.slotISO).toISOString(),
          { used: Number(r.used || 0), cap: Number(r.cap || capDefault) },
        ])
      );
    } catch (e) {
      console.warn("[listAvailableSlots] MeetingSlot read failed:", e?.message);
    }
  }

  const data = grid.sort().map((iso) => {
    const info = countMap.get(iso);
    const used = info?.used ?? 0;
    const cap = info?.cap ?? capDefault;
    const isCap = used < cap && used < 30; // enforce your 30 hard ceiling
    return { iso, used, cap, isCap };
  });

  return res.json({ success: true, count: data.length, data, tz: "UTC" });
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
exports.initMeetingReminderEngine = (app) => {
  if (agenda) return; // avoid double-init in dev hot-reload
  agenda = new Agenda({
    db: {
      address: process.env.REMINDER_DB_URI,
      collection: "agendaJobs",
    },
  });

  /* define once */
  agenda.define(JOB_NAME, async (job) => {
    const { meetingId } = job.attrs.data;
    const meet = await MeetRequest.findById(meetingId).lean();
    if (!meet || meet.status !== "accepted") return job.remove(); // no longer valid

    const event = await Event.findById(meet.eventId).lean();
    if (!event) return job.remove();

    const [sDoc, rDoc] = await Promise.all([
      ROLE_MODEL[meet.senderRole].findById(meet.senderId).lean(),
      ROLE_MODEL[meet.receiverRole].findById(meet.receiverId).lean(),
    ]);
    const emailOf = (doc, role) =>
      role === "exhibitor" ? doc.identity.email : doc.personal.email;

    await Promise.all([
      sendMail(
        emailOf(sDoc, meet.senderRole),
        `Reminder: your meeting in 1 hour`,
        `<p>This is a reminder: <strong>${meet.subject}</strong><br/>
         Time: ${new Date(meet.requestedAt).toUTCString()}</p>`
      ),
      sendMail(
        emailOf(rDoc, meet.receiverRole),
        `Reminder: your meeting in 1 hour`,
        `<p>This is a reminder for your meeting with
         ${sDoc.personal?.fullName || sDoc.identity?.exhibitorName}.<br/>
         Time: ${new Date(meet.requestedAt).toUTCString()}</p>`
      ),
    ]);
  });

  agenda.on("ready", () => agenda.start());
  app.locals.agenda = agenda;
};

/* ────────────────── helper to schedule one reminder ──────────────── */
exports.scheduleMeetingReminder = async (meetDoc) => {
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
