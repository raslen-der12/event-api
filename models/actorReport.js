const mongoose = require('mongoose');

module.exports = mongoose.model('actorReport', new mongoose.Schema({
  reporterId   : { type:mongoose.Schema.Types.ObjectId, required:true },
  reportedId   : { type:mongoose.Schema.Types.ObjectId, required:true },
  reason       : { type:String, required:true, trim:true, minlength:3 },
  status       : { type:String, enum:['pending','reviewed','dismissed'], default:'pending' },
  adminNotes   : { type:String },
  createdAt    : { type:Date, default:Date.now },
  closedAt     : { type:Date }
}, { versionKey:false }));
