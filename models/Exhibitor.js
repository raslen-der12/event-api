const mongoose = require('mongoose');
const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const LinksSchema = new mongoose.Schema({
  website : { type: String, trim: true },
  linkedin: { type: String, trim: true },
}, { _id: false });

const IdentitySchema = new mongoose.Schema({
  exhibitorName: { type: String, trim: true, required: true }, // brand/public name
  orgName      : { type: String, trim: true },                 // legal org (optional at signup)
  contactName  : { type: String, trim: true, required: true },
  email        : { type: String, trim: true, lowercase: true, required: true },
    firstEmail      : { type:String, required:true, lowercase:true, match:EMAIL_RX, index:{ unique:true } },
  phone        : { type: String, trim: true },
  country      : { type: String, trim: true, uppercase: true, required: true },
  city         : { type: String, trim: true },
  logo         : { type: String, trim: true },                 // /uploads/... set by multer
  preferredLanguages: {
    type: [String],
    default: []
  },
}, { _id: false });

const BusinessSchema = new mongoose.Schema({
  industry: { type: String, trim: true },                      // high-level sector
}, { _id: false });

const CommercialSchema = new mongoose.Schema({
  availableMeetings: { type: Boolean, default: true },
}, { _id: false });

const ExhibitorSchema = new mongoose.Schema({
  // Lightweight “actor role” system
  actorType    : { type: String, trim: true, default: '' },    // BusinessOwner, Consultant, Employee, Investor (no Student/Expert here)
  role    : { type: String, trim: true, default: '' },    // BusinessOwner, Consultant, Employee, Investor (no Student/Expert here)
  actorHeadline: { type: String, trim: true, default: '' },

  identity  : { type: IdentitySchema, required: true },
  business  : { type: BusinessSchema, default: () => ({}) },
  commercial: { type: CommercialSchema, default: () => ({}) },
  links     : { type: LinksSchema, default: () => ({}) },

  id_event  : { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },

  // Auth / verification (compat with old flows)
  pwd          : { type: String, select: false },
  verified     : { type: Boolean, default: false },
  adminVerified: { type: mongoose.Schema.Types.Mixed, default: 'yes' },
  subRole      : { type: [String], default: [] },
  verifyToken  : { type: String, select: false },
  verifyExpires: { type: Date,  select: false },
  resetToken:      { type: String, select: false },
  resetExpires:    { type: Date,   select: false },

  // Change-email rollback
  emailChangeToken: { type: String, select: false },
  emailChangeExpires:{ type: Date,  select: false },
  emailChangePrev:  { type: String, select: false },

}, { timestamps: true });

/** Indexes */
ExhibitorSchema.index({ 'identity.email': 1 }, { unique: true, sparse: true });
ExhibitorSchema.index({ id_event: 1, 'identity.exhibitorName': 1 });

module.exports = mongoose.model('Exhibitor', ExhibitorSchema);
