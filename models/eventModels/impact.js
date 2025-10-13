const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const impactSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Impact title is required'],
      trim: true,
      minlength: 3,
      maxlength: 150
    },
    description: {
      type: String,
      required: [true, 'Impact description is required'],
      trim: true,
      minlength: 10,
      maxlength: 2000
    },
    id_event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'event',
      required: true,
      index: true
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    toJSON:  { virtuals: true },
    toObject:{ virtuals: true }
  }
);

/*──────────────────────── Indexes ───────────────────────*/
impactSchema.index({ id_event: 1, title: 1 });

/*─────────────────────── Hooks ──────────────────────────*/
impactSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventImpact', impactSchema);
