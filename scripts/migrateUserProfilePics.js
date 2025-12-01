// scripts/migrateUserProfilePics.js
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/user");
const Attendee = require("../models/attendee");
const Speaker = require("../models/speaker");

const toStr = (v) => (v == null ? "" : String(v));

async function main() {
  const uri = process.env.DATABASE_URI;
  if (!uri) {
    console.error("DATABASE_URI is not set in env");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const users = await User.find({})
    .select("_id email profilePic")
    .lean()
    .exec();

  let total = 0;
  let updated = 0;
  let alreadyHadPic = 0;
  let noMatch = 0;
  let fromAttendee = 0;
  let fromSpeaker = 0;

  console.log(`Found ${users.length} users, starting migration…`);

  for (const u of users) {
    total++;
    const uid = String(u._id);
    const email = toStr(u.email).toLowerCase().trim();

    if (!email) {
      console.log(`[SKIP] User ${uid} has no email`);
      noMatch++;
      continue;
    }

    // if user already has profilePic, leave it
    if (u.profilePic && toStr(u.profilePic).trim()) {
      alreadyHadPic++;
      continue;
    }

    let profilePic = null;

    // 1) try attendee
    const att = await Attendee.findOne({
      $or: [
        { "personal.email": email },
        { "personal.firstEmail": email },
      ],
    })
      .select("personal.profilePic")
      .lean()
      .exec();

    if (att && att.personal && toStr(att.personal.profilePic).trim()) {
      profilePic = toStr(att.personal.profilePic).trim();
      fromAttendee++;
    } else {
      // 2) fallback on speaker
      const sp = await Speaker.findOne({
        $or: [
          { "personal.email": email },
          { "personal.firstEmail": email },
        ],
      })
        .select("personal.profilePic")
        .lean()
        .exec();

      if (sp && sp.personal && toStr(sp.personal.profilePic).trim()) {
        profilePic = toStr(sp.personal.profilePic).trim();
        fromSpeaker++;
      }
    }

    if (!profilePic) {
      noMatch++;
      continue;
    }

    await User.updateOne(
      { _id: u._id },
      { $set: { profilePic } }
    ).exec();

    updated++;
    console.log(
      `[OK] User ${uid} (${email}) -> profilePic = ${profilePic}`
    );
  }

  console.log("---- MIGRATION SUMMARY ----");
  console.log(`Total users      : ${total}`);
  console.log(`Updated pics     : ${updated}`);
  console.log(`Already had pics : ${alreadyHadPic}`);
  console.log(`No match found   : ${noMatch}`);
  console.log(`From attendee    : ${fromAttendee}`);
  console.log(`From speaker     : ${fromSpeaker}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
