// routes/selectsRoutes.js
const express = require('express');
const router  = express.Router();

const ctl = require('../controllers/selectsController');
const { protect } = require('../middleware/authProtect');

// All endpoints are admin-only
router.get   ('/',          protect,  ctl.listSelects);
router.get   ('/pages',     protect,  ctl.listPages);
router.post  ('/',          protect,  ctl.addSelect);
router.patch ('/:id',       protect, ctl.updateSelect);
router.delete('/:id',       protect, ctl.deleteSelect);
router.get   ('/by-name/:name',   protect, ctl.getSelectByName);

module.exports = router;
