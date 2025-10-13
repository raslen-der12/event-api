const mongoose = require('mongoose');
module.exports = mongoose.model('actorUpload', new mongoose.Schema({
  actorId   : { type:mongoose.Schema.Types.ObjectId },
  roomId    : { type:mongoose.Schema.Types.ObjectId },
  url       : { type:String, required:true },
  mime      : { type:String },
  size      : { type:Number },
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));