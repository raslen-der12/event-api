// scripts/migrate_bpitem_sector_commas.js
require("dotenv").config();
const mongoose = require("mongoose");
const BPItem = require("../models/BPItem");

// ---- helpers ----
const toArr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [String(v)]));
const rep = (s) => String(s ?? "").replace(/,/g, "/").trim();
const cleanList = (arr) =>
  Array.from(new Set(toArr(arr).map(rep).filter(Boolean)));

function changed(a, b) {
  try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
}

async function connect() {
  const uri = process.env.DATABASE_URI || "mongodb+srv://raslen_dr12:fvg3p5HN2ZV2kZvr@cluster0.n4zvuoo.mongodb.net/gits" ;
  if (!uri) {
    console.error("ERROR: Missing .env DATABASE_URI");
    process.exit(1);
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("[mongo] connected:", uri.replace(/\/\/([^@]*?)@/, "//*****:*****@"));
}

(async () => {
  try {
    await connect();

    console.log("\n==> BPItem sector migration starting°≠");
    let scanned = 0, updated = 0;

    const cursor = BPItem.find(
      { sector: { $exists: true } },
      { sector: 1 }
    ).cursor();

    for await (const doc of cursor) {
      scanned++;

      const before = doc.sector;
      let after;

      if (Array.isArray(before)) after = cleanList(before);
      else if (before != null)    after = rep(before);
      else                        after = before;

      if (changed(before, after)) {
        await BPItem.updateOne({ _id: doc._id }, { $set: { sector: after } }).exec();
        updated++;
        console.log(`[ITEM] ${doc._id}`);
        console.log("  sector:", before, " => ", after);
      }

      if (scanned % 100 === 0) {
        console.log(`  °≠progress: scanned=${scanned}, updated=${updated}`);
      }
    }

    console.log(`==> BPItem done. scanned=${scanned}, updated=${updated}`);
  } catch (e) {
    console.error("FATAL:", e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(()=>{});
  }
})();
