// models/meetSlotIndex.js
const mongoose = require('mongoose');

/**
 * One document == one occupied 30-minute slot for one actor in one event.
 * We insert a doc when a request becomes `accepted`.
 * We delete it if the meeting is declined/cancelled.
 */
const meetSlotIndexSchema = new mongoose.Schema({
  eventId : { type:mongoose.Schema.Types.ObjectId, ref:'event', index:true },
  actorId : { type:mongoose.Schema.Types.ObjectId, index:true },
  slotISO : { type:String, index:true }   // "2025-11-04T09:00:00.000Z"
}, { versionKey:false });

/* Composite unique key prevents double-booking */
meetSlotIndexSchema.index({ eventId:1, actorId:1, slotISO:1 }, { unique:true });

module.exports = mongoose.model('meetSlotIndex', meetSlotIndexSchema);
