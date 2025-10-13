// routes/adminRoutes.js
/**************************************************************************
 *  Admin-space API routes
 *  ───────────────────────────────────────────────────────────────────────
 *  Mount in server.js with:
 *      app.use('/admin', require('./routes/adminRoutes'));
 *
 *  Guards
 *    protect → any signed-in admin       (authProtect middleware)
 *    isAdmin → same as protect (shortcut) – plus can carry perm checks
 *    isSuper → req.user.role === 'super'
 **************************************************************************/

const express  = require('express');
const router   = express.Router();

const adminCtrl = require('../controllers/adminController');
const { protect }   = require('../middleware/authProtect');
const { isAdmin, isSuper } = require('../middleware/roleGuard');

/* ───────────────  PEOPLE MANAGEMENT  ─────────────── */
// create actor (speaker / attendee / exhibitor)
router.post('/actors',                      protect, isAdmin,  adminCtrl.createActor);
// quick pwd reset
router.patch('/actors/:type/:id/pwd',       protect, isAdmin,  adminCtrl.resetActorPassword);
// impersonate actor (super)
router.post ('/actors/:type/:id/impersonate', protect, isSuper, adminCtrl.impersonateActor);
// bulk actor CSV
router.get  ('/actors/csv',                 protect, isAdmin,  adminCtrl.exportActorsCSV);

/* ───────────────  ADMIN ACCOUNTS  ─────────────── */
router.post ('/',                protect, isSuper, adminCtrl.createAdmin);
router.get  ('/',                protect, isAdmin, adminCtrl.listAdmins);
router.patch('/:id',             protect, isAdmin, adminCtrl.updateAdmin);
router.patch('/:id/toggle',      protect, isSuper, adminCtrl.toggleAdminState);
router.patch('/:id/permissions', protect, isSuper, adminCtrl.updateAdminPermissions);
router.delete('/:id',            protect, isSuper, adminCtrl.deleteAdmin);

/* ───────────────  DASHBOARDS & EXPORTS  ────────── */
router.get('/stats/global',              protect, isAdmin, adminCtrl.getGlobalStats);
router.get('/stats/event/:eventId',      protect, isAdmin, adminCtrl.getEventStats);
router.get('/stats/revenue',             protect, isAdmin, adminCtrl.getRevenueTrend);
router.get('/stats/event/:eventId/csv',  protect, isAdmin, adminCtrl.exportEventRevenueCSV);

/* ───────────────  AUDIT  ──────────────────────── */
router.get('/audit',                     protect, isAdmin, adminCtrl.getAuditLogs);

/* ───────────────  NOTIFICATIONS  ─────────────── */
router.post ('/notifs/broadcast',        protect, isAdmin, adminCtrl.broadcastNotification);
router.patch('/notifs/:id/read',         protect, isAdmin, adminCtrl.markNotificationRead);

/* ───────────────  CHAT ROOMS & MSGS  ─────────── */
// router.post ('/chat/room',               protect
//     // , isAdmin
//     , adminCtrl.createChatRoom);
// router.get  ('/chat/rooms',              protect
//     // , isAdmin
//     , adminCtrl.listChatRooms);
// router.patch('/chat/room/:roomId/leave', protect
//     // , isAdmin
//     , adminCtrl.leaveChatRoom);
// router.delete('/chat/room/:roomId',      protect
//     // , isSuper
//     , adminCtrl.deleteChatRoom);

// router.post ('/chat/:roomId',            protect
//     // , isAdmin
//     , adminCtrl.sendChatMessage);
// router.get  ('/chat/:roomId',            protect
//     // , isAdmin
//     , adminCtrl.listChatRoom);
// router.delete('/chat/:msgId',            protect
//     // , isAdmin
//     , adminCtrl.deleteChatMessage);

/* ───────────────  CALENDAR  ───────────────────── */
router.post ('/calendar',                protect, isAdmin, adminCtrl.createCalendarEntry);
router.get  ('/calendar',                protect, isAdmin, adminCtrl.listCalendar);
router.delete('/calendar/:entryId',      protect, isAdmin, adminCtrl.deleteCalendarEntry);

/* ───────────────  PLATFORM SETTINGS  ─────────── */
router.get ('/settings',                 protect, isSuper, adminCtrl.getSettings);
router.patch('/settings',                protect, isSuper, adminCtrl.setSettings);

module.exports = router;
