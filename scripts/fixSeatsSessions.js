// scripts/backfill-attendance.js
require("dotenv").config();
const mongoose = require("mongoose");

// --- CONFIG ---
// Event to backfill
const EVENT_ID =
  process.env.BACKFILL_EVENT_ID || "68e6764bb4f9b08db3ccec04";
const SCANNER_ID = "68eceeed78d8944c819e826b"; // scanner/admin user
const MAX_NEW_CHECKINS = 100; // <-- hard limit

// --- MODELS ---
const Attendee = require("../models/attendee");

// If you already have a dedicated model file for eventCheckin, use:
// const EventCheckin = require("../models/eventCheckin");
const EventCheckin =
  mongoose.models.eventCheckin ||
  mongoose.model(
    "eventCheckin",
    new mongoose.Schema(
      {
        eventId: {
          type: mongoose.Schema.Types.ObjectId,
          index: true,
          required: true,
        },
        actorId: {
          type: mongoose.Schema.Types.ObjectId,
          index: true,
          required: true,
        },
        actorRole: {
          type: String,
          enum: ["attendee", "exhibitor", "speaker", "admin"],
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, index: true },
      },
      { versionKey: false, timestamps: false }
    )
  );

// --- UTIL ---
/**
 * Get a random Date today between [08:00, 14:30]
 */
function randomTimeToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  const start = new Date(y, m, d, 8, 0, 0, 0); // 08:00
  const end = new Date(y, m, d, 14, 30, 0, 0); // 14:30

  const diffMs = end.getTime() - start.getTime();
  const offset = Math.floor(Math.random() * diffMs);

  return new Date(start.getTime() + offset);
}

// Fisher–Yates shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  if (!process.env.DATABASE_URI) {
    console.error("Missing DATABASE_URI in .env");
    process.exit(1);
  }
  if (!EVENT_ID || EVENT_ID === "PUT_EVENT_ID_HERE") {
    console.error("Set EVENT_ID or BACKFILL_EVENT_ID before running.");
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE_URI /* options if needed */);

  const eventIdObj = new mongoose.Types.ObjectId(EVENT_ID);
  const scannerIdObj = new mongoose.Types.ObjectId(SCANNER_ID);

  console.log("Backfill for event:", EVENT_ID);

  // 1) Who already has checkins for this event (as attendee)?
  const existing = await EventCheckin.find({
    eventId: eventIdObj,
    actorRole: "attendee",
  })
    .select("actorId")
    .lean();

  const alreadySet = new Set(existing.map((c) => String(c.actorId)));
  console.log("Existing attendee checkins:", alreadySet.size);

  // 2) Find attendees that are adminVerified yes/true and belong to this event
  const verifiedFilter = {
    id_event: eventIdObj,
    $or: [{ adminVerified: "yes" }, { adminVerified: true }],
  };

  const allVerified = await Attendee.find(verifiedFilter)
    .select("_id personal.fullName adminVerified")
    .lean();

  console.log("Total adminVerified attendees for this event:", allVerified.length);

  // 3) Filter those missing from eventCheckins
  const missing = allVerified.filter(
    (att) => !alreadySet.has(String(att._id))
  );

  console.log("Missing checkins (raw):", missing.length);

  if (missing.length === 0) {
    console.log("Nothing to backfill. Exiting.");
    await mongoose.disconnect();
    return;
  }

  // 3b) Shuffle and cap to MAX_NEW_CHECKINS
  const shuffled = shuffle(missing);
  const picked = shuffled.slice(
    0,
    Math.min(MAX_NEW_CHECKINS, shuffled.length)
  );

  console.log("Will actually insert:", picked.length);

  // 4) Build docs to insert
  const docs = picked.map((att) => ({
    eventId: eventIdObj,
    actorId: att._id,
    actorRole: "attendee",
    at: randomTimeToday(),
    by: scannerIdObj,
  }));

  // Safety: log a preview of first 5
  console.log("Preview of first 5 docs:", docs.slice(0, 5));

  const inserted = await EventCheckin.insertMany(docs);
  console.log("Inserted checkins:", inserted.length);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
