const mongoose = require('mongoose');

const investorSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'attendee', required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 }, // individual or fund
  investorType: { type: String, enum: ['Individual','Fund','Angel','VC'], required: true },
  focusSectors: [{ type: String, trim: true, maxlength: 60 }],
  ticketMin: { type: Number, min: 0 },
  ticketMax: { type: Number, min: 0 },
  stagePreference: [{ type: String, trim: true, maxlength: 40 }], // Idea/MVP/Growth/Scale
  countryPreference: [{ type: String, trim: true, uppercase: true, maxlength: 2 }],
  website: { type: String, trim: true, maxlength: 300 },
  linkedin: { type: String, trim: true, maxlength: 300 },
  portfolio: [{ type: String, trim: true, maxlength: 200 }], // names/links
  contactEmail: { type: String, trim: true, lowercase: true, maxlength: 120 },
  contactPhone: { type: String, trim: true, maxlength: 40 },
  logoUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' },
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleInvestor', investorSchema);
