const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const ticketSchema = new mongoose.Schema(
  {
    id_event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'event',
      required: true,
      index: true
    },

    id_actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'actorModel',
      index: true
    },
    actorModel: {
      type: String,
      enum: ['speaker', 'attendee', 'exhibitor', 'admin'],
      required: true
    },

    /* one-to-one link to the financial bill */
    id_bill: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'eventBill',
      required: true,
      index: true,
      unique: true          // one ticket → one bill
    },

    ticketType: {
      type: String,
      enum: ['standard', 'vip', 'student', 'staff'],
      default: 'standard'
    },

    qrCode: {                           // optional pre-generated QR
      type: String,
      trim: true,
      match: [/^https?:\/\/[\w.-]+/, 'Invalid QR code URL']
    },

    checkedIn:    { type: Boolean, default: false },
    checkedInAt:  { type: Date },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    toJSON:  { virtuals: true },
    toObject:{ virtuals: true }
  }
);

/*─────────────────────── Hooks ──────────────────────────*/
ticketSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

ticketSchema.methods.markCheckedIn = function () {
  this.checkedIn = true;
  this.checkedInAt = new Date();
  return this.save();
};

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventTicket', ticketSchema);
