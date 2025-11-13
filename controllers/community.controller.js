// controllers/community.controller.js
const mongoose = require("mongoose");
const Event = require("../models/event");                // adjust path if different
const attendee = require("../models/attendee");          // you shared attendee.js
const speaker  = require("../models/speaker");           // you shared speaker.js

const isId = (v) => mongoose.isValidObjectId(v);
const toNum = (v,d=0)=> (Number.isFinite(+v)?+v:d);
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const rxEq = v => new RegExp(`^${esc(String(v))}$`, "i");
const rxEqTrim = v => new RegExp(`^\\s*${esc(String(v))}\\s*$`, "i");
const str = v => (typeof v === "string" ? v : "");

const normAvatar = (a)=>!a?null:(typeof a==="string"?a:(a.url||a.path||a.secure_url||a.src||null));
const upper = (s)=>String(s||"").toUpperCase();

function mapAtt(d){
  return {
    id: String(d._id),
    kind: "attendee",
    subRoles: Array.isArray(d.subRole) ? d.subRole : [],
    fullName: d?.personal?.fullName || "",
    country: upper(d?.personal?.country || ""),
    orgName: d?.organization?.orgName || "",
    avatar: normAvatar(d?.personal?.profilePic),
  };
}
function mapSpk(d){
  const full = d?.personal?.fullName || d?.identity?.fullName || "";
  const email= d?.personal?.email || d?.identity?.email || "";
  const org  = d?.organization?.orgName || "";
  const avatar = normAvatar(d?.personal?.profilePic || d?.identity?.avatar);
  return {
    id: String(d._id),
    kind: "speaker",
    subRoles: Array.isArray(d.subRole) ? d.subRole : [],
    fullName: full || email,
    country: upper(d?.personal?.country || d?.identity?.country || ""),
    orgName: org,
    avatar,
  };
}

/* ---------- FACETS: events + subRole counts + countries ---------- */
exports.getCommunityFacets = async (req, res, next) => {
  try{
    // events (pick first as default)
    const events = await Event.find({})
      .select("_id title startDate")
      .sort({ startDate: -1 })
      .lean();

    const eventId = str(req.query.eventId) || (events[0]? String(events[0]._id) : "");

    // subRole counts for this event
    const subRoleAgg = async (Model, idField="id_event") => {
      if (!Model) return [];
      const rows = await Model.aggregate([
        { $match: { [idField]: isId(eventId) ? new mongoose.Types.ObjectId(eventId) : null } },
        { $unwind: { path:"$subRole", preserveNullAndEmptyArrays:true } },
        { $group: { _id: "$subRole", c: { $sum: 1 } } },
      ]);
      return rows;
    };
    const countryAgg = async (Model, idField="id_event", path="personal.country") => {
      if (!Model) return [];
      const rows = await Model.aggregate([
        { $match: { [idField]: isId(eventId) ? new mongoose.Types.ObjectId(eventId) : null } },
        { $group: { _id: `$${path}`, c: { $sum: 1 } } },
      ]);
      return rows;
    };

    const [attSR, spkSR, attC, spkC] = await Promise.all([
      attendee ? subRoleAgg(attendee) : [],
      speaker  ? subRoleAgg(speaker)  : [],
      attendee ? countryAgg(attendee) : [],
      speaker  ? countryAgg(speaker, "id_event", "identity.country") : [],
    ]);

    const roleMap = new Map();  // key = normalized, val = count
    const labelOf = new Map();  // key = normalized, val = first seen trimmed label
    [...attSR, ...spkSR].forEach(r=>{
      const raw = (typeof r._id === "string" ? r._id : "");
      const t = raw.trim();
      if (!t) return; // drop empty/null => no "Unspecified"
      const k = t.toLowerCase();
      if (!labelOf.has(k)) labelOf.set(k, t);
      roleMap.set(k, (roleMap.get(k)||0) + r.c);
    });
    const subRoles = [...roleMap.entries()]
      .sort((a,b)=> b[1]-a[1] || (labelOf.get(a[0])||a[0]).localeCompare(labelOf.get(b[0])||b[0]))
      .map(([k,count])=>({ name: labelOf.get(k) || k, count }));

    const cMap = new Map();
    [...attC, ...spkC].forEach(r=>{
      const key = (r._id || "").toString().toUpperCase();
      if (!key) return;
      cMap.set(key, (cMap.get(key)||0) + r.c);
    });
    const countries = [...cMap.entries()]
      .sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]))
      .map(([code,count])=>({ code, count }));

    res.json({
      success:true,
      events: events.map(e=>({ id:String(e._id), title:e.title||"Event", startDate:e.startDate||null })),
      defaultEventId: eventId,
      subRoles,
      countries
    });
  }catch(e){ next(e); }
};

