// models/speaker.js
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const URL_RX   = /^https?:\/\/[\w.-]+/;
const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const subOpts  = { _id:false, id:false };
const ROLE_KIND_ENUM = ['Business Owner','Investor','Consultant','Expert','Employee','Student'];

/* ───────────────────────── A. Personal & Contact ───────────────────── */
const PersonalSchema = new mongoose.Schema({
  fullName        : { type:String, required:true, trim:true, minlength:2 },
  email           : { type:String, required:true, lowercase:true, match:EMAIL_RX, index:{ unique:true } },
  phone           : { type:String },
  linkedIn        : { type:String, match:URL_RX },
  country         : { type:String, required:true },
  desc            : { type:String, maxlength:500 },
  city            : { type:String },
  profilePic      : { type:String },
  firstEmail      : { type:String, required:true, lowercase:true, match:EMAIL_RX, index:{ unique:true } },

}, subOpts);

/* ───────────────────────── B. Organisation & Role ──────────────────── */
const OrgRoleSchema = new mongoose.Schema({
  orgName         : { type:String, required:true, trim:true },
  orgWebsite      : { type:String, match:URL_RX },
  jobTitle        : { type:String, required:true, trim:true },
  businessRole    : { type:String, required:true }     // CEO, Expert, …
}, subOpts);

/* ───────────────────────── C. Talk / Presentation ──────────────────── */
const TalkSchema = new mongoose.Schema({
  title           : { type:String, required:true },
  abstract        : { type:String, required:true },
  topicCategory   : { type:String, required:true },    // AI, Trade, …
  targetAudience  : { type:String, required:true },    // Startups, SMEs…
  language        : { type:String, required:true },    // en, fr, ar…
  consentRecording: { type:Boolean, default:false }
}, subOpts);

/* ───────────────────────── D. B2B Intent ───────────────────────────── */
const B2BIntentSchema = new mongoose.Schema({
  openMeetings    : { type:Boolean, required:true },
  representingBiz : { type:Boolean, required:true },
  businessSector  : { type:String },
  meetingSlots        : { type:[String], default:[] },   // “11:00”, “14:30” …
  offering        : { type:String },
  lookingFor      : { type:String },
  regionsInterest : { type:[String] },
  investmentSeeking: { type:Boolean },
  investmentRange : { type:Number, min:0 }
}, subOpts);

/* ───────────────────────── E. Optional Enrichments ─────────────────── */
const EnrichSchema = new mongoose.Schema({
  slidesFile      : { type:String, match:URL_RX },     // upload URL
  socialLinks     : { type:[String], match:URL_RX }    // Twitter, etc.
}, subOpts);

/* ───────────────────────── Backend / Matching ──────────────────────── */
const MatchMetaSchema = new mongoose.Schema({
  matchScore      : { type:Number, default:0 },
  suggestedMatches: { type:[mongoose.Schema.Types.ObjectId], ref:'exhibitor', default:[] },
  sessionEngage   : { type:Number, default:0 },
  aiTags          : { type:[String], default:[] }
}, subOpts);

/* ───────────────────────── Main schema ─────────────────────────────── */
const speakerSchema = new mongoose.Schema({
  personal    : PersonalSchema,
  organization: OrgRoleSchema,
  talk        : TalkSchema,
  b2bIntent   : B2BIntentSchema,
  enrichments : EnrichSchema,
  matchMeta   : MatchMetaSchema,
  role: { type: String, enum: ROLE_KIND_ENUM, index: true, default: null }, // <— NEW

  /* Core auth & event link */
  verified   : { type:Boolean, default:false },
  pwd        : { type:String, required:true, minlength:8, select:false },
  subRole      : { type: [String], default: [] },
  actorType    : { type: String, trim: true, default: '' },     // BusinessOwner, Consultant, Employee, Investor, Student, Expert
  role    : { type: String, trim: true, default: '' },
  createdAt  : { type:Date, default:Date.now },
  id_event   : { type:mongoose.Schema.Types.ObjectId, ref:'event', required:true },
  resetToken:      { type: String, select: false },
  resetExpires:    { type: Date,   select: false },

  // Change-email rollback
  emailChangeToken: { type: String, select: false },
  emailChangeExpires:{ type: Date,  select: false },
  emailChangePrev:  { type: String, select: false },
}, {
  versionKey:false,
  toJSON : { virtuals:true, transform:(_d,obj)=>{ delete obj.pwd; return obj; } },
  toObject:{ virtuals:true }
});

/* ── Password hashing ──────────────────────────────────────────────── */
speakerSchema.pre('save', async function(next){
  if (!this.isModified('pwd')) return next();
  const salt = await bcrypt.genSalt(12);
  this.pwd   = await bcrypt.hash(this.pwd, salt);
  next();
});
speakerSchema.methods.comparePassword = function(c){ return bcrypt.compare(c,this.pwd); };

module.exports = mongoose.model('speaker', speakerSchema);
