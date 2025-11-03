// routes/adminActorsRoutes.js
/**
 * POST /admin/actors/:id/photo
 * - Uses your existing `protect` middleware (same as actorRoutes).
 * - Expects multipart/form-data with field name "photo".
 * - Saves file to ./uploads/actors and updates speaker.personal.profilePic with a public URL.
 *
 * Ready to paste — no filenames to change.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mongoose = require("mongoose");

const router = express.Router();

const { protect } = require("../middleware/authProtect"); // same protect used across routes
// direct require of your speaker model (you provided models/speaker.js)
const Speaker = require("../models/speaker");

// ensure uploads/actors exists
const uploadDir = path.join(__dirname, "..", "uploads", "actors");
fs.mkdirSync(uploadDir, { recursive: true });

// multer storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const safeId = String(req.params.id || "actor").replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${safeId}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

/**
 * Upload speaker photo (admin-only)
 * - Uses protect to ensure request is authenticated (if protect sets req.user).
 * - If req.user exists, requires admin-like role: req.user.isAdmin || req.user.role === 'admin'
 * - Field name expected: "photo"
 */
router.post("/:id/photo", protect, upload.single("photo"), async (req, res) => {
  try {
    // If protect populated req.user, enforce admin-like role
    if (req.user) {
      const isAdminFlag = !!(req.user.isAdmin || String(req.user.role || "").toLowerCase() === "admin");
      if (!isAdminFlag) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    const speakerId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded (field 'photo')" });

    // Build public URL to the uploaded file
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const publicUrl = `${base}/uploads/actors/${file.filename}`;

    // Update speaker document: personal.profilePic
    let updated = null;
    if (typeof Speaker.findByIdAndUpdate === "function") {
      updated = await Speaker.findByIdAndUpdate(
        speakerId,
        { "personal.profilePic": publicUrl },
        { new: true, runValidators: true }
      );
    } else if (typeof Speaker.findOneAndUpdate === "function") {
      updated = await Speaker.findOneAndUpdate(
        { _id: speakerId },
        { "personal.profilePic": publicUrl },
        { new: true, runValidators: true }
      );
    } else {
      // fallback to mongoose models
      const Model = mongoose.models.speaker || mongoose.models.Speaker || mongoose.models.speakers;
      if (Model) {
        updated = await Model.findByIdAndUpdate(
          speakerId,
          { "personal.profilePic": publicUrl },
          { new: true, runValidators: true }
        );
      } else {
        throw new Error("Speaker model update method not found");
      }
    }

    if (!updated) {
      // cleanup file if speaker not found
      try { fs.unlinkSync(path.join(uploadDir, file.filename)); } catch (e) {}
      return res.status(404).json({ error: "Speaker not found" });
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Photo upload error:", err);
    const msg = err && err.message ? err.message : "Upload failed";
    return res.status(500).json({ error: "Upload failed", detail: msg });
  }
});

module.exports = router;
