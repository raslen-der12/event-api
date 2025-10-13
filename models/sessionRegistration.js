// models/sessionRegistration.js
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const sessionRegistrationSchema = new Schema({
  sessionId: { type: Types.ObjectId, ref: 'eventSchedule', required: true, index: true },
  eventId:   { type: Types.ObjectId, ref: 'event', required: true, index: true },

  actorId:   { type: Types.ObjectId, required: true, index: true },
  actorRole: { type: String, enum: ['attendee','exhibitor','speaker','admin'], required: true },

  status:    { type: String, enum: ['registered','waitlisted','cancelled'], default: 'registered', index: true },

  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

sessionRegistrationSchema.index({ sessionId: 1, actorId: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $ne: 'cancelled' } }
});

module.exports = mongoose.model('sessionRegistration', sessionRegistrationSchema);
