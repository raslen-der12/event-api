const mongoose = require('mongoose');

module.exports = mongoose.model('actorChatRoom', new mongoose.Schema({
  /*
   * One-to-one OR group chat between actors (attendee / exhibitor / speaker).
   * If exactly two members ⇒ treat as DM.
   */
  members   : { type:[mongoose.Schema.Types.ObjectId], required:true, index:true },
  isGroup   : { type:Boolean, default:false },
  title     : { type:String },         // optional group name
  createdAt : { type:Date,   default:Date.now }
}, { versionKey:false }));
