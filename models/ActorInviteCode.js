// models/ActorInviteCode.js
const mongoose = require('mongoose');

const ActorInviteCodeSchema = new mongoose.Schema({
  eventId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Event', index: true, default: null },
  actorId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actorRole: { type: String, required: true, enum: ['attendee','exhibitor','speaker'], index: true },
  code:      { type: String, required: true, unique: true, index: true },
  usageCount:{ type: Number, default: 0 },
  enabled:   { type: Boolean, default: true },
}, { timestamps: true });

ActorInviteCodeSchema.index({ actorId: 1, actorRole: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.models.ActorInviteCode || mongoose.model('ActorInviteCode', ActorInviteCodeSchema);
