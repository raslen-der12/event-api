const mongoose = require('mongoose');

const BPProfileRatingSchema = new mongoose.Schema(
  {
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessProfile', index: true, required: true },
    rater:   { type: mongoose.Schema.Types.ObjectId, ref: 'Actor', index: true }, // your user/actor model
    value:   { type: Number, min: 1, max: 5, required: true },
  },
  { timestamps: true }
);

// One rater can rate a profile once (latest wins)
BPProfileRatingSchema.index({ profile: 1, rater: 1 }, { unique: true });

module.exports = mongoose.model('BPProfileRating', BPProfileRatingSchema);
