const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/community.controller');

// Public or protected — use your middlewares if needed
router.get('/facets', ctrl.getCommunityFacets);
router.get('/list',   ctrl.getCommunityList);

module.exports = router;
