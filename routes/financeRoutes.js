// routes/financeRoute.js
const express = require('express');
const router  = express.Router();

/* Controllers (Parts 1-3) */
const {
  initPurchase,          // Part 1 – POST /tickets/purchase
  verifyEmailCode,       // Part 2 – POST /tickets/verify-code
  refundTicket,          // Part 3 – POST /tickets/refund   (admin)
  listBills              // Part 3 – GET  /bills            (admin)
} = require('../controllers/financeController');

/* Optional auth / role middlewares ------------------------------------- */
const { protect } = require('../middleware/authProtect');   // sets req.user
const { isAdmin } = require('../middleware/roleGuard');     // checks req.user.role

/* ─────────────────────────────────────────────────────────
 *  PUBLIC purchase flow
 * ────────────────────────────────────────────────────────*/
router.post('/tickets/purchase',      initPurchase);       // anyone (guest or logged-in)
router.post('/tickets/verify-code',   verifyEmailCode);    // completes payment

/* ─────────────────────────────────────────────────────────
 *  ADMIN finance ops
 * ────────────────────────────────────────────────────────*/
router.post('/tickets/refund', protect, isAdmin, refundTicket);
router.get ('/bills',          protect, isAdmin, listBills);

/* Export --------------------------------------------------------------- */
module.exports = router;
