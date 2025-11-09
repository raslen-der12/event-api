// routes/meetsRoutes.js
/**************************************************************************
 *  Meeting (B2B/B2C/B2G) routes
 *  ───────────────────────────────────────────────────────────────────────
 *  Mount in server.js with:
 *      app.use('/api', require('./routes/meetsRoutes'));
 *
 *  All write routes use `protect` (must be logged-in).
 *  Admin-only routes add `isAdmin` guard.
 **************************************************************************/

const express  = require('express');
const router   = express.Router();

const meetsCtrl = require('../controllers/meetsController');
const { protect }  = require('../middleware/authProtect');
const { isAdmin, isSuper }  = require('../middleware/roleGuard');

/* ───────────────  CREATE REQUEST  ─────────────── */
router.post('/', protect, meetsCtrl.requestMeeting);                 // Part 2

/* ───────────────  RESPOND TO REQUEST  ─────────── */

router.post('/exist',               protect, meetsCtrl.checkMeetingExist)
/* ───────────────  READ / LISTS  ───────────────── */
router.get('/',                     protect, meetsCtrl.getMyMeetings);        // Part 4
router.post('/actions',                     protect, meetsCtrl.makeMeetingAction);        // Part 4
router.get('/suggested',                     protect, meetsCtrl.getSuggestedList);        // Part 4
router.get('/admin/suggested',                     protect, meetsCtrl.getSuggestedListAdmin);        // Part 4
router.get('/meets/agenda/:actorId',     protect, meetsCtrl.listActorAgenda); // Part 4
router.get('/meets/:id/ics',             protect, meetsCtrl.getMeetingICS);        // Part 5
router.get('/meetings/prefs/:actorId', protect, meetsCtrl.getMeetingPrefs);
/* ───────────────  AVAILABILITY  ──────────────── */
router.get('/events/:eventId/available-slots',
           protect, meetsCtrl.listAvailableSlots);                                   // Part 4

/* ───────────────  REMINDERS (admin) ──────────── */
router.get('/meets/reminders/:eventId',
           protect,  meetsCtrl.listMeetingReminders);                        // Part 6

 router.get('/admin/meets', protect, meetsCtrl.adminListMeets);                 // list grid
router.get('/admin/meets/:id', protect, meetsCtrl.adminGetMeet);               // item details (+ attendance)
router.get('/admin/meets/calendar', protect, meetsCtrl.adminCalendar);         // calendar feed
router.get('/admin/meets/stats/:eventId', protect, meetsCtrl.adminMeetStats);  // stats

router.post('/admin/meets', protect, meetsCtrl.adminCreateMeet);               // create+confirm
router.delete('/admin/meets/:id', protect, meetsCtrl.adminDeleteMeet);         // delete

router.post('/admin/meets/:id/attendance', protect, meetsCtrl.adminMarkAttendance); // mark physical/virtual attendance
router.post('/admin/meets/:id/link', protect, meetsCtrl.adminSetVirtualLink);       // set/overwrite virtual link
router.get('/admin/meets/:id/reschedule', protect, meetsCtrl.adminReschedule);     
router.post('/admin/meets/:id/table', protect, meetsCtrl.adminSetTable);
router.put('/whitelist', protect, meetsCtrl.setWhitelist);
router.get("/:eventId/my", meetsCtrl.getMyWhitelist);
router.post("/:eventId/my", meetsCtrl.setMyWhitelist);
router.put('meets/admin/whitelist', protect, meetsCtrl.adminSetWhitelist);
router.post('/admin/scan/actor-attend', protect,  meetsCtrl.adminScanActorAttend);
router.post('/admin/scan/session',      protect,  meetsCtrl.adminScanSession);
router.post('/admin/scan/meet',         protect,  meetsCtrl.adminScanMeet);
router.get('/admin/events/:eventId/sessions-mini', meetsCtrl.listEventSessionsMini);

module.exports = router;
