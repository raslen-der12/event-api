// scripts/seedBpFacets.js
require('dotenv').config();
const mongoose = require('mongoose');
const BPFacets = require('../models/BPFacets');

const COUNTRIES = [
  // keep it short; add more as needed (names, not codes)
  'Tunisia','France','Germany','Italy','Spain','Morocco','Algeria','Egypt',
  'United Kingdom','United States','Canada','UAE','Saudi Arabia','Turkey'
];

const LANGUAGES = [
  'Arabic','French','English'
];

(async () => {
  const uri = process.env.DATABASE_URI
  if (!uri) throw new Error('Set MONGO_URI or MONGODB_URI in .env');

  await mongoose.connect(uri);

  const up = await BPFacets.findOneAndUpdate(
    { key: 'global' },
    { $set: { countries: COUNTRIES, languages: LANGUAGES } },
    { upsert: true, new: true }
  );

  console.log('BP facets upserted:', {
    countries: up.countries.length,
    languages: up.languages.length,
  });

  await mongoose.disconnect();
  console.log('Done.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
