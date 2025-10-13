// routes/programRoutes.js
const router = require('express').Router();
const { protect } = require('../middleware/authProtect');
const ctrl = require('../controllers/programController');

// Rooms (admin — add your admin guard if needed)
router.post('/rooms',        protect, ctrl.createRoom);
router.get ('/events/:eventId/rooms', protect, ctrl.listRoomsRegister);
router.get ('/events/:eventId/rooms/add', protect, ctrl.listRooms);

// Sessions (admin — add your admin guard if needed)
router.post  ('/sessions',             protect, ctrl.createSession);
router.patch ('/sessions/:sessionId',  protect, ctrl.updateSession);
router.delete('/sessions/:sessionId',  protect, ctrl.deleteSession);

// Program listing (any authenticated)
router.get('/events/:eventId/sessions', ctrl.listSessionsRegister);
router.get('/events/:eventId/sessions/add', protect, ctrl.listSessions);

// Actor self-signup
router.post  ('/sessions/:sessionId/signup',  protect, ctrl.signup);
router.delete('/sessions/:sessionId/signup',  protect, ctrl.cancelSignup);

// My schedule
router.get('/mine', protect, ctrl.mySchedule);

module.exports = router;
