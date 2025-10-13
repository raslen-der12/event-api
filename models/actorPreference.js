
/* models/actorPreference.js */
const mongoose = require('mongoose');

module.exports = mongoose.model('actorPreference', new mongoose.Schema({
  actorId      : { type:mongoose.Schema.Types.ObjectId, unique:true },
  language     : { type:String, default:'en' },
  darkMode     : { type:Boolean, default:false },
  muteDMs      : { type:Boolean, default:false },
  createdAt    : { type:Date, default:Date.now },
  updatedAt    : { type:Date }
}, { versionKey:false }));