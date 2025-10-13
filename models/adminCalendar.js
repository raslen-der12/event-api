// models/adminCalendar.js
const mongoose = require('mongoose');

module.exports = mongoose.model('adminCalendar', new mongoose.Schema({
  adminId   : { type:mongoose.Schema.Types.ObjectId, ref:'admin', index:true },
  title     : { type:String, required:true },
  start     : { type:Date, required:true },
  end       : { type:Date, required:true },
  location  : { type:String },
  notes     : { type:String },
  createdAt : { type:Date, default:Date.now }
}, { versionKey:false }));
