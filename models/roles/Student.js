const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'attendee', required: true, unique: true, index: true },
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  university: { type: String, required: true, trim: true, maxlength: 160 },
  fieldOfStudy: { type: String, required: true, trim: true, maxlength: 120 },
  graduationYear: { type: Number, min: 1900, max: 2100 },
  skills: [{ type: String, trim: true, maxlength: 60 }],
  interests: [{ type: String, trim: true, maxlength: 60 }],
  portfolio: { type: String, trim: true, maxlength: 300 },
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleStudent', studentSchema);
