

const mongoose = require("mongoose");

mongoose.model(
    "eventCheckin",
    new mongoose.Schema(
      {
        eventId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
        actorId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
        actorRole: {
          type: String,
          enum: ["attendee", "exhibitor", "speaker", "admin"],
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, index: true },
      },
      { versionKey: false, timestamps: false }
    )
  );