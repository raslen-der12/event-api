const mongoose = require('mongoose');

module.exports = mongoose.model('eventComment', new mongoose.Schema({
  eventId   : { type:mongoose.Schema.Types.ObjectId, ref:'event', index:true },
  actorId   : { type:mongoose.Schema.Types.ObjectId, required:true },
  actorRole : { type:String, enum:['attendee','exhibitor','speaker'] },
  parentId  : { type:mongoose.Schema.Types.ObjectId, ref:'eventComment', default:null }, // threaded
  text      : { type:String, required:true, trim:true, minlength:2 },
  verified  : { type:Boolean, default:false },  // admin must approve
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));
