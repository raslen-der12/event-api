// middleware/authProtect.js
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '../.env' });

module.exports.protect = (req, res, next) => {
  try {
    let token;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      token = auth.split(' ')[1];
    } else if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    } else if (req.cookies?.jwt) {
      // pour compat avec loginUser/loginGoogle (refreshToken)
      token = req.cookies.accessToken || null;
    }

    if (!token) {
      return res.status(401).json({ message: 'No token. Authorization denied.' });
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const info    = decoded.UserInfo || {};

    req.user = {
      email    : info.email,
      role     : info.role,
      _id      : info.ActorId || info.userId,
      userId   : info.userId || info.ActorId,
      actorType: info.actorType || null,
      subRole  : info.subRole || [],
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalid or expired.' });
  }
};
