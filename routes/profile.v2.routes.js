// routes/profile.v2.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer(); // memory storage; swap to disk/S3 as needed

const {
  readProfileCardV2,
  patchProfileCardV2,
  uploadProfileAvatarV2,
} = require('../controllers/profile.v2.controller');

// GET by params OR POST by body — choose one style; here we support both.
router.post('/profile', readProfileCardV2);

router.patch('/profile/patch', patchProfileCardV2);

router.post('/profile/avatar', upload.single('file'), uploadProfileAvatarV2);

module.exports = router;
