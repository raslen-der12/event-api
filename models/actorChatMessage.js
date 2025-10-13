const mongoose = require('mongoose');

module.exports = mongoose.model('actorChatMessage', new mongoose.Schema({
  roomId    : { type:mongoose.Schema.Types.ObjectId, ref:'actorChatRoom', index:true },
  senderId  : { type:mongoose.Schema.Types.ObjectId, required:true },
  text      : { type:String },
  files     : { type:[String] },      // URLs of uploaded attachments
  seenBy    : { type:[mongoose.Schema.Types.ObjectId], default:[] }, // read receipts
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));
