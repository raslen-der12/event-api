const mongoose = require('mongoose');

const emailCodeSchema = new mongoose.Schema({
  billId   : { type: mongoose.Schema.Types.ObjectId, ref: 'eventBill', index: true },
  email    : { type: String, lowercase: true, index: true },
  codeHash : { type: String, required: true },
  expires  : { type: Date, required: true },
  used     : { type: Boolean, default: false }
}, { versionKey:false });

emailCodeSchema.index({ expires:1 }, { expireAfterSeconds:0 });
module.exports  = mongoose.model('emailCode', emailCodeSchema);
