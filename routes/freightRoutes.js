// routes/freightRoutes.js
const express = require('express');
const router = express.Router();
const freightCtrl = require('../controllers/freightController');

// GET /api/ports?q=...
router.get('/ports', freightCtrl.searchPorts);

// GET /api/rates
router.get('/rates', freightCtrl.getRates);

// POST /api/quote
router.post('/quote', freightCtrl.postQuote);

// optional health for freight sub-system
router.get('/freight/health', (req, res) => res.json({ ok: true, service: 'freight', ts: new Date().toISOString() }));

module.exports = router;
