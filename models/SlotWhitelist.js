const mongoose = require('mongoose');
const { Schema } = mongoose;

const SlotWhitelistSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, required: true, index: true }, // attendee/exhibitor/speaker _id
  // store normalized 30-min UTC instants
  slots:   [{ type: Date, required: true }]
}, { timestamps: true });

SlotWhitelistSchema.index({ eventId:1, actorId:1 }, { unique: true });

module.exports = mongoose.model('SlotWhitelist', SlotWhitelistSchema);
