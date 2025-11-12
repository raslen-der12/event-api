const express = require("express");
const ctrl = require("../controllers/pollsController");
const router   = express.Router();

// You likely already have these middlewares:
const { protect }  = require('../middleware/authProtect');

router.post("/admin",protect, ctrl.adminCreatePoll);
router.get("/admin",protect, ctrl.adminListPolls);
router.get("/", ctrl.listPublicPolls);
router.get("/:id", ctrl.getPublicPoll);
router.post("/:id/vote", ctrl.submitVote);

// Admin router
router.post("/admin/:id/start",protect, ctrl.adminStartPoll);
router.post("/admin/:id/stop",protect, ctrl.adminStopPoll);
router.get("/admin/:id/results",protect, ctrl.adminPollResults);

module.exports = router;
