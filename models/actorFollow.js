const mongoose = require('mongoose');


module.exports = mongoose.model('actorFollow', new mongoose.Schema({
  followerId : { type:mongoose.Schema.Types.ObjectId, index:true },
  followeeId : { type:mongoose.Schema.Types.ObjectId, index:true },
  createdAt  : { type:Date, default:Date.now }
}, { versionKey:false }));