
const mongoose = require('mongoose');

module.exports = mongoose.model('actorNotification', new mongoose.Schema({
  actorId   : { type:mongoose.Schema.Types.ObjectId, index:true },
  title     : { type:String, required:true  },
  body      : { type:String                 },
  link      : { type:String                 },
  priority  : { type:Number, min:1 , max:8 },
  read      : { type:Boolean, default:false },
  createdAt : { type:Date, default:Date.now },
}, { versionKey:false }));