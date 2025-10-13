// models/actorSanction.js
const mongoose = require('mongoose');

const sanctionSchema = new mongoose.Schema({
  actorId   : { type: mongoose.Schema.Types.ObjectId, ref: 'attendee', required: true, index: true }, // works for any role id
  type      : { type: String, enum: ['mute', 'ban'], required: true },
  // scope: 'global' or a specific roomId (ObjectId)
  scopeGlobal: { type: Boolean, default: false, index: true },
  roomId    : { type: mongoose.Schema.Types.ObjectId, ref: 'actorchatroom', index: true },
  reason    : { type: String, trim: true, maxlength: 500 },
  expiresAt : { type: Date, default: null, index: true }, // null = until removed
  createdBy : { type: mongoose.Schema.Types.ObjectId, ref: 'admin', required: true },
  createdAt : { type: Date, default: Date.now }
}, { versionKey: false });

sanctionSchema.index({ actorId: 1, type: 1, scopeGlobal: 1, roomId: 1, expiresAt: 1 });

module.exports = mongoose.model('actorSanction', sanctionSchema);
