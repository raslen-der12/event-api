const mongoose = require('mongoose');

const consultantSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'attendee', required: true, unique: true, index: true },
  expertiseArea: { type: String, required: true, trim: true, maxlength: 120 },
  sectors: [{ type: String, trim: true, maxlength: 60 }],
  experienceYears: { type: Number, min: 0 },
  certifications: [{ type: String, trim: true, maxlength: 120 }],
  servicesOffered: [{ type: String, trim: true, maxlength: 80 }],
  hourlyRate: { type: Number, min: 0 },
  portfolioLinks: [{ type: String, trim: true, maxlength: 300 }],
  availability: { type: String, enum:['Available','Not Available'], default:'Available' },
  imageUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' },
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleConsultant', consultantSchema);
