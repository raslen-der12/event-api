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
const { isAdmin }  = require('../middleware/roleGuard');

/* ───────────────  CREATE REQUEST  ─────────────── */
router.post('/', protect, meetsCtrl.requestMeeting);                 // Part 2

/* ───────────────  RESPOND TO REQUEST  ─────────── */
router.patch('/meets/:id/accept',   protect, meetsCtrl.acceptMeeting);    // Part 3
router.patch('/meets/:id/decline',  protect, meetsCtrl.declineMeeting);   // Part 3
router.patch('/meets/:id/propose',  protect, meetsCtrl.proposeNewTime);   // Part 3
router.patch('/meets/:id/confirm',  protect, meetsCtrl.confirmReschedule);// Part 3
router.patch('/meets/:id/cancel',   protect, meetsCtrl.cancelMeeting);    // Part 5
router.post('/exist',               protect, meetsCtrl.checkMeetingExist)
/* ───────────────  READ / LISTS  ───────────────── */
router.get('/',                     protect, meetsCtrl.getMyMeetings);        // Part 4
router.get('/meets/agenda/:actorId',     protect, isAdmin, meetsCtrl.listActorAgenda); // Part 4
router.get('/meets/:id/ics',             protect, meetsCtrl.getMeetingICS);        // Part 5
router.get('/meetings/prefs/:actorId', protect, meetsCtrl.getMeetingPrefs);
/* ───────────────  AVAILABILITY  ──────────────── */
router.get('/events/:eventId/available-slots',
           protect, meetsCtrl.listAvailableSlots);                                   // Part 4

/* ───────────────  REMINDERS (admin) ──────────── */
router.get('/meets/reminders/:eventId',
           protect, isAdmin, meetsCtrl.listMeetingReminders);                        // Part 6

module.exports = router;
