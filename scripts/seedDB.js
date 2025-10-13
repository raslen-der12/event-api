// scripts/insertAttendees.js
require('dotenv').config();
const mongoose = require('mongoose');

// EDIT THIS: path to your Attendee model file:
const Attendee = require('../models/attendee'); // e.g. ../models/Attendee.js

// Your raw documents to insert (as-is):
const DATA = [
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "At Terra, we’re leading a green shift in agriculture through advanced biological pest control, with a core focus on Trichogramma production and application. Our innovative, tech-powered systems allow farmers to protect their crops naturally—without chemicals, without compromise. Backed by a national incubation program from the Ministry of Communications and Information Technology through CIP Innovation Hub, Terra is scaling impact across Egypt. We combine science, smart automation, and sustainability to make biological control more efficient, affordable, and ready for the future of farming.",
    "subRole": [],
    "personal": {
      "fullName": "Muhammed imad",
      "firstEmail": "trechotechfarm@gmail.com",
      "email": "trechotechfarm@gmail.com",
      "phone": "01153525968",
      "country": "EG",
      "city": "",
      "profilePic": "https://gits.seketak-eg.com/wp-content/uploads/2025/05/IMG_20250428_205528_334.jpg",
      "preferredLanguages": []
    },
    "organization": { "orgName": "Terra", "jobTitle": "CEO", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "",
    "subRole": [],
    "personal": {
      "fullName": "",
      "firstEmail": "Sallyalphonse3@gmail.com",
      "email": "Sallyalphonse3@gmail.com",
      "phone": "",
      "country": "EG",
      "city": "",
      "profilePic": "",
      "preferredLanguages": []
    },
    "organization": { "orgName": "", "jobTitle": "", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "GOGREEN is a rooftop farming company dedicated to transforming urban spaces into green, sustainable oases. We specialize in designing, installing, and maintaining rooftop gardens that promote healthy living and environmental responsibility.",
    "subRole": [],
    "personal": {
      "fullName": "Ragab Abdelghany Hsneen Aboelhssan",
      "firstEmail": "ragab1975@gmail.com",
      "email": "ragab1975@gmail.com",
      "phone": "00201287460308",
      "country": "EG",
      "city": "",
      "profilePic": "https://gits.seketak-eg.com/wp-content/uploads/2025/05/1_20250503_133303_٠٠٠٠.jpg",
      "preferredLanguages": []
    },
    "organization": { "orgName": "GOGREEN", "jobTitle": "Founder", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": {
      "website": "",
      "linkedin": "https://www.linkedin.com/in/ragab-abdelghany-abo-elhassan-501080195?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=android_app"
    },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "",
    "subRole": [],
    "personal": {
      "fullName": "",
      "firstEmail": "abdelrahman.hagagy@agr.svu.edu.eg",
      "email": "abdelrahman.hagagy@agr.svu.edu.eg",
      "phone": "",
      "country": "EG",
      "city": "",
      "profilePic": "",
      "preferredLanguages": []
    },
    "organization": { "orgName": "", "jobTitle": "", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "",
    "subRole": [],
    "personal": {
      "fullName": "",
      "firstEmail": "info@remas-herbs.com",
      "email": "info@remas-herbs.com",
      "phone": "",
      "country": "EG",
      "city": "",
      "profilePic": "",
      "preferredLanguages": []
    },
    "organization": { "orgName": "", "jobTitle": "", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "Dear Sir/Madam, Greetings, I am Dina Ahmed, Export Officer at Herbs Farm, an Egyptian company specializing in the cultivation and export of high-quality medicinal and aromatic herbs, seeds, and spices. I am pleased to introduce our company and products and look forward to exploring potential collaboration opportunities with you.",
    "subRole": [],
    "personal": {
      "fullName": "Dina Ahmed",
      "firstEmail": "dai6532662@gmail.com",
      "email": "dai6532662@gmail.com",
      "phone": "01010143319",
      "country": "EG",
      "city": "",
      "profilePic": "https://gits.seketak-eg.com/wp-content/uploads/2025/05/IMG_٢٠٢٥٠٥١٠_١٦٠٩٤٢-1.jpg",
      "preferredLanguages": []
    },
    "organization": { "orgName": "Herbs farm", "jobTitle": "Export Official", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": {
      "website": "https://mail.herbs-farm.net",
      "linkedin": "https://www.linkedin.com/in/dina-ahmed-731a97294?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=android_app"
    },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "Dr. Marwa Hassan Abdel Ghani, a researcher at the Agricultural Research Center and the Executive Director of Legend Herbs Company for exporting medicinal and aromatic plants.",
    "subRole": [],
    "personal": {
      "fullName": "Dr.Marwa Hassan",
      "firstEmail": "info@legend-herbs.com",
      "email": "dr.marwa@legend-herbs.com",
      "phone": "00201014309220",
      "country": "EG",
      "city": "",
      "profilePic": "https://gits.seketak-eg.com/wp-content/uploads/2025/05/Screenshot_٢٠٢٥-٠٥-١٠-١١-٣٧-١٥-٤٣_7352322957d4404136654ef4adb64504.jpg",
      "preferredLanguages": []
    },
    "organization": { "orgName": "Legend Herbs", "jobTitle": "CEO", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "https://legend-herbs.com/", "linkedin": "https://calendly.com/dr-marwa-legend-herbs" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "Essam Shaaban is an agricultural biotechnology entrepreneur and the founder of ElFares Agricultural Development, the first plant tissue culture lab in Upper Egypt.",
    "subRole": [],
    "personal": {
      "fullName": "Essam Shabaan",
      "firstEmail": "info@elfares.agrikoshk.com",
      "email": "info@elfares.agrikoshk.com",
      "phone": "01553744333",
      "country": "EG",
      "city": "",
      "profilePic": "https://gits.seketak-eg.com/wp-content/uploads/2025/05/ELFARES.png",
      "preferredLanguages": []
    },
    "organization": { "orgName": "Elfares for Agriculture Devlopment", "jobTitle": "CEO", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "https://elfares.agrikoshk.com", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "",
    "subRole": [],
    "personal": {
      "fullName": "",
      "firstEmail": "Company@halifaxmtc.com",
      "email": "Company@halifaxmtc.com",
      "phone": "",
      "country": "EG",
      "city": "",
      "profilePic": "",
      "preferredLanguages": []
    },
    "organization": { "orgName": "", "jobTitle": "", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  },
  {
    "actorType": "",
    "role": "",
    "actorHeadline": "",
    "subRole": [],
    "personal": {
      "fullName": "",
      "firstEmail": "Emad.kader@tridge.com",
      "email": "Emad.kader@tridge.com",
      "phone": "",
      "country": "EG",
      "city": "",
      "profilePic": "",
      "preferredLanguages": []
    },
    "organization": { "orgName": "", "jobTitle": "", "businessRole": "" },
    "matchingIntent": { "objectives": [], "openToMeetings": true },
    "links": { "website": "", "linkedin": "" },
    "id_event": "68ec12fa8c89bd9b5e23d1e0",
    "pwd": "",
    "verified": true,
    "adminVerified": "yes"
  }
]; // <-- IMPORTANT: do not remove this semicolon

function toObjectIdMaybe(v) {
  if (typeof v === 'string' && /^[a-fA-F0-9]{24}$/.test(v)) {
    return new mongoose.Types.ObjectId(v);
  }
  return v;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true','1','yes','y'].includes(v.toLowerCase());
  if (typeof v === 'number') return v === 1;
  return false;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URI;
  if (!uri) {
    console.error('Set MONGODB_URI (or DATABASE_URI) in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✓ connected');

  // light normalization without Mongoose validation
  const docs = DATA.map(d => ({
    ...d,
    id_event: toObjectIdMaybe(d.id_event),
    adminVerified: toBool(d.adminVerified),
  }));

  const res = await Attendee.collection.insertMany(docs, { ordered: false });
  console.log(`✓ inserted ${Object.keys(res.insertedIds).length} docs`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('× insert failed:', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
