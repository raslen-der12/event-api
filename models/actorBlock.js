const mongoose = require('mongoose');
module.exports = mongoose.model('actorBlock', new mongoose.Schema({
  blockerId : { type:mongoose.Schema.Types.ObjectId, index:true },
  blockedId : { type:mongoose.Schema.Types.ObjectId, index:true },
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));