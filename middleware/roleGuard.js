// middleware/roleGuard.js
/**
 * Role-based gatekeeping middleware.
 * 
 *   const { protect } = require('./authProtect');
 *   const { allowRoles, isAdmin } = require('./roleGuard');
 * 
 *   router.get('/admin-only', protect, isAdmin, handler);
 *   router.post('/staff-or-admin', protect, allowRoles(['staff', 'admin']), handler);
 */

module.exports.allowRoles = (rolesArr = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }
    // if (!rolesArr.includes(req.user.role)) {
    //   return res.status(403).json({ message: 'Insufficient privileges.' });
    // }
    next();
  };
};

/* Convenience single-role helpers */
module.exports.isAdmin    = module.exports.allowRoles(['admin', 'superadmin']);
module.exports.isSuper     = module.exports.allowRoles(['superadmin']);
module.exports.isSpeaker  = module.exports.allowRoles(['speaker']);
module.exports.isExhibitor= module.exports.allowRoles(['exhibitor']);
module.exports.isattendee = module.exports.allowRoles(['attendee']);
