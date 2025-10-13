const mongoose = require('mongoose');

const businessOwnerSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'exhibitor', required: true, unique: true, index: true }, // or attendee/speaker, but you said auth stays actor-based; most business owners will be exhibitors
  // Identity
  businessName: { type: String, required: true, trim: true, maxlength: 160 },
  logoUpload:   { type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' },
  shortDescription: { type: String, trim: true, maxlength: 2000 },
  website: { type: String, trim: true, maxlength: 300 },
  foundedYear: { type: Number, min: 1800, max: 2100 },
  businessType: { type: String, enum: ['Startup','SME','Supplier','Freelancer'] },
  // Contact
  email: { type: String, trim: true, lowercase: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 40 },
  address: { type: String, trim: true, maxlength: 300 },
  city: { type: String, trim: true, maxlength: 80 },
  country: { type: String, trim: true, uppercase: true, maxlength: 2 },
  // Legal
  registrationNumber: { type: String, trim: true, maxlength: 80 },
  taxId: { type: String, trim: true, maxlength: 80 },
  legalDocs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'actorUpload' }],
  verificationStatus: { type: String, enum: ['Pending','Verified','Rejected'], default: 'Pending', index: true },
  // Business classification
  sector: { type: String, trim: true, maxlength: 80 },
  subSectors: [{ type: String, trim: true, maxlength: 80 }],
  businessSize: { type: Number, min: 0 }, // employees
  // Social
  linkedin: { type: String, trim: true, maxlength: 300 },
  facebook: { type: String, trim: true, maxlength: 300 },
  instagram: { type: String, trim: true, maxlength: 300 },
  // Catalog (optional)
  createdAt: { type: Date, default: Date.now }
},{ versionKey:false });

module.exports = mongoose.model('roleBusinessOwner', businessOwnerSchema);
