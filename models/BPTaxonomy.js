// models/BPTaxonomy.js
const mongoose = require('mongoose');

const subsectorSchema = new mongoose.Schema({
  name: { type: String, trim: true, lowercase: true, required: true },
  allowProducts: { type: Boolean, default: true },
  allowServices: { type: Boolean, default: true },
}, { _id: true, timestamps: false });

const bpTaxonomySchema = new mongoose.Schema({
  // e.g. "agriculture", "fintech", "ai", ...
  sector: { type: String, trim: true, lowercase: true, required: true, unique: true, index: true },

  // array of subcategories in that sector
  subsectors: { type: [subsectorSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('BPTaxonomy', bpTaxonomySchema);
