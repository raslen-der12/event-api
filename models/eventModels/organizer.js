// models/eventOrganizer.js
const mongoose = require('mongoose');

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
      trim: true, // keep whatever the backend sends; UI will adapt
      default: 'partner'
    },
    order: {
      type: Number,
      default: 0
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

/* Indexes */
organizerSchema.index({ id_event: 1, type: 1, order: 1 });

/* Hooks */
organizerSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

/* Helper: fetch by event with order (0 goes last) */
organizerSchema.statics.findByEventSorted = function(eventId) {
  return this.aggregate([
    { $match: { id_event: new mongoose.Types.ObjectId(eventId) } },
    { $addFields: {
        _orderKey: {
          $cond: [{ $eq: ['$order', 0] }, Number.MAX_SAFE_INTEGER, '$order']
        }
      }
    },
    { $sort: { _orderKey: 1, _id: 1 } }
  ]);
};

module.exports = mongoose.model('eventOrganizer', organizerSchema);
