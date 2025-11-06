// controllers/community.controller.js
const mongoose = require("mongoose");
const Event = require("../models/event");                // adjust path if different
const attendee = require("../models/attendee");          // you shared attendee.js
const speaker  = require("../models/speaker");           // you shared speaker.js

const isId = (v) => mongoose.isValidObjectId(v);
const toNum = (v,d=0)=> (Number.isFinite(+v)?+v:d);
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const rxEq = v => new RegExp(`^${esc(String(v))}$`, "i");
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

    const roleMap = new Map();
    [...attSR, ...spkSR].forEach(r=>{
      const key = r._id || "Unspecified";
      roleMap.set(key, (roleMap.get(key)||0) + r.c);
    });
    const subRoles = [...roleMap.entries()]
      .sort((a,b)=> b[1]-a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([name,count])=>({ name, count }));

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
  try{
    const eventId = str(req.query.eventId);
    const subRole = str(req.query.subRole);        // when present => flat mode
    const country = str(req.query.country);
    const q       = str(req.query.q);
    const page    = Math.max(1, toNum(req.query.page, 1));
    const limit   = Math.max(1, Math.min(100, toNum(req.query.limit, 24)));
    const skip    = Math.max(0, (page - 1) * limit);

    // Build common filters
    const like = q ? new RegExp(esc(q), "i") : null;
    const baseMatch = (idField, countryPath) => {
      const m = {};
      if (isId(eventId)) m[idField] = new mongoose.Types.ObjectId(eventId);
      if (country) m[countryPath] = rxEq(country);
      if (q) {
        m.$or = [
          { "personal.fullName": like }, { "identity.fullName": like },
          { "personal.email": like }, { "identity.email": like },
          { "organization.orgName": like }
        ];
      }
      return m;
    };

    // FLAT mode (when subRole provided)
    if (subRole) {
      const matchAtt = baseMatch("id_event","personal.country");   matchAtt.subRole = subRole;
      const matchSpk = baseMatch("id_event","identity.country");   matchSpk.subRole = subRole;

      const [attRows, spkRows, attCnt, spkCnt] = await Promise.all([
        attendee ? attendee.find(matchAtt).skip(skip).limit(limit).lean() : [],
        speaker  ? speaker.find(matchSpk).skip(skip).limit(limit).lean() : [],
        attendee ? attendee.countDocuments(matchAtt) : 0,
        speaker  ? speaker.countDocuments(matchSpk)  : 0,
      ]);
      const items = [
        ...(attRows||[]).map(mapAtt),
        ...(spkRows||[]).map(mapSpk),
      ];
      return res.json({ success:true, items, total: attCnt + spkCnt });
    }

    // GROUPED mode (no subRole): return groups with up to N samples each
    const matchAtt = baseMatch("id_event","personal.country");
    const matchSpk = baseMatch("id_event","identity.country");
    const sampleN = Math.min(8, limit);

    const [attAll, spkAll] = await Promise.all([
      attendee ? attendee.find(matchAtt).select("_id personal organization subRole").lean() : [],
      speaker  ? speaker.find(matchSpk).select("_id personal identity organization subRole").lean() : [],
    ]);

    const bucket = new Map(); // subRole => array of members
    const push = (r)=>{
      const roles = Array.isArray(r.subRole) && r.subRole.length ? r.subRole : ["Unspecified"];
      roles.forEach(sr=>{
        const k = String(sr||"Unspecified");
        if (!bucket.has(k)) bucket.set(k, []);
        bucket.get(k).push(r);
      });
    };
    (attAll||[]).forEach(push);
    (spkAll||[]).forEach(push);

    const groups = [...bucket.entries()]
      .sort((a,b)=> b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, arr])=>({
        name,
        count: arr.length,
        items: arr.slice(0, sampleN).map(x => ("personal" in x ? mapAtt(x) : mapSpk(x)))
      }));

    res.json({ success:true, groups, total: (attAll?.length||0) + (spkAll?.length||0) });
  }catch(e){ next(e); }
};
