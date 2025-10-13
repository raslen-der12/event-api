const mongoose = require('mongoose');
module.exports = mongoose.model('actorBookmark', new mongoose.Schema({
  actorId : { type:mongoose.Schema.Types.ObjectId, index:true },
  eventId : { type:mongoose.Schema.Types.ObjectId, index:true },
  createdAt: { type:Date, default:Date.now }
}, { versionKey:false }));