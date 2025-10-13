// auth/ownership helpers for Business Profiles
module.exports.assertOwnerOrAdmin = (req, profile) => {
  if (!profile) throw new Error('Profile not found');
  const isOwner = String(profile?.owner?.actor) === String(req.user?.id);
  const isAdmin = !!req.user?.isAdmin;
  if (!isOwner && !isAdmin) {
    const e = new Error('Forbidden');
    e.statusCode = 403;
    throw e;
  }
};

module.exports.isOwner = (req, profile) => String(profile?.owner?.actor) === String(req.user?.id);
