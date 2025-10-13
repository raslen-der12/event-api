// models/admin.js
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const adminSchema = new mongoose.Schema({
  email      : { type:String, required:true, lowercase:true, unique:true },
  pwd        : { type:String, required:true, minlength:8, select:false },

  /* ── NEW FIELDS FOR ADMIN SPACE ── */
  role       : { type:String, enum:['super','normal'], default:'normal' },
  /* fine-grained feature switches, e.g. ['events.read','events.write','payments.read'] */
  permissions: { type:[String], default:["all"] },

  lastLogin  : { type:Date },
  lastPwdChange: { type:Date },

  /* basic profile */
  fullName   : { type:String, trim:true },
  avatar     : { type:String }             // URL

}, { versionKey:false, timestamps:true });

/* PW hash */
adminSchema.pre('save', async function(next){
  if (!this.isModified('pwd')) return next();
  const salt = await bcrypt.genSalt(12);
  this.pwd   = await bcrypt.hash(this.pwd, salt);
  this.lastPwdChange = Date.now();
  next();
});

adminSchema.methods.comparePassword = function(p){
  return bcrypt.compare(p, this.pwd);
};

module.exports = mongoose.model('admin', adminSchema);
