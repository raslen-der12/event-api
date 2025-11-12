const mongoose = require("mongoose");

const PollVoteSchema = new mongoose.Schema(
  {
    pollId:    { type: mongoose.Schema.Types.ObjectId, ref: "Poll", required: true, index: true },
    optionKey: { type: String, required: true, trim: true },
    // Optional identity/fingerprint
    voterId:   { type: String, default: null, index: true }, // e.g., user/actor id or client-generated UUID
    ip:        { type: String, default: null },
    ua:        { type: String, default: null },
  },
  { timestamps: true }
);

// enforce "one vote per voterId per poll" WHEN voterId is provided
PollVoteSchema.index({ pollId: 1, voterId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("PollVote", PollVoteSchema);
