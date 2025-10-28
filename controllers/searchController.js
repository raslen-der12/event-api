// controllers/searchController.js
const Exhibitor = require("../models/exhibitor");
const Attendee  = require("../models/attendee");
const Speaker   = require("../models/speaker");
const Event     = require("../models/event");
const Schedule  = require("../models/eventModels/schedule");
const SearchClick = require("../models/searchClick"); // optional analytics (safe to remove)

const toStr = (v) => (v == null ? "" : String(v));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* ------------------------------------------------------------------ *
 * Link generator
 *  - All “actor-ish” entities → /profile/:ActorId   ✅
 *  - Sessions/events keep existing site routes
 * ------------------------------------------------------------------ */
// FULL REPLACEMENT
function linkFor(doc = {}, type = "") {
  const id   = String(doc._id || doc.id || "").trim();
  const evId = String(doc.id_event || doc.eventId || doc.event || "").trim();
  const t    = String(type || "").toLowerCase();

  const R = {
    event:     (x) => x ? `/event/${x}` : `/events`,
    speakers:  (e) => e ? `/event/${e}/speakers`   : `/event/68e6764bb4f9b08db3ccec04/speakers`,
    exhibitors:(e) => e ? `/event/${e}/exhibitors` : `/event/68e6764bb4f9b08db3ccec04/exhibitors`,
    attendees: (e) => e ? `/event/${e}/attendees`  : `/event/68e6764bb4f9b08db3ccec04/attendees`,
    schedule:  (e) => e ? `/event/${e}/schedule`   : `/event/68e6764bb4f9b08db3ccec04/schedule`,
    session:   (e, s) => (e ? `/event/${e}/schedule` : `/event/68e6764bb4f9b08db3ccec04/schedule`) + (s ? `#session-${s}` : ""),
    track:     (e, trk) =>
      (e ? `/event/${e}/schedule` : `/schedule`) + (trk ? `?track=${encodeURIComponent(trk)}` : ""),
    byCity:    (c) => `/events?city=${encodeURIComponent(c || "")}`,
    byCountry: (c) => `/events?country=${encodeURIComponent(c || "")}`,
    tag:       (tg)=> `/tags/${encodeURIComponent(tg || "")}`,
  };

  switch (t) {
    case "speaker":   return R.speakers(evId);
    case "exhibitor": return R.exhibitors(evId);
    case "attendee":  return R.attendees(evId);

    // "Program" search intent → schedule page
    case "Program":   return R.schedule(evId);

    // Individual session result → schedule with anchor
    case "session":   return R.session(evId, id);

    case "track": {
      const track = doc.track || doc._id || "";
      return R.track(evId, track);
    }

    case "event":     return R.event(id);
    case "city":      return R.byCity(doc.city || doc._id || "");
    case "country":   return R.byCountry(doc.country || doc._id || "");
    case "tag":       return R.tag(doc.tag || doc._id || "");

    default:          return R.event(evId) || "/events";
  }
}


/* ------------------------- helpers ------------------------- */
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function makeRx(q) {
  const safe = escapeRegExp(q.trim());
  // split on spaces, OR them together, case-insensitive
  return new RegExp(safe.split(/\s+/).join("|"), "i");
}

