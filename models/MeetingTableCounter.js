// models/MeetingTableCounter.js
const mongoose = require('mongoose');

const MeetingTableCounterSchema = new mongoose.Schema({
  eventId : { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  slotISO : { type: Date, required: true, index: true },
  next    : { type: Number, default: 0 }, // increments on confirms to allocate a stable table index
}, { timestamps: true });

MeetingTableCounterSchema.index({ eventId: 1, slotISO: 1 }, { unique: true });

module.exports = mongoose.models.MeetingTableCounter
  || mongoose.model('MeetingTableCounter', MeetingTableCounterSchema);
