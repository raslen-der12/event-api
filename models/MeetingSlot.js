// models/MeetingSlot.js
const mongoose = require('mongoose');

const MeetingSlotSchema = new mongoose.Schema({
  eventId:   { type: mongoose.Schema.Types.ObjectId, ref: 'event', required: true, index: true },
  slotISO:   { type: Date, required: true, index: true },         // exact instant (UTC) for the 30-min slot
  used:      { type: Number, default: 0 },                        // how many meetings occupy this slot
  cap:       { type: Number, default: 40 },                       // max allowed in B2B room for this slot
}, { timestamps: true });

// Keep one doc per (eventId, slotISO)
MeetingSlotSchema.index({ eventId: 1, slotISO: 1 }, { unique: true });

module.exports = mongoose.models.MeetingSlot || mongoose.model('MeetingSlot', MeetingSlotSchema);
