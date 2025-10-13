const express = require('express')
const router = express.Router()
const authCtrl = require('../controllers/authController')
const loginLimiter = require('../middleware/loginLimiter')
const { protect } = require('../middleware/authProtect');
const googleCtrl = require('../config/googleVerify');
const { imageUploader } = require('../middleware/uploader');
router.post('/login',loginLimiter,   authCtrl.login);
router.get ('/refresh', authCtrl.refresh); 
router.post('/logout',  protect, authCtrl.logout);

router.post('/register/attendee', imageUploader.single('photo') ,  authCtrl.registerAttendee);   
router.post('/register/exhibitor',imageUploader.single('logo'), authCtrl.registerExhibitor);

router.post ('/verify-email',        authCtrl.verifyEmail);
router.post('/resend-verification', authCtrl.resendVerification);
router.post('/forgot-password', authCtrl.forgotPassword);
router.post('/reset-password',  authCtrl.resetPassword);

router.get ('/google', googleCtrl.verifyIdToken);
router.post('/resend-verification/:actorId',authCtrl.resendVerificationById);
router.post('/set-password', authCtrl.setPassword);          // { id, role, pwd }
router.post('/change-email', authCtrl.changeEmail);          // { id, role, newEmail }
router.post('/restore-email', authCtrl.restoreEmail);


module.exports = router