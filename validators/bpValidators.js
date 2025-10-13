const { body, param, query } = require('express-validator');

const normTags = (a=[]) => Array.from(new Set(
  (Array.isArray(a) ? a : [a]).map(String).map(s=>s.trim()).filter(Boolean).map(s=>s.toLowerCase())
));

const normText = (s, max=300) => String(s||'').trim().slice(0, max);

const profileCreateV = [
  body('name').isString().trim().isLength({ min: 2, max: 120 }),
  body('size').isIn(['individual','small','medium']),
  body('ownerRole').isIn(['attendee','exhibitor','speaker']),
  body('event').optional().isMongoId(),
  body('tagline').optional().isString().isLength({ max:160 }),
  body('about').optional().isString().isLength({ max:4000 }),
  body('industries').optional(),
  body('countries').optional(),
  body('languages').optional(),
  body('seeking').optional(),
  body('offering').optional(),
  body('innovation').optional(),
];

const profileUpdateV = [
  body('name').optional().isString().isLength({ min:2, max:120 }),
  body('size').optional().isIn(['individual','small','medium']),
  body('tagline').optional().isString().isLength({ max:160 }),
  body('about').optional().isString().isLength({ max:4000 }),
];

const productCreateV = [
  body('title').isString().trim().isLength({ min:2, max:120 }),
  body('summary').optional().isString().isLength({ max:600 }),
  body('details').optional().isString().isLength({ max:6000 }),
  body('category').optional().isString().isLength({ max:40 }),
  body('tags').optional(),
  body('pricing.currency').optional().isString().isLength({ min:3, max:3 }),
  body('pricing.value').optional().isFloat({ min:0 }),
  body('pricing.unit').optional().isString().isLength({ max:20 }),
];

const serviceCreateV = [
  body('title').isString().trim().isLength({ min:2, max:120 }),
  body('summary').optional().isString().isLength({ max:600 }),
  body('details').optional().isString().isLength({ max:6000 }),
  body('category').optional().isString().isLength({ max:40 }),
  body('tags').optional(),
  body('pricingNote').optional().isString().isLength({ max:300 }),
];

const reviewCreateV = [
  body('rating').isInt({ min:1, max:5 }),
  body('title').optional().isString().isLength({ max:120 }),
  body('body').optional().isString().isLength({ max:2000 }),
];

const listQueryV = [
  query('q').optional().isString(),
  query('industry').optional().isString(),
  query('country').optional().isString(),
  query('size').optional().isIn(['individual','small','medium']),
  query('role').optional().isIn(['attendee','exhibitor','speaker']),
  query('page').optional().toInt(),
  query('limit').optional().toInt(),
  query('featured').optional().isIn(['1','0']),
];

module.exports = {
  normTags, normText,
  profileCreateV, profileUpdateV,
  productCreateV, serviceCreateV,
  reviewCreateV, listQueryV
};
