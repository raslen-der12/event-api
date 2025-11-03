const express = require('express');
const router = express.Router();
const BusinessProfile = require('../models/BusinessProfile');

// GET all published business profiles
router.get('/bp-public/profiles', async (req, res) => {
  console.log('BP public route hit');
  try {
    const profiles = await BusinessProfile.find({ published: true }).sort({ createdAt: -1 });
    console.log('Profiles fetched:', profiles);  // <-- Add this
    res.json(profiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


module.exports = router;
