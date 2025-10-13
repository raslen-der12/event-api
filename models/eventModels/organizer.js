const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const organizerSchema = new mongoose.Schema(
  {
    logo: {
      type: String,
      required: [true, 'Logo URL is required'],
      trim: true,
      match: [/^https?:\/\/[\w.-]+/, 'Invalid logo URL']
    },
    link: {
      type: String,
      trim: true,
      match: [/^https?:\/\/[\w.-]+/, 'Invalid link URL']
    },
    type: {
      type: String,
      enum: ['host', 'co-host', 'sponsor', 'partner', 'media'],
      default: 'host'
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
organizerSchema.index({ id_event: 1, type: 1 });

/*─────────────────────── Hooks ──────────────────────────*/
organizerSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventOrganizer', organizerSchema);
