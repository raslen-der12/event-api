// models/EventManagerApplication.js
const mongoose = require('mongoose');

const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const EventManagerApplicationSchema = new mongoose.Schema(
  {
    /** Link to platform user / actor
     *  Adjust according to your auth system.
     *  - user: generic user account (if you have one)
     *  - actor: attendee profile (like other role* models)
     */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'attendee',
      index: true,
    },

    // Basic status workflow
    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected'],
      default: 'Pending',
      index: true,
    },

    // Plan selection (from frontend PLANS)
    planId: {
      type: String,
      trim: true,
      required: true,
    },
    planLabel: {
      type: String,
      trim: true,
      required: true,
    },

    // Organizer details
    organizerType: {
      type: String,
      trim: true,
      enum: ['company', 'ngo', 'university', 'individual'],
      default: 'company',
    },
    orgName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    website: {
      type: String,
      trim: true,
      maxlength: 600,
    },
    country: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    city: {
      type: String,
      trim: true,
      maxlength: 100,
    },

    workEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      match: EMAIL_RX,
      maxlength: 160,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 60,
    },

    // Event details
    eventName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    eventMonth: {
      type: String,
      trim: true,
      required: true,
      maxlength: 80, // e.g. "March 2026"
    },
    eventMode: {
      type: String,
      trim: true,
      enum: ['physical', 'virtual', 'hybrid'],
      default: 'physical',
    },
    expectedSize: {
      type: String,
      trim: true,
      maxlength: 40, // "0-200", "2000+"
    },
    sectors: {
      type: String,
      trim: true,
      maxlength: 600,
    },

    // Modules requested
    needsTicketing: {
      type: Boolean,
      default: true,
    },
    needsB2B: {
      type: Boolean,
      default: true,
    },
    needsMarketplace: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },

    // Admin review
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'admin',
    },
    reviewedAt: {
      type: Date,
    },
    reviewNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indices to make lookups easier
EventManagerApplicationSchema.index({ user: 1, status: 1 });
EventManagerApplicationSchema.index({ actor: 1, status: 1 });
EventManagerApplicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model(
  'eventManagerApplication',
  EventManagerApplicationSchema
);
