const mongoose = require('mongoose');

module.exports = mongoose.model('actorSupportTicket', new mongoose.Schema({
  actorId   : { type:mongoose.Schema.Types.ObjectId, required:true },
  subject   : { type:String, required:true },
  message   : { type:String, required:true },
  status    : { type:String, enum:['open','in-progress','closed'], default:'open' },
  adminId   : { type:mongoose.Schema.Types.ObjectId, ref:'admin' }, // who is handling
  createdAt : { type:Date, default:Date.now },
  updatedAt : { type:Date }
}, { versionKey:false }));
