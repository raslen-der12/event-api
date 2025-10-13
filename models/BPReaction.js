// models/BPReaction.js
const mongoose = require('mongoose');

const bpReactionSchema = new mongoose.Schema({
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessProfile', index: true, required: true },
  actor  : { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  type   : { type: String, enum: ['like'], default: 'like', index: true },
}, { timestamps: true });

bpReactionSchema.index({ profile: 1, actor: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('BPReaction', bpReactionSchema);
