// models/meetRequest.js
const mongoose = require('mongoose');

const STATUS_ENUM = ['pending', 'accepted', 'declined', 'reschedule-proposed', 'cancelled'];

const historySchema = new mongoose.Schema({
  at      : { type:Date, default:Date.now },
  actorId : mongoose.Schema.Types.ObjectId,  // who did the action
  action  : String,                          // "sent", "accepted", "declined", "proposed:newDate"
  note    : String
}, { _id:false });

const meetRequestSchema = new mongoose.Schema({
  /* ─── relationships ───────────────────────────────────────────────── */
  eventId      : { type:mongoose.Schema.Types.ObjectId, ref:'event', required:true },
  senderId     : { type:mongoose.Schema.Types.ObjectId, required:true },
  senderRole   : { type:String, enum:['attendee','exhibitor','speaker','admin'], required:true },
  receiverId   : { type:mongoose.Schema.Types.ObjectId, required:true },
  receiverRole : { type:String, enum:['attendee','exhibitor','speaker','admin'], required:true },

  /* ─── business payload ────────────────────────────────────────────── */
  subject      : { type:String, required:true, trim:true, minlength:3 },
  message      : { type:String },
  requestedAt  : { type:Date, required:true },        // initial proposal
  acceptedAt   : { type:Date },                       // final locked slot
  status       : { type:String, enum:STATUS_ENUM, default:'pending' },

  /* If receiver proposes a new slot, we store it here until accepted */
  proposedNewAt: { type:Date },

  /* Optional meeting room ID if the organiser pre-allocates rooms */
  roomId       : { type:String },

  /* tiny audit trail */
  history      : { type:[historySchema], default:[] }
}, { versionKey:false, timestamps:true });

/* helper virtual: isFinalised */
meetRequestSchema.virtual('isFinalised').get(function () {
  return this.status === 'accepted';
});

module.exports = mongoose.model('meetRequest', meetRequestSchema);
