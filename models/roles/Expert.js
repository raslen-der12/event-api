const mongoose = require('mongoose');

const expertSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'speaker', required: true, unique: true, index: true },
  expertiseTitle: { type: String, required: true, trim: true, maxlength: 120 },
  sector: { type: String, trim: true, maxlength: 80 },
  experienceYears: { type: Number, min: 0 },
  skills: [{ type: String, trim: true, maxlength: 60 }],
  publications: [{ type: String, trim: true, maxlength: 200 }],
  linkedin: { type: String, trim: true, maxlength: 300 },
  availability: { type: String, enum:['Available','Not Available'], default: 'Available' },
  imageUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' },
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleExpert', expertSchema);
