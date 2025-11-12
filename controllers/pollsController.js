const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Poll = require("../models/Poll");
const PollVote = require("../models/PollVote");

// ------ Agenda integration (auto-stop) ------
const JOB_POLL_AUTOSTOP = "poll:autoStop";

function getAgenda(app) { return app?.locals?.agenda || null; }

async function scheduleAutoStop(app, pollId, when) {
  const agenda = getAgenda(app);
  if (!agenda || !when) return;
  // clear old
  await agenda.cancel({ name: JOB_POLL_AUTOSTOP, "data.pollId": String(pollId) });
  await agenda.schedule(new Date(when), JOB_POLL_AUTOSTOP, { pollId: String(pollId) });
}

async function cancelAutoStop(app, pollId) {
  const agenda = getAgenda(app);
  if (!agenda) return;
  await agenda.cancel({ name: JOB_POLL_AUTOSTOP, "data.pollId": String(pollId) });
}

// call once in server bootstrap (see bottom export)
async function initPollAgenda(app) {
  const agenda = getAgenda(app);
  if (!agenda) return; // if you don't use Agenda globally, skip
  // define only once
  if (!app.locals._pollJobDefined) {
    agenda.define(JOB_POLL_AUTOSTOP, async (job) => {
      const pollId = job?.attrs?.data?.pollId;
      if (!pollId) return;
      const poll = await Poll.findById(pollId).lean();
      if (!poll || poll.stoppedAt) return;
      const now = new Date();
      if (poll.endsAt && poll.endsAt <= now) {
        await Poll.updateOne({ _id: pollId }, { $set: { stoppedAt: now } });
      }
    });
    app.locals._pollJobDefined = true;
  }
}

// ------ Helpers ------
function deriveStatus(p) {
  const now = Date.now();
  const started = !!p.startedAt;
  const ended   = !!p.stoppedAt || (!!p.endsAt && new Date(p.endsAt).getTime() <= now);
  if (!started) return "upcoming";
  if (ended)    return "finished";
  return "running";
}

function ensureOptions(raw) {
  // Accept ["A","B"] or [{key,label}, ...]
  const out = [];
  const seen = new Set();
  for (const it of raw || []) {
    const label = (typeof it === "string") ? it : (it?.label ?? "");
    const key   = (typeof it === "string") ? label.toLowerCase().trim().replace(/\s+/g, "-").slice(0,64)
                                           : (it?.key ?? "");
    const k = String(key || label || "").trim();
    const l = String(label || key || "").trim();
    if (!k || !l || seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, label: l, count: 0 });
  }
  if (out.length < 2) throw new Error("At least two options required");
  return out;
}

// ============ ADMIN ============

// POST /admin/polls
exports.adminCreatePoll = asyncHandler(async (req, res) => {
  const { title, options, durationSec } = req.body || {};
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return res.status(400).json({ ok: false, error: "title required" });

  let opts;
  try { opts = ensureOptions(options); }
  catch(e){ return res.status(400).json({ ok:false, error: e.message }); }

  const dur = Number(durationSec || 0);
  const doc = await Poll.create({
    title: cleanTitle,
    options: opts,
    // duration > 0 => auto-stop on start; 0 => manual stop
    durationSec: Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 0,
    startedAt: null,
    endsAt: null,
    stoppedAt: null,
    createdBy: req.user?._id || null,
    // keep schema-compatible fields if they exist; they won’t be used anymore
    autoStop: undefined,
    allowMultiple: undefined,
    startsAt: undefined,
  });

  res.json({ ok: true, data: { id: String(doc._id) } });
});

// POST /admin/polls/:id/start
exports.adminStartPoll = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok:false, error:"bad id" });

  const poll = await Poll.findById(id);
  if (!poll) return res.status(404).json({ ok:false, error:"not found" });
  if (poll.startedAt && !poll.stoppedAt) return res.status(409).json({ ok:false, error:"already running" });

  const now = new Date();
  poll.startedAt = now;
  poll.stoppedAt = null;
  // durationSec > 0 => timed; else manual stop
  poll.endsAt = (Number(poll.durationSec || 0) > 0)
    ? new Date(now.getTime() + poll.durationSec * 1000)
    : null;

  await poll.save();

  await scheduleAutoStop(req.app, poll._id, poll.endsAt);

  res.json({
    ok:true,
    data: {
      id: String(poll._id),
      status: deriveStatus(poll),
      startedAt: poll.startedAt,
      endsAt: poll.endsAt
    }
  });
});

// POST /admin/polls/:id/stop
exports.adminStopPoll = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok:false, error:"bad id" });
  const poll = await Poll.findById(id);
  if (!poll) return res.status(404).json({ ok:false, error:"not found" });
  if (poll.stoppedAt) return res.json({ ok:true, data: { id: String(poll._id), status: "finished" } });

  poll.stoppedAt = new Date();
  await poll.save();
  await cancelAutoStop(req.app, poll._id);

  res.json({ ok:true, data: { id: String(poll._id), status: "finished", stoppedAt: poll.stoppedAt } });
});

