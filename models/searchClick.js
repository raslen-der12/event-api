// models/searchClick.js
const mongoose = require("mongoose");

const SearchClickSchema = new mongoose.Schema(
  {
    idValue: { type: String, index: true },
    type: { type: String, index: true },
    ts: { type: Date, default: Date.now, index: true },
    ua: { type: String },
    ip: { type: String },
  },
  { versionKey: false }
);

module.exports = mongoose.model("SearchClick", SearchClickSchema);
