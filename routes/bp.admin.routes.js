// server/routes/bp.admin.routes.js
const express = require('express');
const r = express.Router();
const { protect } = require('../middleware/authProtect');
const { isAdmin } = require('../middleware/roleGuard');
const Adm = require('../controllers/bpAdminController');

// ------- OVERVIEW -------
r.get('/admin/bp/overview', protect, isAdmin, Adm.adminBpOverview);

// ------- LIST / APPROVALS -------
r.get('/admin/bp', protect, isAdmin, Adm.adminListProfiles);
r.patch('/admin/bp/:profileId/publish', protect, isAdmin, Adm.adminPublishProfile);
r.patch('/admin/bp/publish', protect, isAdmin, Adm.adminBulkPublish);
r.patch('/admin/bp/:profileId/feature', protect, isAdmin, Adm.adminFeatureProfile);

// delete profile (with items cascade)
r.delete('/admin/bp/:profileId', protect, isAdmin, Adm.adminDeleteProfile);
r.get('/admin/bp/profile/:id',protect, Adm.adminGetProfile);
// ------- ITEMS ADMIN -------
r.get('/admin/bp/items', protect, isAdmin, Adm.adminListItems);
r.delete('/admin/bp/items/:itemId', protect, isAdmin, Adm.adminDeleteItem);
r.patch('/admin/bp/items/:itemId/hide', protect, isAdmin, Adm.adminHideItem);

// ------- TAXONOMY ADMIN -------
r.get('/admin/bp/taxonomy', protect, isAdmin, Adm.adminTaxonomyList);
r.post('/admin/bp/taxonomy/sector', protect, isAdmin, Adm.adminTaxonomyAddSector);
r.post('/admin/bp/taxonomy/:sector/subsectors', protect, isAdmin, Adm.adminTaxonomyAddSubsectors);
r.delete('/admin/bp/taxonomy/:sector', protect, isAdmin, Adm.adminTaxonomyDeleteSector);
r.delete('/admin/bp/taxonomy/:sector/subsectors/:subId', protect, isAdmin, Adm.adminTaxonomyDeleteSubsector);

module.exports = r;
