const rateLimit = require('express-rate-limit');

const minute = 60 * 1000;

exports.reviewLimiter = rateLimit({
  windowMs: 10 * minute,
  max: 40, // 40 review ops / 10min per IP
  standardHeaders: true,
  legacyHeaders: false
});

exports.visitLimiter = rateLimit({
  windowMs: 5 * minute,
  max: 200, // insight bumps
  standardHeaders: true,
  legacyHeaders: false
});

exports.mutationLimiter = rateLimit({
  windowMs: 1 * minute,
  max: 120, // generic owner mutations
  standardHeaders: true,
  legacyHeaders: false
});
