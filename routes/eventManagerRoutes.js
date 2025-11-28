// routes/eventManagerRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/eventManagerController');

// 🔐 Adapt these two according to your real middlewares
const { protect } = require('../middleware/authProtect');   // sets req.user
const { isAdmin } = require('../middleware/roleGuard');

// Public for authenticated users (frontend uses these)
router.post('/apply', protect, ctrl.applyEventManager);
router.get('/my-application', protect, ctrl.getMyEventManagerApplication);

// Admin views
router.get('/admin/applications',protect, isAdmin, ctrl.adminListApplications);
router.patch(
  '/admin/applications/:id/status',
    protect,
  isAdmin,
  ctrl.adminUpdateApplicationStatus
);

module.exports = router;