// GET /admin/polls (optional ?q=, ?status=running|upcoming|finished)
exports.adminListPolls = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const statusFilter = String(req.query.status || "").trim();

  const list = await Poll.find({}).sort({ createdAt: -1 }).lean();
  const enriched = list.map(p => {
    const s = deriveStatus(p);
    return {
      _id: String(p._id),
      title: p.title,
      options: p.options,
      startsAt: p.startsAt,
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      stoppedAt: p.stoppedAt,
      durationSec: p.durationSec,
      autoStop: p.autoStop,
      allowMultiple: p.allowMultiple,
      status: s,
      createdAt: p.createdAt,
    };
  }).filter(p => !q || p.title.toLowerCase().includes(q))
    .filter(p => !statusFilter || p.status === statusFilter);

  const now = Date.now();
  const grouped = {
    upcoming:  enriched.filter(p => p.status === "upcoming"),
    running:   enriched.filter(p => p.status === "running"),
    finished:  enriched.filter(p => p.status === "finished"),
    counts:    {
      upcoming:  enriched.filter(p => p.status === "upcoming").length,
      running:   enriched.filter(p => p.status === "running").length,
      finished:  enriched.filter(p => p.status === "finished").length,
      total:     enriched.length,
      now:       new Date(now),
    }
  };

  res.json({ ok:true, ...grouped });
});

// GET /admin/polls/:id/results (?source=recount)
exports.adminPollResults = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok:false, error:"bad id adminPollResults" });
  const poll = await Poll.findById(id).lean();
  if (!poll) return res.status(404).json({ ok:false, error:"not found" });

  const source = String(req.query.source || "").toLowerCase();
  let counts = {};
  if (source === "recount") {
    // authoritative recount from votes collection
    const agg = await PollVote.aggregate([
      { $match: { pollId: new mongoose.Types.ObjectId(id) } },
      { $group: { _id: "$optionKey", n: { $sum: 1 } } }
    ]);
    for (const r of agg) counts[r._id] = r.n;
  } else {
    // fast path from Poll.options[].count
    counts = Object.fromEntries((poll.options || []).map(o => [o.key, o.count || 0]));
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  const options = (poll.options || []).map(o => ({
    key: o.key, label: o.label, count: counts[o.key] || 0,
    pct: total ? Math.round((100 * (counts[o.key] || 0)) / total) : 0
  }));

  res.json({
    ok: true,
    data: {
      id: String(poll._id),
      title: poll.title,
      status: deriveStatus(poll),
      startedAt: poll.startedAt,
      endsAt: poll.endsAt,
      stoppedAt: poll.stoppedAt,
      total,
      options
    }
  });
});

// ============ PUBLIC ============

// GET /polls (list running)
exports.listPublicPolls = asyncHandler(async (req, res) => {
  const now = new Date();
  const docs = await Poll.find({ public: true }).sort({ createdAt: -1 }).lean();
  const running = docs.filter(p => deriveStatus(p) === "running");
  res.json({
    ok: true,
    data: running.map(p => ({
      id: String(p._id),
      title: p.title,
      options: (p.options || []).map(o => ({ key: o.key, label: o.label })),
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      serverTime: new Date()
    }))
  });
});

// GET /polls/:id (fetch a poll for voting; expose even if upcoming to allow countdown UI)
exports.getPublicPoll = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok:false, error:"bad id" });
  const p = await Poll.findById(id).lean();
  if (!p || !p.public) return res.status(404).json({ ok:false, error:"not found" });

  res.json({
    ok: true,
    data: {
      id: String(p._id),
      title: p.title,
      options: (p.options || []).map(o => ({ key: o.key, label: o.label })),
      status: deriveStatus(p),
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      serverTime: new Date()
    }
  });
});

// POST /polls/:id/vote  body: { optionKey, voterId? }
exports.submitVote = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const { voterId } = req.body || {};
  const optionKey = req.body.optionId || req.body.optionKey || ""
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok:false, error:"bad id" });

  const poll = await Poll.findById(id);
  if (!poll || !poll.public) return res.status(404).json({ ok:false, error:"not found" });

  const status = deriveStatus(poll);
  if (status !== "running") return res.status(409).json({ ok:false, error: "poll not running" });

  const key = String(optionKey || "").trim();
  const exists = (poll.options || []).some(o => o.key === key);
  if (!exists) return res.status(400).json({ ok:false, error:"invalid optionKey" });

  // enforce single vote per voterId if provided AND allowMultiple === false
  if (voterId) {
    const dup = await PollVote.findOne({ pollId: poll._id, voterId }).lean();
    if (dup) return res.status(409).json({ ok:false, error:"already voted" });
  }

  // write vote
  await PollVote.create({
    pollId: poll._id,
    optionKey: key,
    voterId: voterId || null,
    ip: req.ip || null,
    ua: req.get?.("user-agent") || null,
  });

  // bump counter atomically
  await Poll.updateOne(
    { _id: poll._id, "options.key": key },
    { $inc: { "options.$.count": 1 } }
  );

  res.json({ ok:true });
});

// -------- Agenda init export (call once in server) --------
exports.initPollAgenda = initPollAgenda;
