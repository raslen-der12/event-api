// models/HybridMeetingSlot.js
const mongoose = require('mongoose');

const HybridMeetingSlotSchema = new mongoose.Schema({
  eventId : { type: mongoose.Schema.Types.ObjectId, ref: 'event', required: true, index: true },
  slotISO : { type: Date, required: true, index: true }, // exact 30-min instant (UTC)
  used    : { type: Number, default: 0 },
  cap     : { type: Number, default: 0 },                // cap = Event.postsCount
}, { timestamps: true });

// one doc per (eventId, slotISO)
HybridMeetingSlotSchema.index({ eventId: 1, slotISO: 1 }, { unique: true });

module.exports = mongoose.models.HybridMeetingSlot || mongoose.model('HybridMeetingSlot', HybridMeetingSlotSchema);
