/* models/actorMessageReaction.js */
const mongoose = require('mongoose');
module.exports = mongoose.model('actorMessageReaction', new mongoose.Schema({
  msgId  : { type:mongoose.Schema.Types.ObjectId, ref:'actorChatMessage', index:true },
  userId : { type:mongoose.Schema.Types.ObjectId, index:true },
  emoji  : { type:String },                       // 👍 ❤️ 😂 etc.
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));


