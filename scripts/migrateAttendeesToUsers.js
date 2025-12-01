/* scripts/migrateAttendeesToUsers.js */
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");

const Attendee = require("../models/attendee");
const User = require("../models/user");

const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const MONGO_URI =
  process.env.DATABASE_URI ||
  process.env.MONGO_URI ||
  "mongodb://127.0.0.1:27017/eventra";

// map attendee.actorType / attendee.role -> user.actorType enum
function mapActorType(a) {
  if (!a) return "Other";
  const v = String(a).trim().toLowerCase();
  if (
    v === "businessowner" ||
    v === "business-owner" ||
    v === "entrepreneur" ||
    v === "founder"
  )
    return "BusinessOwner";
  if (v === "investor" || v === "vc" || v === "angel") return "Investor";
  if (v === "consultant" || v === "coach") return "Consultant";
  if (v === "expert" || v === "mentor" || v === "advisor") return "Expert";
  if (v === "employee" || v === "staff") return "Employee";
  if (v === "student") return "Student";
  return "Other";
}

function makeRandomPassword() {
  // long random pwd; hashed by userSchema pre-save
  return "Attnd!" + crypto.randomBytes(10).toString("hex");
}

(async () => {
  try {
    console.log("Connecting to Mongo…");
    await mongoose.connect(MONGO_URI);
    console.log("Connected:", MONGO_URI);

    const attendees = await Attendee.find({}).exec();
    const total = attendees.length;
    console.log("Total attendees found:", total);

    let createdUsers = 0;
    let linkedExisting = 0;
    let alreadyLinked = 0;
    let invalidEmail = 0;
    let errors = 0;

    for (let i = 0; i < total; i++) {
      const a = attendees[i];
      const email = (a.personal?.email || "").trim().toLowerCase();
      const fullName = (a.personal?.fullName || "").trim();

      console.log(
        `\n[${i + 1}/${total}] Attendee ${a._id.toString()} - ${fullName} <${email}>`
      );

      if (a.user) {
        console.log("  → already linked to user:", a.user.toString());
        alreadyLinked++;
        continue;
      }

      if (!email || !EMAIL_RX.test(email)) {
        console.log("  ! invalid or missing email, skipping");
        invalidEmail++;
        continue;
      }

      try {
        // check if user already exists by email
        let user = await User.findOne({ email }).exec();

        if (user) {
          console.log("  → existing user found:", user._id.toString());
          a.user = user._id;
          await a.save();
          linkedExisting++;
          continue;
        }

        // build new user from attendee
        const actorTypeSrc = a.actorType || a.role || "";
        const actorType = mapActorType(actorTypeSrc);

        const subRole = Array.isArray(a.subRole) ? a.subRole : [];

        const phone = (a.personal?.phone || "").trim();
        const orgName = (a.organization?.orgName || "").trim();
        const jobTitle = (a.organization?.jobTitle || "").trim();

        const newUser = new User({
          fullName: fullName || email,
          email,
          phone: phone || undefined,
          organization: orgName || undefined,
          jobTitle: jobTitle || undefined,
          actorType,
          subRole,
          pwd: makeRandomPassword(),
          verified: !!a.verified,
          loginProvider: "password",
        });

        await newUser.save();
        console.log("  → created new user:", newUser._id.toString());
        createdUsers++;

        a.user = newUser._id;
        await a.save();
        console.log("  → linked attendee.user to:", newUser._id.toString());
      } catch (err) {
        errors++;
        console.error("  ! ERROR while processing attendee:", err.message);
      }
    }

    console.log("\n===== MIGRATION SUMMARY =====");
    console.log("Total attendees:", total);
    console.log("Users created      :", createdUsers);
    console.log("Linked to existing :", linkedExisting);
    console.log("Already linked     :", alreadyLinked);
    console.log("Invalid email      :", invalidEmail);
    console.log("Errors             :", errors);

    await mongoose.disconnect();
    console.log("Disconnected. Done.");
    process.exit(0);
  } catch (err) {
    console.error("FATAL:", err);
    process.exit(1);
  }
})();
