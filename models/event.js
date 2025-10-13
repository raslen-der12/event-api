// models/event.js
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    /* ─── Core details ─────────────────────────────────────────────────────── */
    title: {
      type: String,
      required: [true, 'Event title is required'],
      trim: true,
      minlength: 3,
      maxlength: 100,
      unique: true
    },
    slug: {
      type: String,
      index: true
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: 20,
      maxlength: 5000
    },
    cover: {
      type: String,
      required: [true, 'Cover image is required'],
      trim: true,
    },

    /* ─── Timing ───────────────────────────────────────────────────────────── */
    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },
    registrationDeadline: { type: Date },

    /* ─── Location ─────────────────────────────────────────────────────────── */
    venueName:  { type: String, trim: true, minlength: 3, maxlength: 100 },
    address:    { type: String, trim: true, minlength: 5, maxlength: 200 },
    city:       { type: String, trim: true, minlength: 2, maxlength: 100 },
    state:      { type: String, trim: true, minlength: 2, maxlength: 100 },
    country:    { type: String, trim: true, minlength: 2, maxlength: 100 },
    mapLink:    { type: String, trim: true, match: /^https?:\/\/.+/ },
    target :    { type: String, required: true },

    /* ─── Media / branding f─────────────────────────────────────────────────── */

    /* ─── Capacity & metrics ───────────────────────────────────────────────── */
    capacity: { type: Number, min: 1 },
    seatsTaken: { type: Number, default: 0, min: 0 },

    /* ─── Status flags ─────────────────────────────────────────────────────── */
    isPublished: { type: Boolean, default: false },
    isCancelled: { type: Boolean, default: false },

    /* ─── Metadata ─────────────────────────────────────────────────────────── */
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/* ─── Indexes ─────────────────────────────────────────────────────────────── */
eventSchema.index({ startDate: 1 });
eventSchema.index({ slug: 1, startDate: 1 }, { unique: true });

/* ─── Hooks ───────────────────────────────────────────────────────────────── */
eventSchema.pre('save', function (next) {
  /* keep updatedAt fresh */
  this.updatedAt = Date.now();

  /* generate slug on first save or if title changes */
  if (this.isModified('title')) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');
  }

  /* ensure endDate is after startDate */
  if (this.endDate <= this.startDate) {
    return next(new Error('endDate must be after startDate'));
  }

  /* ensure registrationDeadline (if provided) is before event start */
  if (this.registrationDeadline && this.registrationDeadline >= this.startDate) {
    return next(new Error('registrationDeadline must be before startDate'));
  }

  /* capacity sanity */
  if (this.capacity && this.seatsTaken > this.capacity) {
    return next(new Error('seatsTaken cannot exceed capacity'));
  }

  next();
});

module.exports = mongoose.model('event', eventSchema);
