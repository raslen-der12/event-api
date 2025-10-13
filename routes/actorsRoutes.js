// routes/actorRoutes.js
/**************************************************************************
 * Actor-facing API (attendees, exhibitors, speakers)
 * Mount with: app.use('/actor', require('./routes/actorRoutes'));
 * All routes require a valid JWT (middleware: protect).
 **************************************************************************/

const express = require('express');
const router  = express.Router();

const actor = require('../controllers/actorsController');
const { protect } = require('../middleware/authProtect');
const Notif = require('../controllers/actorNotificationController');

/* If you copied chatBlockGuard from the controller */
const { chatBlockGuard } = require('../controllers/actorsController');

/* ───────────────────  ACTORS (admin tools)  ───────────────────── */
router.post('/',            protect, actor.getActorsList);
router.get('/:id',          protect, actor.getActorFullById);
router.post('/create',      protect, actor.createActorSimple);
router.post('/requests',    protect, actor.getRequests);
router.patch('/requests',   protect, actor.setAdminVerify);
router.post('/suggestions',  protect, actor.getSuggestedActors);
// routes/actorsRoutes.js
router.post('/profile/picture', protect, actor.uploadProfilePic);
// routes/actorRoutes.js
router.get('/meetings/suggest', protect, actor.suggestMeetingMatches);

/* ───────────────────  CHAT – DMs & Groups  ───────────────────── */
// Ensure / create a DM
router.post('/chat',                    protect, actor.getOrCreateDM);

// Create group
router.post('/chat/group',              protect, actor.createGroupChat);

// Invite users to group
router.patch('/chat/:roomId/invite',    protect, actor.inviteMembers);

// Leave group
router.patch('/chat/:roomId/leave',     protect, actor.leaveGroup);

// List my rooms (with last message)
router.get('/chat',                     protect, actor.listMyRooms);

// Send message (HTTP fallback; socket preferred on client)
router.post('/chat/:roomId',            protect, chatBlockGuard, actor.sendChatMessage);

// List messages (keep BOTH endpoints for safety)
router.get('/chat/:roomId',             protect, actor.listChat);               // legacy
router.get('/chat/:roomId/messages',    protect, actor.listChat);               // preferred

// Mark messages seen
router.patch('/chat/:roomId/seen',      protect, actor.markSeen);

// Upload files to a room (creates a message)
router.post('/chat/:roomId/files',      protect, chatBlockGuard, actor.uploadFiles);

// Unread counters per room
router.get('/chat/unread',              protect, actor.unreadCounts);

// Full-text search within my rooms
router.get('/chat/search',              protect, actor.searchChat);

/* message extras */
router.post  ('/chat/:msgId/react',          protect, actor.reactMessage);
router.delete('/chat/:msgId/react/:emoji',   protect, actor.unReactMessage);
router.delete('/chat/msg/:msgId',            protect, actor.deleteMessageGlobal);
router.get('/me/notifications', protect, Notif.listMine);
router.patch('/me/notifications/:id/ack', protect, Notif.ackMine);

/* ───────────────────  EVENTS – comments & bookmarks  ─────────── */
// router.post  ('/event/:eventId/comments',    protect, actor.createComment);
// router.get   ('/event/:eventId/comments',    protect, actor.listComments);
// router.patch ('/event/comments/:id',         protect, actor.editComment);
// router.delete('/event/comments/:id',         protect, actor.deleteComment);

// router.post  ('/event/:id/bookmark',         protect, actor.bookmarkEvent);
// router.delete('/event/:id/bookmark',         protect, actor.unbookmarkEvent);
// router.get   ('/event/bookmarks',            protect, actor.listBookmarks);

/* ───────────────────  SUPPORT & REPORTS  ─────────────────────── */
// router.post  ('/support',                    protect, actor.openTicket);
// router.get   ('/support/mine',               protect, actor.myTickets);
// router.patch ('/support/:id',                protect, actor.updateTicket);
// router.post  ('/report',                     protect, actor.reportActor);

/* ───────────────────  FOLLOW SYSTEM  ─────────────────────────── */
// router.post  ('/follow',                     protect, actor.followActor);
// router.delete('/follow/:peerId',             protect, actor.unfollowActor);
// router.get   ('/followers',                  protect, actor.myFollowers);

/* ───────────────────  BLOCKLIST  ─────────────────────────────── */
// router.post  ('/block',                      protect, actor.blockActor);
// router.delete('/block/:peerId',              protect, actor.unblockActor);

/* ───────────────────  NOTIFICATIONS  ─────────────────────────── */
// router.get   ('/notifs',                     protect, actor.listNotifs);
// router.patch ('/notifs/:id/read',            protect, actor.markNotifRead);

/* ───────────────────  PREFERENCES & PROFILE  ─────────────────── */
router.get   ('/prefs',                      protect, actor.getPrefs);
router.patch ('/prefs',                      protect, actor.updatePrefs);

router.post  ('/profile',                    protect, actor.getActorProfile);
router.patch ('/profile/update',             protect, actor.updateActorProfile);

// Keeping your existing route as-is (even though the path is a bit odd)
router.post  ('/actor/profile/',             protect, actor.getActorProfileById);



router.get('/people/search', protect, actor.searchPeople );

// Lists by role (event-scoped)
router.get('/event/:eventId/attendees',  actor.listAttendeesForEvent);
router.get('/event/:eventId/exhibitors', actor.listExhibitorsForEvent);
router.get('/event/:eventId/speakers',   actor.listSpeakersForEvent);





module.exports = router;
