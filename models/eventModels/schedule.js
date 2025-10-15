// models/eventSchedule.js
const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  sessionTitle: {
    type: String, required: [true, 'Session title is required'], trim: true, minlength: 3, maxlength: 150
  },

  // allow single or multiple speakers
  speaker: { type: mongoose.Schema.Types.ObjectId, ref: 'speaker' },
  speakers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'speaker' }],

  room: { type: String, trim: true, maxlength: 50 },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'programRoom', default: null },

  track: { type: String, trim: true, default: '' },
  tags:  { type: [String], default: [] },

  startTime: { type: Date, required: [true, 'Start time is required'] },
  endTime:   { type: Date, required: [true, 'End time is required'] },

  // registration controls
  allowRegistration: { type: Boolean, default: true },
  allowedRoles: {
    type: [String],
    enum: ['attendee','exhibitor','speaker'],
    default: ['attendee','exhibitor','speaker']
  },
  capacity: { type: Number, default: 0 }, // 0 = unlimited
  seatsTaken:{type: Number, default :0 },
  registrationOpenAt:  { type: Date, default: null },
  registrationCloseAt: { type: Date, default: null },

  id_event: { type: mongoose.Schema.Types.ObjectId, ref: 'event', required: true, index: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
},{
  versionKey: false,
  toJSON:  { virtuals: true },
  toObject:{ virtuals: true }
});

scheduleSchema.pre('save', function (next) {
  if (this.endTime <= this.startTime) return next(new Error('endTime must be after startTime'));
  this.updatedAt = Date.now();
  next();
});

scheduleSchema.index({ id_event: 1, startTime: 1 });
scheduleSchema.index({ id_event: 1, track: 1 });
scheduleSchema.index({ startTime: 1, endTime: 1 });

module.exports = mongoose.model('eventSchedule', scheduleSchema);
