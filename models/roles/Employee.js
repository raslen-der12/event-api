const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'attendee', required: true, unique: true, index: true },
  currentPosition: { type: String, required: true, trim: true, maxlength: 120 },
  companyName: { type: String, required: true, trim: true, maxlength: 160 },
  experienceYears: { type: Number, min: 0 },
  skills: [{ type: String, trim: true, maxlength: 60 }],
  careerGoals: { type: String, trim: true, maxlength: 300 },
  education: { type: String, trim: true, maxlength: 160 },
  companyLogoUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' },
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleEmployee', employeeSchema);
