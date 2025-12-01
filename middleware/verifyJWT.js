// middleware/verifyJWT.js
const jwt = require('jsonwebtoken');

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(
    token,
    process.env.ACCESS_TOKEN_SECRET,
    (err, decoded) => {
      if (err) return res.status(403).json({ message: 'Forbidden' });

      const info = decoded.UserInfo || {};
      req.username = info.username || info.email || null;
      req.role     = info.role || 'user';
      req.userId   = info.userId || info.ActorId || null;
      req.email    = info.email || null;
      next();
    }
  );
};

module.exports = verifyJWT;
