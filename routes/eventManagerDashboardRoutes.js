// routes/eventManagerDashboardRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/eventManagerDashboardController");
const { protect } = require("../middleware/authProtect");
// IMPORTANT: in your main index, you probably already have verifyJWT middleware.
// Mount there like:
// router.use("/event-manager/dashboard", verifyJWT, eventManagerDashboardRoutes);
// So we don't re-import auth here.

router.post("/events/wizard",protect, ctrl.createEventFromWizard);
router.get("/events",protect, ctrl.listMyEventsForManager);
router.get("/events/:id",protect, ctrl.getEventForManagerDashboard);
router.patch("/events/:id",protect, ctrl.updateEventForManagerDashboard);
module.exports = router;
