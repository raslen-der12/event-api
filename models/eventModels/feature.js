const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const featureSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Feature title is required'],
      trim: true,
      minlength: 3,
      maxlength: 100
    },
    subtitle: {
      type: String,
      trim: true,
      maxlength: 150
    },
    desc: {
      type: String,
      required: [true, 'Feature description is required'],
      trim: true,
      minlength: 10,
      maxlength: 1500
    },
    image: {
      type: String,
      trim: true,
      match: [/^https?:\/\/[\w.-]+/, 'Invalid image URL']
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
featureSchema.index({ id_event: 1, title: 1 });

/*─────────────────────── Hooks ──────────────────────────*/
featureSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventFeature', featureSchema);
