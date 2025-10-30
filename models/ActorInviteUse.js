// models/ActorInviteUse.js
const mongoose = require('mongoose');
const ActorInviteUseSchema = new mongoose.Schema({
  codeId:            { type: mongoose.Schema.Types.ObjectId, ref: 'ActorInviteCode', required: true, index: true },
  inviteCode:        { type: String, required: true, index: true },
  registeredActorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  registeredRole:    { type: String, required: true, enum: ['attendee','exhibitor','speaker'] },
  eventId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null, index: true },
}, { timestamps: true });

ActorInviteUseSchema.index({ codeId: 1, registeredActorId: 1 }, { unique: true });

module.exports = mongoose.models.ActorInviteUse || mongoose.model('ActorInviteUse', ActorInviteUseSchema);
