// routes/eventRoutes.js
const express  = require('express');
const router   = express.Router();

const eventCtr = require('../controllers/eventController');
const ticketCtr= require('../controllers/financeController');   // Parts 1-3 finance
const authMid  = require('../middleware/authProtect');
const roleMid  = require('../middleware/roleGuard');
const { upload, handleAdvancedMulterError } = require('../middleware/uploader');

const { protect } = authMid;
const { isAdmin, allowRoles } = roleMid;
const isStaff = allowRoles(['staff', 'admin']);   // badge scanners


router.get('/', eventCtr.getEvents);
/*───────────────────────────  VISITOR ROUTES  ──────────────────────────*/
// big page & mini pages
router.post('/event/mini',        eventCtr.getEventMini);
router.post('/event/full',        eventCtr.getEventFull);
router.get('/event/:eventId/gallery',     eventCtr.getGalleryPublic);
router.get('/event/:eventId/schedule',    eventCtr.getSchedulePublic);
router.get('/event/:eventId/features',    eventCtr.getFeaturesPublic);
router.get('/event/:eventId/impacts',     eventCtr.getImpactsPublic);
router.get('/event/:eventId/organizers',  eventCtr.getOrganizersPublic);
router.get('/event/:eventId/stats',       eventCtr.getVisitorStats);
router.get('/event/:eventId/search',      eventCtr.searchEventContent);
router.get('/event/:eventId/schedule.ics',eventCtr.getScheduleICS);
router.get('/event/:eventId/live-stats',  eventCtr.sseLiveStats);

/*───────────────────────────  PUBLIC TICKETING  ───────────────────────*/
// purchase flow (finance controller Part 1 & 2)
router.post('/tickets/purchase',           ticketCtr.initPurchase);
router.post('/tickets/verify-code',        ticketCtr.verifyEmailCode);

/*───────────────────────────  STAFF / SCAN  ───────────────────────────*/
router.post('/tickets/:ticketId/checkin',  protect, isStaff, eventCtr.checkInTicket);

/*───────────────────────────  ADMIN DASHBOARD  ───────────────────────*/
router.get('/events/:eventId/admin/dashboard',  protect, isAdmin, eventCtr.getAdminDashboard);
router.get('/events/:eventId/analytics/revenue',protect, isAdmin, eventCtr.getDailyRevenueTrend);
router.get('/events/:eventId/analytics/tickets',protect, isAdmin, eventCtr.getTicketTypeBreakdown);

/*───────────────────────────  ADMIN CRUD  ─────────────────────────────*/
// Organizers
router.route('/events/:eventId/organizers')
      .get(   protect, isAdmin, eventCtr.listOrganizers)
      .post(  protect, isAdmin, eventCtr.createOrganizer);
router.route('/events/:eventId/organizers/:orgId')
      .patch( protect, isAdmin, eventCtr.updateOrganizer)
      .delete(protect, isAdmin, eventCtr.deleteOrganizer);
router.route('/event/admin')
      .post(   protect, eventCtr.createEvent)
      .patch(  protect,  upload.any(),        eventCtr.updateEvent,  handleAdvancedMulterError)
      .delete(  protect, eventCtr.deleteEventCollectionItem);
// Impacts
router.route('/events/:eventId/impacts')
      .get(   protect, isAdmin, eventCtr.listImpacts)
      .post(  protect, isAdmin, eventCtr.createImpact);
router.route('/events/:eventId/impacts/:impactId')
      .patch( protect, isAdmin, eventCtr.updateImpact)
      .delete(protect, isAdmin, eventCtr.deleteImpact);

// Gallery
router.route('/events/:eventId/gallery')
      .get(   protect, isAdmin, eventCtr.listGallery)
      .post(  protect, isAdmin, eventCtr.uploadGalleryItem);
router.route('/events/:eventId/gallery/:itemId')
      .patch( protect, isAdmin, eventCtr.updateGalleryItem)
      .delete(protect, isAdmin, eventCtr.deleteGalleryItem);

// Features
router.route('/events/:eventId/features')
      .get(   protect, isAdmin, eventCtr.listFeatures)
      .post(  protect, isAdmin, eventCtr.createFeature);
router.route('/events/:eventId/features/:featureId')
      .patch( protect, isAdmin, eventCtr.updateFeature)
      .delete(protect, isAdmin, eventCtr.deleteFeature);

// Schedule
router.route('/events/:eventId/schedule')
      .get(   protect, isAdmin, eventCtr.listSchedule)
      .post(  protect, isAdmin, eventCtr.createSession);
router.route('/events/:eventId/schedule/:sessionId')
      .patch( protect, isAdmin, eventCtr.updateSession)
      .delete(protect, isAdmin, eventCtr.deleteSession);

// Comments moderation
router.get   ('/events/:eventId/comments/pending',          protect, isAdmin, eventCtr.listPendingComments);
router.patch ('/comments/:commentId/approve',               protect, isAdmin, eventCtr.approveComment);
router.delete('/comments/:commentId/reject',                protect, isAdmin, eventCtr.rejectComment);

/*───────────────────────────  FINANCE TOOLS  ─────────────────────────*/
router.post ('/tickets/refund',            protect, isAdmin, ticketCtr.refundTicket);
router.get  ('/bills',                     protect, isAdmin, ticketCtr.listBills);
router.get  ('/events/:eventId/bills/export.csv',   protect, isAdmin, eventCtr.exportBillsCSV);
router.get  ('/events/:eventId/tickets/export.csv', protect, isAdmin, eventCtr.exportTicketsCSV);
router.get  ('/bills/:billId/receipt.pdf', protect, eventCtr.getBillReceiptPDF);

/*───────────────────────────  AUDIT LOG  ─────────────────────────────*/
router.get  ('/events/:eventId/audit',            protect, isAdmin, eventCtr.listAuditLogs);
router.get  ('/events/:eventId/audit/export.csv', protect, isAdmin, eventCtr.exportAuditCSV);

/*───────────────────────────  PROMO CODES  ───────────────────────────*/
router.route('/events/:eventId/promos')
      .get(   protect, isAdmin, eventCtr.listPromos)
      .post(  protect, isAdmin, eventCtr.createPromo);
router.route('/events/:eventId/promos/:promoId')
      .patch( protect, isAdmin, eventCtr.updatePromo)
      .delete(protect, isAdmin, eventCtr.deletePromo);

/*───────────────────────────  LIFE-CYCLE  ───────────────────────────*/
router.patch ('/events/:eventId/publish',       protect, isAdmin, eventCtr.publishEvent);
router.post  ('/events/:eventId/duplicate',     protect, isAdmin, eventCtr.duplicateEvent);
router.delete('/events/:eventId',               protect, isAdmin, eventCtr.cascadeDeleteEvent);

/*───────────────────────────  REMINDERS  ────────────────────────────*/
router.post  ('/events/:eventId/reminders',              protect, isAdmin, eventCtr.scheduleEventReminders);
router.get   ('/events/:eventId/reminders',              protect, isAdmin, eventCtr.listScheduledReminders);
router.delete('/events/:eventId/reminders/:jobId',       protect, isAdmin, eventCtr.cancelReminder);

/*───────────────────────────  ANALYTICS CSV feeds already added, done ─*/

module.exports = router;
