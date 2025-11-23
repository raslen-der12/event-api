// scripts/export-attendees-without-bp.js
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const xlsx = require("xlsx");

const Attendee = require("../models/attendee");
const BusinessProfile = require("../models/BusinessProfile");

// Your target event
const EVENT_ID = "68e6764bb4f9b08db3ccec04";

async function main() {
  const mongoUri = process.env.DATABASE_URI;
  if (!mongoUri) {
    console.error("Missing env: DATABASE_URI");
    process.exit(1);
  }

  console.log("Connecting to MongoDB…");
  await mongoose.connect(mongoUri);

  try {
    // 1) Get attendee ids that HAVE a business profile (owner or team) – no event filter here
    console.log("Collecting attendee ids from BusinessProfile…");

    // Owners where the actor is an attendee
    const ownerAttendeeIds = await BusinessProfile.distinct("owner.actor", {
      "owner.role": "attendee", // owner.role is lowercase in schema
    });

    // Team members that are attendees
    const teamAttendeeIds = await BusinessProfile.distinct("team.entityId", {
      "team.role": "attendee",
    });

    // Merge + dedupe
    const excludeMap = new Map();
    [...ownerAttendeeIds, ...teamAttendeeIds].forEach((id) => {
      if (!id) return;
      excludeMap.set(String(id), id);
    });
    const attendeeIdsWithBP = Array.from(excludeMap.values());

    console.log(
      `Attendee ids with at least one BusinessProfile (owner or team): ${attendeeIdsWithBP.length}`
    );

    // 2) Attendees under this EVENT_ID that do NOT appear in attendeeIdsWithBP
    console.log("Querying attendees without any BusinessProfile under this event…");

    const attendeesWithoutBP = await Attendee.find({
      id_event: EVENT_ID,
      _id: { $nin: attendeeIdsWithBP },
    }).lean();

    console.log(
      `Found ${attendeesWithoutBP.length} attendees WITHOUT BusinessProfile for event ${EVENT_ID}`
    );

    // 3) Build Excel rows
    const rows = attendeesWithoutBP.map((a) => ({
      FullName: a.personal?.fullName || "",
      Email: a.personal?.email || a.personal?.firstEmail || "",
      Phone: a.personal?.phone || "",
      Country: a.personal?.country || "",
      City: a.personal?.city || "",
      OrgName: a.organization?.orgName || "",
      JobTitle: a.organization?.jobTitle || "",
      BusinessRole: a.organization?.businessRole || "",
      ActorType: a.actorType || "",
      Role: a.role || "",
      EventId: String(a.id_event || ""),
      CreatedAt: a.createdAt ? a.createdAt.toISOString() : "",
    }));

    // 4) Write Excel
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(wb, ws, "AttendeesWithoutBP");

    const outPath = path.resolve(
      __dirname,
      "../exports/attendees_without_bp_68e6764bb4f9b08db3ccec04.xlsx"
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    xlsx.writeFile(wb, outPath);

    console.log("Excel written:", outPath);
  } catch (err) {
    console.error("Error while exporting:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
