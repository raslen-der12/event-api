// models/adminActivity.js
const mongoose = require('mongoose');

module.exports = mongoose.model('adminActivity', new mongoose.Schema({
  adminId    : { type:mongoose.Schema.Types.ObjectId, ref:'admin', index:true },
  ip         : { type:String },
  ua         : { type:String },               // user-agent
  action     : { type:String },               // 'login', 'updateEvent', …
  target     : { type:String },               // collection or resource
  targetId   : { type:mongoose.Schema.Types.ObjectId },
  payload    : { type:mongoose.Schema.Types.Mixed },
  createdAt  : { type:Date, default:Date.now }
}, { versionKey:false }));
