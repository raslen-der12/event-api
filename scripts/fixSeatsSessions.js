
/* ===== Setup ===== */
const mongoose = require('mongoose');

// ⚠️ Adjust these paths if your structure differs
const SessionRegistration = require('../models/sessionRegistration');          // sessionRegistration.js
const Schedule            = require('../models/eventModels/schedule');        // eventModels/schedule.js
const Attendee            = require('../models/attendee');
const Exhibitor           = require('../models/exhibitor');
const Speaker             = require('../models/speaker');

const MONGO_URI = process.env.DATABASE_URI

/* ===== Helpers ===== */
const oidStr = (v) => {
  try { return String(v); } catch { return null; }
};
const getActorId = (r) =>
  r.actorId || r.actor || r.id_actor || r.actor_id || (r.actor && r.actor._id);
const getSessionId = (r) =>
  r.sessionId || r.session || r.id_session || r.scheduleId || r.id_schedule || (r.session && r.session._id);

/* ===== Main ===== */
(async () => {
  const t0 = Date.now();
  await mongoose.connect(MONGO_URI, { maxPoolSize: 10 });
  console.log('[rebuild] connected');

  // 1) Load all session registrations (lean for perf)
  const regs = await SessionRegistration.find({}).select('_id actorId actor sessionId session id_session id_schedule').lean();
  console.log(`[rebuild] registrations loaded: ${regs.length}`);

  // 2) Collect unique actorIds referenced by registrations
  const actorIds = new Set();
  for (const r of regs) {
    const a = oidStr(getActorId(r));
    if (a) actorIds.add(a);
  }
  console.log(`[rebuild] unique actorIds referenced: ${actorIds.size}`);

  // 3) Resolve which actorIds actually exist (union of Attendee, Exhibitor, Speaker)
  const idsArr = Array.from(actorIds).map((s) => new mongoose.Types.ObjectId(s));
  const [attOK, exOK, spOK] = await Promise.all([
    Attendee.find({ _id: { $in: idsArr } }).select('_id').lean(),
    Exhibitor.find({ _id: { $in: idsArr } }).select('_id').lean(),
    Speaker.find({ _id: { $in: idsArr } }).select('_id').lean(),
  ]);

  const validActorIds = new Set(
    attOK.concat(exOK, spOK).map((d) => String(d._id))
  );
  console.log(`[rebuild] valid actorIds found: ${validActorIds.size}`);

  // 4) Split registrations into valid vs invalid (actor missing)
  const invalidRegIds = [];
  // Map<sessionId, Set<actorId>> to dedupe actors per session
  const perSessionActors = new Map();

  for (const r of regs) {
    const a = oidStr(getActorId(r));
    const s = oidStr(getSessionId(r));
    if (!a || !s) {
      invalidRegIds.push(String(r._id)); // malformed reg – drop it
      continue;
    }
    if (!validActorIds.has(a)) {
      invalidRegIds.push(String(r._id));
      continue;
    }
    // keep valid -> count per session (dedupe actors)
    if (!perSessionActors.has(s)) perSessionActors.set(s, new Set());
    perSessionActors.get(s).add(a);
  }

  console.log(`[rebuild] invalid registrations to delete: ${invalidRegIds.length}`);
  console.log(`[rebuild] sessions with at least one valid reg: ${perSessionActors.size}`);

  if (invalidRegIds.length) {
    await SessionRegistration.deleteMany({ _id: { $in: invalidRegIds } });
    console.log('[rebuild] invalid registrations deleted');
  }

  const schedules = await Schedule.find({}).select('_id seats seatsTaken').lean();
  console.log(`[rebuild] schedules loaded: ${schedules.length}`);

  const ops = [];
  for (const sch of schedules) {
    const sid = String(sch._id);
    const count = perSessionActors.get(sid)?.size || 0;
    ops.push({
      updateOne: {
        filter: { _id: sch._id },
        update: {
          $set: {
            seatsTaken: count,          // top-level (if your schema uses this)
            'seats.taken': count,       // nested (if your schema uses seats: { taken })
          },
        },
      },
    });
  }

  // chunk bulks for safety (1k ops per batch)
  const CHUNK = 1000;
  let updated = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const slice = ops.slice(i, i + CHUNK);
    if (slice.length) {
      const r = await Schedule.bulkWrite(slice, { ordered: false });
      updated += (r.modifiedCount || 0) + (r.upsertedCount || 0) + (r.matchedCount || 0);
    }
  }

  const t1 = Date.now();
  console.log(`[rebuild] schedules updated: ${ops.length} (bulk). elapsed=${((t1 - t0) / 1000).toFixed(2)}s`);

  await mongoose.disconnect();
  console.log('[rebuild] done.');
})().catch(async (err) => {
  console.error('[rebuild] FAILED:', err && err.stack || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
