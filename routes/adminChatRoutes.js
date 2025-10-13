// routes/adminChatRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/adminChatController');

// ROOMS
router.get('/rooms', ctrl.listRooms);
router.get('/rooms/:roomId', ctrl.roomInfo);
router.post('/room', ctrl.createRoom); // ensure/create admin–actor DM

// MESSAGES
router.get('/rooms/:roomId/messages', ctrl.listMessages);
router.post('/rooms/:roomId/system', ctrl.sendSystemMessage);
router.delete('/messages/:msgId', ctrl.deleteMessageAdmin);

// FILE UPLOADS (returns URLs; then client sends a system message with those URLs)
router.post('/rooms/:roomId/files', ctrl.uploadFiles);

// SANCTIONS
router.post('/rooms/:roomId/mute', ctrl.muteInRoom);
router.post('/mute-global',        ctrl.muteGlobal);
router.post('/rooms/:roomId/ban',  ctrl.banInRoom);
router.post('/ban-global',         ctrl.banGlobal);
router.delete('/sanctions/:id',    ctrl.removeSanction);

// MEMBERS / SEARCH / EXPORT / BROADCAST
router.post('/rooms/:roomId/kick', ctrl.kickFromRoom);
router.get('/search',              ctrl.searchMessages);
router.get('/rooms/:roomId/transcript', ctrl.exportTranscript);
router.post('/broadcast',          ctrl.broadcast);

module.exports = router;
