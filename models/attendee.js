const mongoose = require('mongoose');
const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const LinksSchema = new mongoose.Schema({
  website : { type: String, trim: true },
  linkedin: { type: String, trim: true },
}, { _id: false });

const PersonalSchema = new mongoose.Schema({
  fullName : { type: String, trim: true, required: true },
    firstEmail      : { type:String, required:true, lowercase:true, match:EMAIL_RX, index:{ unique:true } },
  email    : { type: String, trim: true, lowercase: true, required: true },
  phone    : { type: String, trim: true },
  country  : { type: String, trim: true, uppercase: true, required: true }, // ISO2 (TN, FR…)
  city     : { type: String, trim: true },
  profilePic: { type: String, trim: true }, // /uploads/... set by multer
  preferredLanguages: {
    type: [String], // e.g. ['en','fr','ar'] – max 3 (enforced in controller)
    default: []
  },
}, { _id: false });

const OrganizationSchema = new mongoose.Schema({
  orgName      : { type: String, trim: true, },
  jobTitle     : { type: String, trim: true,},
  businessRole : { type: String, trim: true,}, // Founder, Manager…
}, { _id: false });

const MatchingIntentSchema = new mongoose.Schema({
  objectives      : { type: [String], default: [] }, // kept for backward compatibility
  openToMeetings  : { type: Boolean, default: true },
}, { _id: false });

const AttendeeSchema = new mongoose.Schema({
  // Lightweight “actor role” system
  actorType    : { type: String, trim: true, default: '' },     // BusinessOwner, Consultant, Employee, Investor, Student, Expert
  role    : { type: String, trim: true, default: '' },     // BusinessOwner, Consultant, Employee, Investor, Student, Expert
  actorHeadline: { type: String, trim: true, default: '' },     // short tagline
  subRole      : { type: [String], default: [] },
  personal     : { type: PersonalSchema, required: true },
  organization : { type: OrganizationSchema, required: true },
  matchingIntent: { type: MatchingIntentSchema, default: () => ({}) },
  links        : { type: LinksSchema, default: () => ({}) },

  id_event     : { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },

  // Auth / verification (compatible with old flows)
  pwd          : { type: String, select: false },               // hashed if you keep password login
  verified     : { type: Boolean, default: false },             // email verified
  adminVerified: { type: mongoose.Schema.Types.Mixed, default: 'yes' }, // 'yes'|'no'|true|false (kept for older admin code)

  verifyToken  : { type: String, select: false },
  verifyExpires: { type: Date,  select: false },
  resetToken:      { type: String, select: false },
  resetExpires:    { type: Date,   select: false },

  // Change-email rollback
  emailChangeToken: { type: String, select: false },
  emailChangeExpires:{ type: Date,  select: false },
  emailChangePrev:  { type: String, select: false },
  resetTokenPrev:   { type: String, select: false },
  resetPrevExpires: { type: Date,   select: false },
  
}, { timestamps: true });

/** Indexes */
AttendeeSchema.index({ 'personal.email': 1 }, { unique: true, sparse: true });
AttendeeSchema.index({ id_event: 1, 'personal.fullName': 1 });

module.exports = mongoose.model('attendee', AttendeeSchema);