/* =====================================================================
   GET /api/search/quick?q=&limit=4
   → [{ _id, type, title, tag, href, score }]
===================================================================== */
exports.quick = async (req, res) => {
  const q = toStr(req.query.q).trim();
  console.log(q);
  const limit = clamp(parseInt(req.query.limit, 10) || 4, 1, 8);
  if (!q || q.length < 2) return res.json([]);

  const rx = makeRx(q);

  const [exhibitors, attendees, speakers, events, sessions, tracks, cities, countries] = await Promise.all([
    // Exhibitors by brand/org/industry
    Exhibitor.find({
      $or: [
        { "identity.exhibitorName": rx },
        { "identity.orgName": rx },
        { "business.industry": rx },
      ],
    })
      .select({ _id: 1, "identity.exhibitorName": 1, "identity.orgName": 1, "business.industry": 1 })
      .limit(10)
      .lean(),

    // Attendees (optional for directory search; remove if not needed)
    Attendee.find({
      $or: [
        { "personal.fullName": rx },
        { "organization.orgName": rx },
        { "organization.jobTitle": rx },
      ],
    })
      .select({ _id: 1, "personal.fullName": 1, "organization.orgName": 1, "organization.jobTitle": 1 })
      .limit(8)
      .lean(),

    // Speakers
    Speaker.find({
      $or: [
        { "personal.fullName": rx },
        { "organization.jobTitle": rx },
      ],
    })
      .select({ _id: 1, "personal.fullName": 1, "organization.jobTitle": 1 })
      .limit(8)
      .lean(),

    // Events
    Event.find({
      $or: [
        { title: rx },
        { city: rx },
        { country: rx },
      ],
    })
      .select({ _id: 1, title: 1, city: 1, country: 1 })
      .limit(8)
      .lean(),

    // Sessions (program)
    Schedule.find({
      $or: [
        { sessionTitle: rx },
        { track: rx },
      ],
    })
      .select({ _id: 1, sessionTitle: 1, track: 1, id_event: 1, startTime: 1 })
      .limit(8)
      .lean(),

    // Distinct tracks
    Schedule.aggregate([
      { $match: { track: rx } },
      { $group: { _id: "$track" } },
      { $limit: 5 },
    ]),

    // Distinct cities
    Event.aggregate([
      { $match: { city: rx } },
      { $group: { _id: "$city" } },
      { $limit: 5 },
    ]),

    // Distinct countries
    Event.aggregate([
      { $match: { country: rx } },
      { $group: { _id: "$country" } },
      { $limit: 5 },
    ]),
  ]);

  const out = [];
  if (q === "Program") {
    out.push({
      _id: d._id,
      type: "Program",
      title: "Program",
      href: linkFor(d, "Program"),
      score: 12,
    });
  }

  exhibitors.forEach((d) => {
    const title = d.identity?.exhibitorName || d.identity?.orgName || "Exhibitor";
    out.push({
      _id: d._id,
      type: "exhibitor",
      title,
      tag: d.business?.industry || "",
      href: linkFor(d, "exhibitor"),
      score: 12,
    });
  });

  attendees.forEach((d) => {
    const title = d.personal?.fullName || "Attendee";
    const org = d.organization?.orgName ? ` • ${d.organization.orgName}` : "";
    out.push({
      _id: d._id,
      type: "attendee",
      title,
      tag: (d.organization?.jobTitle || "") + org,
      href: linkFor(d, "attendee"),
      score: 9,
    });
  });

  speakers.forEach((d) => {
    const title = d.personal?.fullName || "Speaker";
    out.push({
      _id: d._id,
      type: "speaker",
      title,
      tag: d.organization?.jobTitle || "",
      href: linkFor(d, "speaker"),
      score: 10,
    });
  });

  events.forEach((d) => {
    out.push({
      _id: d._id,
      type: "event",
      title: d.title || "Event",
      tag: [d.city, d.country].filter(Boolean).join(" • "),
      href: linkFor(d, "event"),
      score: 9,
    });
  });

  sessions.forEach((d) => {
    out.push({
      _id: d._id,
      type: "session",
      title: d.sessionTitle || "Session",
      tag: d.track || "",
      href: linkFor(d, "session"),
      score: 8,
      id_event: d.id_event,
    });
  });

  tracks.forEach((t) => {
    const track = t?._id || "";
    if (!track) return;
    out.push({
      _id: track,
      type: "track",
      title: track,
      tag: "Track",
      href: linkFor({ track }, "track"),
      score: 7,
    });
  });

  cities.forEach((c) => {
    const city = c?._id || "";
    if (!city) return;
    out.push({
      _id: city,
      type: "city",
      title: city,
      tag: "City",
      href: linkFor({ city }, "city"),
      score: 6,
    });
  });

  countries.forEach((c) => {
    const country = c?._id || "";
    if (!country) return;
    out.push({
      _id: country,
      type: "country",
      title: country,
      tag: "Country",
      href: linkFor({ country }, "country"),
      score: 6,
    });
  });

  // sort & dedupe
  const uniq = new Set();
  const result = out
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      const k = `${x.type}|${x.title}|${x.href}`;
      if (uniq.has(k)) return false;
      uniq.add(k);
      return true;
    })
    .slice(0, limit);

  res.json(result);
};

