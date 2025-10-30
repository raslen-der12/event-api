// routes/inviteRoutes.js
const router = require('express').Router();
const invites = require('../controllers/inviteController');
const { protect }  = require('../middleware/authProtect');
const { isAdmin, isSuper }  = require('../middleware/roleGuard');

// Admin endpoints
router.get('/admin/search-actors', protect, invites.searchActors);
router.post('/admin/generate',      protect, invites.generateCode);
router.get('/admin/list',           protect, invites.listCodes);

// Public (used by register flow later)
router.post('/use', invites.consumeCode);

module.exports = router;
