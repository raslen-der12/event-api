// routes/search.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/searchController");

// GET /api/search/quick?q=&limit=
router.get("/quick", ctrl.quick);

// GET /api/search/tags
router.get("/tags", ctrl.tags);

// POST /api/search/click
router.post("/click", express.json(), ctrl.click);

module.exports = router;
