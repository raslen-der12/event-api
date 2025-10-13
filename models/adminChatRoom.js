// models/adminChatRoom.js
const mongoose = require('mongoose');

const adminChatRoomSchema = new mongoose.Schema({
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'admin', required: true, index: true },
  actorId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actorRole: { type: String, enum: ['attendee','exhibitor','speaker'], required: true },
  lastMsgAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { versionKey:false });

adminChatRoomSchema.index({ adminId:1, actorId:1, actorRole:1 }, { unique:true });

module.exports = mongoose.model('adminChatRoom', adminChatRoomSchema);
