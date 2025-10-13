// models/programRoom.js
const mongoose = require('mongoose');

const programRoomSchema = new mongoose.Schema({
  id_event: { type: mongoose.Schema.Types.ObjectId, ref: 'event', required: true, index: true },
  name:     { type: String, required: true, trim: true, maxlength: 50 },
  location: { type: String, trim: true, default: '' },
  capacity: { type: Number, default: 0 } // 0 = unbounded / managed at session level
},{
  timestamps: true,
  versionKey: false
});

programRoomSchema.index({ id_event: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('programRoom', programRoomSchema);