/* =====================================================================
   GET /api/search/tags
   → { tags: [ ... ] }
   (frontend caps to 4; this endpoint returns a bigger pool)
===================================================================== */
exports.tags = async (req, res) => {
  const [tracks, industries, cities] = await Promise.all([
    Schedule.aggregate([
      { $match: { track: { $type: "string", $ne: "" } } },
      { $group: { _id: "$track", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]),
    Exhibitor.aggregate([
      { $match: { "business.industry": { $type: "string", $ne: "" } } },
      { $group: { _id: "$business.industry", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]),
    Event.aggregate([
      { $match: { city: { $type: "string", $ne: "" } } },
      { $group: { _id: "$city", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]),
  ]);

  const bag = new Set();
  tracks.forEach((t) => bag.add(String(t._id).trim()));
  industries.forEach((i) => bag.add(String(i._id).trim()));
  cities.forEach((c) => bag.add(String(c._id).trim()));

  const list = Array.from(bag).filter(Boolean);
  if (!list.length) {
    return res.json({ tags: ["AI", "FinTech", "Logistics", "CleanTech"] });
  }
  res.json({ tags: list });
};

/* =====================================================================
   POST /api/search/click  – tiny analytics (optional)
===================================================================== */
exports.click = async (req, res) => {
  const { id, type } = req.body || {};
  if (!id || !type) return res.status(400).json({ message: "id and type required" });

  try {
    await SearchClick.create({
      idValue: String(id),
      type: String(type),
      ts: new Date(),
      ua: toStr(req.headers["user-agent"]),
      ip: req.ip,
    });
  } catch (_) {}

  res.json({ ok: true });
};
async function findActorById(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  // Try known role collections; extend as needed
  const [a, e, s] = await Promise.allSettled([
    Attendee?.findById(id).select("_id").lean(),
    Exhibitor?.findById(id).select("_id").lean(),
    Speaker?.findById(id).select("_id").lean(),
  ]);

  const val = (r) => (r?.status === "fulfilled" ? r.value : null);
  return val(a) || val(e) || val(s) || null;
}

/**
 * GET /api/share/:actorId/:eventId
 * Validates the link and returns canonical redirection target.
 * No new model is required.
 */
exports.resolveShareLink = async (req, res) => {
  try {
    const { actorId, eventId } = req.params || {};

    if (!mongoose.isValidObjectId(actorId)) {
      return res.status(400).json({ message: "Bad actorId" });
    }
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "Bad eventId" });
    }

    const [actor, ev] = await Promise.all([
      findActorById(actorId),
      Event.findById(eventId).select("_id title name").lean(),
    ]);

    if (!ev) {
      return res.status(404).json({ message: "Event not found" });
    }
    if (!actor) {
      // We still return the event to allow redirect, but signal missing actor
      return res.status(404).json({ message: "Actor not found for this link" });
    }

    // OK -> frontend will redirect to /event/:eventId
    return res.json({
      success: true,
      data: {
        eventId: String(ev._id),
        actorId: String(actorId),
        eventTitle: ev.title || ev.name || "Event",
      },
    });
  } catch (e) {
    console.error("[resolveShareLink] error:", e?.message || e);
    return res.status(500).json({ message: "Internal error" });
  }
};