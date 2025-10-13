// models/adminChatMessage.js
const mongoose = require('mongoose');

const adminChatMessageSchema = new mongoose.Schema({
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref:'adminChatRoom', required:true, index:true },
  senderType: { type: String, enum:['admin','actor'], required:true },
  senderId:   { type: mongoose.Schema.Types.ObjectId, required:true },
  text:       { type: String, default:'' },
  files:      { type: [String], default: [] }, // store URLs/paths
  seenBy:     { type: [mongoose.Schema.Types.ObjectId], default: [] },
  createdAt:  { type: Date, default: Date.now }
}, { versionKey:false });

adminChatMessageSchema.index({ roomId:1, _id:1 });

module.exports = mongoose.model('adminChatMessage', adminChatMessageSchema);
