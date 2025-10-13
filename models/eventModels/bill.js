const mongoose = require('mongoose');

/*──────────────────────── Schema ────────────────────────*/
const billSchema = new mongoose.Schema(
  {
    id_event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'event',
      required: true,
      index: true
    },

    id_actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'actorModel',
      index: true
    },
    actorModel: {
      type: String,
      enum: ['speaker', 'attendee', 'exhibitor', 'admin'],
      required: true
    },

    /* Monetary fields ---------------------------------------------------- */
    currency:   { type: String, default: 'USD', uppercase: true },
    subtotal:   { type: Number, required: true, min: 0 },
    taxRate:    { type: Number, default: 0.0 },     // e.g. 0.15 for 15 %
    discount:   { type: Number, default: 0.0 },     // flat amount
    total:      { type: Number, min: 0 },

    /* Payment info ------------------------------------------------------- */
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
      index: true
    },
    method: {
      type: String,
      enum: ['card', 'paypal', 'bank', 'cash', 'free'],
      default: 'card'
    },
    gatewayRef: { type: String, trim: true },       // Stripe charge ID, PayPal txn ID…

    issuedAt:   { type: Date, default: Date.now },
    paidAt:     { type: Date },

    /* Audit -------------------------------------------------------------- */
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    toJSON:  { virtuals: true },
    toObject:{ virtuals: true }
  }
);

/*─────────────────────── Hooks ──────────────────────────*/
billSchema.pre('save', function (next) {
  /* auto-calc total before save */
  this.total = Math.max(0, (this.subtotal - this.discount) * (1 + this.taxRate));
  this.updatedAt = Date.now();
  if (this.isModified('status') && this.status === 'paid' && !this.paidAt) {
    this.paidAt = Date.now();
  }
  next();
});

/* Convenience virtual: tax amount */
billSchema.virtual('taxAmount').get(function () {
  return (this.subtotal - this.discount) * this.taxRate;
});

/*──────────────────────── Export ────────────────────────*/
module.exports = mongoose.model('eventBill', billSchema);
