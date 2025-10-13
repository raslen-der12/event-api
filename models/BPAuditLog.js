// models/BPAuditLog.js
const mongoose = require('mongoose');

const bpAuditLogSchema = new mongoose.Schema({
  actorId  : { type: mongoose.Schema.Types.ObjectId, index: true },            // admin/mod who did the action
  actorRole: { type: String, default: 'admin' },
  target   : {                                                                  // what was touched
    kind : { type: String, enum: ['profile','item'], required: true },
    id   : { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    extra: { type: Object, default: {} }
  },
  action   : { type: String, required: true },                                  // e.g. publish|unpublish|feature|hide-item|delete
  diff     : { type: Object, default: {} },                                     // before/after snippets if you want
  note     : { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('BPAuditLog', bpAuditLogSchema);
