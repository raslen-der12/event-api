// models/BPFacets.js
const mongoose = require('mongoose');

const BPFacetsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    countries: { type: [String], default: [] },  // plain names
    languages: { type: [String], default: [] },  // plain names
  },
  { timestamps: true }
);

module.exports = mongoose.model('BPFacets', BPFacetsSchema);
