const mongoose = require("mongoose");

const OptionSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true, trim: true }, // stable id (slug/uuid)
    label: { type: String, required: true, trim: true },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const PollSchema = new mongoose.Schema(
  {
    title:      { type: String, required: true, trim: true },
    options:    { type: [OptionSchema], validate: v => Array.isArray(v) && v.length >= 2 },
    // lifecycle
    startsAt:   { type: Date, default: null },   // optional schedule (info)
    startedAt:  { type: Date, default: null },   // when admin pressed "start"
    endsAt:     { type: Date, default: null },   // absolute end (set at start if durationSec present)
    durationSec:{ type: Number, default: 0 },    // if >0, endsAt = startedAt + durationSec
    autoStop:   { type: Boolean, default: false },
    stoppedAt:  { type: Date, default: null },
    // policy
    allowMultiple: { type: Boolean, default: false }, // per voterId
    public:        { type: Boolean, default: true },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

PollSchema.index({ endsAt: 1 });
PollSchema.index({ startedAt: 1, stoppedAt: 1 });

module.exports = mongoose.model("Poll", PollSchema);
