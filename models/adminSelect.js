// models/adminSelect.js
const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true, trim: true, maxlength: 120 },
    value: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { _id: false }
);

const adminSelectSchema = new mongoose.Schema(
  {
    page: { type: String, required: true, trim: true, maxlength: 120, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 }, // "select name"
    options: { type: [optionSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Ensure (page, name) uniqueness
adminSelectSchema.index({ page: 1, name: 1 }, { unique: true });

adminSelectSchema.pre('save', function(next){
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('adminSelect', adminSelectSchema);
