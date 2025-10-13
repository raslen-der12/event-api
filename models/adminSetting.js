// models/adminSetting.js
const mongoose = require('mongoose');

module.exports = mongoose.model('adminSetting', new mongoose.Schema({
  key         : { type:String, required:true, unique:true },
  value       : { type:mongoose.Schema.Types.Mixed },
  description : { type:String }
}, { versionKey:false }));
