require('dotenv').config({ path: '../.env' });

const allowedOrigins = [
  'http://eventra.cloud',
  'https://eventra.cloud',
  'http://www.eventra.cloud',
  'https://www.eventra.cloud',
  'http://api.eventra.cloud',
  'https://api.eventra.cloud',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

module.exports = allowedOrigins;

