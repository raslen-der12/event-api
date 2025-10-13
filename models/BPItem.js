// models/bpItem.js  (merged Products + Services)
const mongoose = require('mongoose');

const bpItemSchema = new mongoose.Schema({
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessProfile', index: true, required: true },
  // "product" | "service"
  kind: { type: String, enum: ['product','service'], required: true, index: true },

  sector: { type: String, trim: true, lowercase: true, index: true },
  subsectorId: { type: mongoose.Schema.Types.ObjectId, index: true }, // points to taxonomy.subsectors._id (optional mirror)
  subsectorName: { type: String, trim: true, lowercase: true },      // denormalized for search

  title: { type: String, trim: true, maxlength: 160, required: true },
  summary: { type: String, trim: true, maxlength: 600 },
  details: { type: String, trim: true, maxlength: 8000 },
  tags: { type: [String], default: [], index: true },

  // media
  thumbnailUpload: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' },
  images: { type: [String], default: []  },

  // commercial notes
  pricingNote: { type: String, trim: true, maxlength: 500 },

  // visibility
  published: { type: Boolean, default: true },

  // soft moderation flags (admin)
  adminFlags: {
    hidden: { type: Boolean, default: false },
    reason: { type: String, trim: true, maxlength: 200 },
  }
}, { timestamps: true });

module.exports = mongoose.model('bPItem', bpItemSchema);
