const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const gallerySchema = new mongoose.Schema(
  {
    file: {
      type: String,
      required: [true, 'File URL is required'],
      trim: true,
      match: [/^https?:\/\/[\w.-]+/, 'Invalid file URL']
    },
    title: {
      type: String,
      trim: true,
      maxlength: 100
    },
    type: {
      type: String,
      enum: ['image', 'video', 'pdf'],
      default: 'image'
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
gallerySchema.index({ id_event: 1, createdAt: -1 });

/*─────────────────────── Hooks ──────────────────────────*/
gallerySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventGallery', gallerySchema);
