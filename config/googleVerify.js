// utils/googleVerify.js
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const jwt    = require('jsonwebtoken');

exports.verifyIdToken = async (idToken) => {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();      // { sub, email, name, picture, ... }
  return {
    googleId: payload.sub,
    email:    payload.email,
    name:     payload.name,
    picture:  payload.picture,
    emailVerified: payload.email_verified
  };
};
