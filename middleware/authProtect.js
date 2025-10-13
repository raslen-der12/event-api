// middleware/authProtect.js
/**
 * Verifies an **access JWT** and attaches `req.user`.
 *
 * 1. Looks for the token in:
 *      • `Authorization: Bearer <token>` header
 *      • `req.cookies.accessToken`   (if you decide to store it there)
 * 2. Decodes with `process.env.ACCESS_TOKEN_SECRET`
 * 3. On success → `req.user = { _id, email, role }` then `next()`
 * 4. On failure → 401 JSON
 */

const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '../.env' });

module.exports.protect = (req, res, next) => {
  try {
    /*──────────────────────── Locate token ───────────────────────*/
    let token;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      token = auth.split(' ')[1];
    } else if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return res.status(401).json({ message: 'No token. Authorization denied.' });
    }

    /*──────────────────────── Verify JWT ─────────────────────────*/
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    /* decoded.UserInfo = { email, role } set in your login controller */
    req.user = {
      email: decoded.UserInfo.email,
      role : decoded.UserInfo.role,
      _id  : decoded.UserInfo.ActorId     // include if you store _id in the payload
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalid or expired.' });
  }
};
