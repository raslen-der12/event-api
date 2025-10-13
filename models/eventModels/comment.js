const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const commentSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: [true, 'Comment text is required'],
      trim: true,
      minlength: 2,
      maxlength: 1000
    },

    verified: { type: Boolean, default: false },

    /* References */
    id_event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'event',
      required: true,
      index: true          // quick lookup by event
    },
    id_actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'actorModel' // dynamic reference
    },
    actorModel: {
      type: String,
      enum: ['speaker', 'attendee', 'exhibitor', 'admin'],
      required: true
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
commentSchema.index({ id_event: 1, createdAt: -1 });   // newest first per event
commentSchema.index({ id_actor: 1, id_event: 1 });     // actor’s comments on an event

/*─────────────────────── Hooks ──────────────────────────*/
commentSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('adminComment', commentSchema);
