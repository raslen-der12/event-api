// models/BusinessProfile.js
const mongoose = require('mongoose');
const { Schema } = mongoose;
const contactSchema = new mongoose.Schema({
  kind: { type: String, trim: true, lowercase: true },     // email | phone | whatsapp | ...
  value: { type: String, trim: true },
  label: { type: String, trim: true }
}, { _id: false });
const TeamMemberSchema = new Schema(
  {
    role: { type: String, enum: ['exhibitor', 'speaker', 'attendee'], required: true },
    entityId:   { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const socialSchema = new mongoose.Schema({
  kind: { type: String, trim: true, lowercase: true },     // linkedin | x | facebook | website | ...
  url:  { type: String, trim: true }
}, { _id: false });

const statsSchema = new mongoose.Schema({
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  items: { type: Number, default: 0 },
}, { _id: false });

const businessProfileSchema = new mongoose.Schema({
  team: { type: [TeamMemberSchema], default: [] },
  owner: {
    actor: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    role : { type: String, trim: true, lowercase: true, required: true, index: true }, // attendee|exhibitor|speaker|expert|investor|employee|consultant|businessowner
  },
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', index: true },

  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  name: { type: String, trim: true, required: true, maxlength: 120 },
  size: { type: String, trim: true, default: '1-10' }, // e.g. 1-10, 11-50, etc.

  tagline: { type: String, trim: true, maxlength: 160 },
  about  : { type: String, trim: true, maxlength: 4000 },

  industries: { type: [String], index: true, default: [] },
  countries : { type: [String], index: true, default: [] },
  languages : { type: [String], index: true, default: [] },

  offering : { type: [String], index: true, default: [] }, // what we sell/do
  seeking  : { type: [String], index: true, default: [] }, // what we want/looking for
  innovation: { type: [String], index: true, default: [] }, // USPs/keywords

  contacts: { type: [contactSchema], default: [] },
  socials : { type: [socialSchema], default: [] },

  // media — store upload ObjectIds or URLs (keep it generic)
logoUpload  : { type: String, trim: true },
bannerUpload: { type: String, trim: true },
gallery     : { type: [String], default: [] },
legalDocPath: { type: String, default: '' },
  badges  : { type: [String], default: [] },
  featured: { type: Boolean, default: false },
  published: { type: Boolean, default: false },

  stats: { type: statsSchema, default: () => ({}) },
}, { timestamps: true });

businessProfileSchema.index({ name: 'text', tagline: 'text', about: 'text', industries: 'text', offering: 'text', seeking: 'text' });

function slugify(s=''){
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);
}

businessProfileSchema.pre('save', async function(next){
  if (!this.slug && this.name){
    let base = slugify(this.name);
    if (!base) base = 'bp';
    let candidate = base, n = 1;
    // ensure uniqueness
    while(await this.constructor.exists({ slug: candidate })){
      n += 1;
      candidate = `${base}-${n}`;
    }
    this.slug = candidate;
  }
  next();
});

module.exports = mongoose.model('BusinessProfile', businessProfileSchema);
