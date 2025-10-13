// routes/businessProfile.v2.routes.js
const r = require('express').Router();
const {protect} = require('../middleware/authProtect'); // must populate req.user with {_id, actorType, isAdmin, id_event, ...}

const Tax = require('../controllers/bpTaxonomyController');
const Prof = require('../controllers/bpProfileController');
const Item = require('../controllers/bpItemController');
const Adm  = require('../controllers/bpAdminController');
const Search = require('../controllers/bpSearchController');
const Stats  = require('../controllers/bpStatsController');
const Media  = require('../controllers/bpMediaController');
const Admin = require('../controllers/bpAdminController');
const U = require('../controllers/uploadController');
const { isAdmin } = require('../middleware/roleGuard');

// taxonomy (public + admin)
r.get('/bp/taxonomy', Tax.listTaxonomy);
r.post('/admin/bp/taxonomy/sector', protect, Tax.upsertSector);
r.post('/admin/bp/taxonomy/subsector', protect, Tax.upsertSubsector);

// profile (owner)
r.post('/bp/me/create-or-get', protect, Prof.createOrGetMyProfile);
r.get('/bp/me/summary', protect, Prof.getMyProfileSummary);
r.patch('/bp/me', protect, Prof.updateMyProfile);
r.patch('/bp/me/role', protect, Prof.changeMyBusinessRole);
r.post('/bp/me/legal',       protect, Media.setLegalDoc);
// items (owner)
r.post('/bp/me/items', protect, Item.createItem);
r.get('/bp/me/items',  protect, Item.listMyItems);
r.patch('/bp/me/items/:itemId', protect, Item.updateItem);
r.delete('/bp/me/items/:itemId', protect, Item.deleteItem);
r.post('/bp/me/items/:itemId/thumbnail', protect, Item.setItemThumbnail);
r.post('/bp/me/items/:itemId/images/add', protect, Item.addItemImages);
r.post('/bp/me/items/:itemId/images/remove', protect, Item.removeItemImage);

// items (public on a profile)
r.get('/bp/:profileId/items', Item.listProfileItems);

// admin moderation
r.get('/admin/bp/queue', protect, Adm.queue);
r.patch('/admin/bp/:id/publish', protect, Adm.setProfilePublished);
r.patch('/admin/bp/items/:itemId/hide', protect, Adm.hideItem);
r.get('/bp/search', Search.searchProfiles);
r.get('/bp/items/search', Search.searchItems);
r.get('/bp/facets', Search.facets);
r.get('/bp/facets/selects', Search.getFacets);




r.get('/bp/:profileId/overview', Stats.getProfileOverview);
r.get('/bp/:profileId/rating', Stats.getProfileRating);
r.post('/bp/:profileId/rating', protect, Stats.postProfileRating);
r.post('/bp/:profileId/innovation', protect, Stats.postProfileInnovation);
r.post('/bp/:profileId/presence',   protect, Stats.postProfilePresence);

r.get('/bp/:profileId/team',   protect, Prof.getPublicTeam );

r.get('/bp/team/search', protect, Prof.searchTeamCandidates);
r.get   ('/bp/me/team',                        protect, Prof.getMyTeam);
r.post  ('/bp/me/team',                        protect, Prof.addTeamMember);
r.delete('/bp/me/team/:entityType/:entityId',  protect, Prof.removeTeamMember);

// owner media
r.post('/bp/me/logo',        protect, Media.setLogo);
r.post('/bp/me/banner',      protect, Media.setBanner);
r.post('/bp/me/gallery/add', protect, Media.addToGallery);
r.post('/bp/me/gallery/remove', protect, Media.removeFromGallery);


r.get('/admin/bp/profiles', isAdmin, Admin.adminListProfiles);
r.get('/admin/bp/profile/:id', isAdmin, Admin.adminGetProfile);
r.patch('/admin/bp/profile/:id/moderate', isAdmin, Admin.adminModerateProfile);
r.patch('/admin/bp/profile/:id/owner-role', isAdmin, Admin.adminChangeOwnerRole);
r.patch('/admin/bp/items/:itemId/moderate', isAdmin, Admin.adminModerateItem);
r.post('/admin/bp/profiles/bulk', isAdmin, Admin.adminBulkProfiles);
r.get('/admin/bp/audit', isAdmin, Admin.adminAuditLogs);
r.post('/uploads/single', protect, U.uploadSingle);
r.post('/uploads/multi',  protect, U.uploadMulti);

module.exports = r;
