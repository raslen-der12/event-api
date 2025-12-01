// models/user.js
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const EMAIL_RX = /^[\w.-]+@[\w.-]+\.\w{2,}$/;

const USER_ACTOR_TYPES = [
  'BusinessOwner',   // Business owner / entrepreneur
  'Investor',
  'Consultant',
  'Expert',
  'Employee',
  'Student',
  'Other',
];

const userSchema = new mongoose.Schema({
  /* ────────── Identité plateforme ────────── */
  fullName: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 120,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: EMAIL_RX,
    unique: true,
    index: true,
  },
  phone: {
    type: String,
    trim: true,
    maxlength: 40,
  },
  profilePic: {
    type: String,
    trim: true,
    maxlength: 400, // or whatever you use for URLs
  },
  organization: {
    type: String,
    trim: true,
    maxlength: 120, // limite raisonnable
  },
  jobTitle: {
    type: String,
    trim: true,
    maxlength: 100,
  },

  /* ────────── Rôle “business” (actorType) ────────── */
  actorType: {
    type: String,
    enum: USER_ACTOR_TYPES,
    required: true, // BusinessOwner / Investor / ...
  },
  subRole: {
    type: [String],
    default: [],
    set: (arr) =>
      Array.from(
        new Set(
          (arr || [])
            .map((s) => String(s || '').trim())
            .filter(Boolean)
        )
      ),
  },
  otherRoleLabel: {
    type: String,
    trim: true,
    maxlength: 120,
  },
  /* ────────── Auth ────────── */
  pwd: {
    type: String,
    required: true,
    minlength: 8,
    select: false,
  },
  verified: {
    type: Boolean,
    default: false,
  },
  verifyToken: {
    type: String,
    select: false,
  },
  verifyExpires: {
    type: Date,
    select: false,
  },
  resetToken: {
    type: String,
    select: false,
  },
  resetExpires: {
    type: Date,
    select: false,
  },

  /* ────────── OAuth / Google ────────── */
  googleId: {
    type: String,
    index: true,
  },
  loginProvider: {
    type: String,
    enum: ['password', 'google'],
    default: 'password',
  },

  /* ────────── Niveau d’accès technique ────────── */
  isAdmin: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

/* Hash du password si modifié */
userSchema.pre('save', async function (next) {
  if (!this.isModified('pwd')) return next();
  const salt = await bcrypt.genSalt(12);
  this.pwd   = await bcrypt.hash(this.pwd, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.pwd);
};

module.exports = mongoose.model('user', userSchema);
