const mongoose = require('mongoose');

const ALLOWED_PARENT_MODELS = Object.freeze([
  'roleExpert',         // Expert.js
  'roleBusinessOwner',  // BusinessOwner.js  (== employer)
  'roleConsultant',     // Consultant.js
]);

const evidenceSchema = new mongoose.Schema({
  kind: { type: String, enum: ['file','url','text'], required: true },
  fileUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' }, // when kind='file'
  url:  { type: String, trim: true, maxlength: 600 },                        // when kind='url'
  note: { type: String, trim: true, maxlength: 600 },                        // optional context
}, { _id: false });

const subRoleSchema = new mongoose.Schema({
  parentModel: { type: String, enum: ALLOWED_PARENT_MODELS, required: true, index: true }, // refPath
  parent:      { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'parentModel', index: true },

  name:       { type: String, required: true, trim: true, maxlength: 120 },
  nameLower:  { type: String, required: true, trim: true, maxlength: 120 }, // for uniqueness per parent
  description:{ type: String, trim: true, maxlength: 600 },

  // Evidence and verification workflow
  evidence:   { type: [evidenceSchema], default: [] },
  status:     { type: String, enum: ['Pending','Verified','Rejected'], default: 'Pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'admin' },
  reviewedAt: { type: Date },
  reviewNotes:{ type: String, trim: true, maxlength: 600 },

  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
}, { versionKey: false });

subRoleSchema.pre('validate', function(next){
  if (this.name) this.nameLower = String(this.name).toLowerCase().trim();
  next();
});

subRoleSchema.index({ parentModel:1, parent:1, nameLower:1 }, { unique: true }); // no duplicates per parent
subRoleSchema.pre('save', function(next){ this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('roleSubRole', subRoleSchema);