/* ---------- LIST: grouped-by-subRole OR flat by ?subRole= ---------- */
exports.getCommunityList = async (req, res, next) => {
  try {
    const eventId = str(req.query.eventId);
    const subRole = str(req.query.subRole);        // when present => flat mode
    const country = str(req.query.country);
    const q       = str(req.query.q);
    const page    = Math.max(1, toNum(req.query.page, 1));
    const limit   = Math.max(1, Math.min(100, toNum(req.query.limit, 24)));
    const skip    = Math.max(0, (page - 1) * limit);
    const eventIdObj = isId(eventId) ? new mongoose.Types.ObjectId(eventId) : null;

    // Event attendance model (check-in)
    const EventCheckin =
      mongoose.models.eventCheckin ||
      mongoose.model(
        "eventCheckin",
        new mongoose.Schema(
          {
            eventId:   { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
            actorId:   { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
            actorRole: { type: String, enum: ["attendee","exhibitor","speaker","admin"], required: true },
            at:        { type: Date, default: Date.now },
            by:        { type: mongoose.Schema.Types.ObjectId, index: true },
          },
          { versionKey: false, timestamps: false }
        )
      );

    // Build common filters
    const like = q ? new RegExp(esc(q), "i") : null;
    const baseMatch = (idField, countryPath) => {
      const m = {};
      if (eventIdObj) m[idField] = eventIdObj;
      if (country) m[countryPath] = rxEq(country);
      if (q) {
        m.$or = [
          { "personal.fullName": like }, { "identity.fullName": like },
          { "personal.email": like },    { "identity.email": like },
          { "organization.orgName": like }
        ];
      }
      return m;
    };

    // ───────────────────────── FLAT MODE ─────────────────────────
    if (subRole) {
      const matchAtt = baseMatch("id_event","personal.country");   matchAtt.subRole = rxEqTrim(subRole);
      const matchSpk = baseMatch("id_event","identity.country");   matchSpk.subRole = rxEqTrim(subRole);

      const [attRows, spkRows, attCnt, spkCnt, checkins] = await Promise.all([
        attendee ? attendee.find(matchAtt).skip(skip).limit(limit).lean() : [],
        speaker  ? speaker.find(matchSpk).skip(skip).limit(limit).lean() : [],
        attendee ? attendee.countDocuments(matchAtt) : 0,
        speaker  ? speaker.countDocuments(matchSpk)  : 0,
        eventIdObj
          ? EventCheckin.find({
              eventId: eventIdObj,
              actorRole: { $in: ["attendee", "speaker"] },
            })
              .select("actorId actorRole")
              .lean()
          : [],
      ]);

      // lookup sets for who attended
      const attSet = new Set();
      const spkSet = new Set();
      (checkins || []).forEach((c) => {
        const key = String(c.actorId);
        if (c.actorRole === "attendee") attSet.add(key);
        else if (c.actorRole === "speaker") spkSet.add(key);
      });

      const items = [
        ...(attRows || []).map((r) => ({
          ...mapAtt(r),
          isAtt: attSet.has(String(r._id)),
        })),
        ...(spkRows || []).map((r) => ({
          ...mapSpk(r),
          isAtt: spkSet.has(String(r._id)),
        })),
      ];

      return res.json({ success: true, items, total: attCnt + spkCnt });
    }

    // ───────────────────────── GROUPED MODE ──────────────────────
    const matchAtt = baseMatch("id_event","personal.country");
    const matchSpk = baseMatch("id_event","identity.country");
    const sampleN = Math.min(8, limit);

    const [attAll, spkAll, checkins] = await Promise.all([
      attendee ? attendee.find(matchAtt).select("_id personal organization subRole").lean() : [],
      speaker  ? speaker.find(matchSpk).select("_id personal identity organization subRole").lean() : [],
      eventIdObj
        ? EventCheckin.find({
            eventId: eventIdObj,
            actorRole: { $in: ["attendee", "speaker"] },
          })
            .select("actorId actorRole")
            .lean()
        : [],
    ]);

    // lookup sets for who attended (for all buckets)
    const attSet = new Set();
    const spkSet = new Set();
    (checkins || []).forEach((c) => {
      const key = String(c.actorId);
      if (c.actorRole === "attendee") attSet.add(key);
      else if (c.actorRole === "speaker") spkSet.add(key);
    });

    const bucket = new Map();   // key = normalized subRole => members[]
    const labelOf = new Map();  // key => first seen trimmed label
    const push = (r)=>{
      const roles = Array.isArray(r.subRole) ? r.subRole : [];
      roles.forEach(sr=>{
        const t = String(sr||"").trim();
        if (!t) return;                  // no “Unspecified” bucket
        const k = t.toLowerCase();
        if (!bucket.has(k)) { bucket.set(k, []); labelOf.set(k, t); }
        bucket.get(k).push(r);
      });
    };
    (attAll||[]).forEach(push);
    (spkAll||[]).forEach(push);

    const groups = [...bucket.entries()]
      .sort((a,b)=> b[1].length - a[1].length || (labelOf.get(a[0])||a[0]).localeCompare(labelOf.get(b[0])||b[0]))
      .map(([k, arr])=>({
        name: labelOf.get(k) || k,
        count: arr.length,
        items: arr.slice(0, sampleN).map((x) => {
          const base = ("personal" in x ? mapAtt(x) : mapSpk(x));
          const isAtt =
            "personal" in x
              ? attSet.has(String(x._id))
              : spkSet.has(String(x._id))
          return { ...base, isAtt };
        }),
      }));

    res.json({ success:true, groups, total: (attAll?.length||0) + (spkAll?.length||0) });
  } catch (e) {
    next(e);
  }
};