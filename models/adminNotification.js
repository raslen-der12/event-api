// models/adminNotification.js
const mongoose = require('mongoose');

/**
 * One document per notification pushed to an admin.
 * Typical producers:
 *   • new chat message @mentions
 *   • ticket refund requested
 *   • meeting request flagged
 */
const adminNotificationSchema = new mongoose.Schema({
  adminId   : { type:mongoose.Schema.Types.ObjectId, ref:'admin', index:true },
  title     : { type:String, required:true },
  body      : { type:String },
  link      : { type:String },      // deep-link that the front-end can open
  read      : { type:Boolean, default:false },
  createdAt : { type:Date,    default:Date.now }
}, { versionKey:false });

module.exports = mongoose.model('adminNotification', adminNotificationSchema);
