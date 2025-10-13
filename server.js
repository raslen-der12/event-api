// server.js
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const http         = require('http');
const mongoose     = require('mongoose');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const fs           = require('fs');

const connectDB    = require('./config/dbcon');
const corsOptions  = require('./config/corsOptions');
const errorHandler = require('./middleware/errorHandler');
const { logEvents }= require('./middleware/logger');

const app  = express();
const PORT = process.env.PORT || 3500;

/* 1) DB ------------------------------------------------------------------ */
connectDB();
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

mongoose.connection.on('error', err => {
  console.error('MongoDB runtime error:', err);
  logEvents(`${err}`, 'mongoErrLog.log');
});

mongoose.connection.once('open', () => {
  console.log('✅ Connected to MongoDB');

  // Start reminder engines AFTER connection is alive
  try {
    const eventCtrl = require('./controllers/eventController');
    if (eventCtrl?.initReminderEngine) eventCtrl.initReminderEngine(app);
  } catch (e) {
    console.warn('eventCtrl.initReminderEngine not initialized:', e?.message);
  }
  // Optional meetings engine:
  // try {
  //   const meetsCtrl = require('./controllers/meetsController');
  //   if (meetsCtrl?.initMeetingReminderEngine) meetsCtrl.initMeetingReminderEngine(app);
  // } catch {}
});

/* 2) Global middleware --------------------------------------------------- */

/* 3) Static & health ----------------------------------------------------- */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

/* Ensure chat upload dir exists */
fs.mkdirSync(path.join(__dirname, 'uploads', 'chat'), { recursive: true });

/* 4) Routes --------------------------------------------------------------- */
app.use('/auth',    require('./routes/authRoutes'));
app.use('/pay',     require('./routes/financeRoutes'));
app.use('/events',  require('./routes/eventRoutes'));
app.use('/meets',   require('./routes/meetsRoutes'));
app.use('/admin',   require('./routes/adminRoutes'));
app.use('/program', require('./routes/programRoutes'));
app.use('/selects', require('./routes/selectsRoutes'));
app.use('/biz', require("./routes/businessProfile.v2.routes"));
app.use('/pp', require("./routes/profile.v2.routes"));
app.use('/api', require("./routes/freightRoutes"));

// Admin chat REST lives under /admin/chat/*
app.use('/admin/chat', require('./routes/adminChatRoutes'));

// Actor-facing API (DMs, groups, comments, etc.)
app.use('/actors',  require('./routes/actorsRoutes'));

// 404
app.use((_req, res) => {
  console.log('404 Not Found');
  res.status(404).json({ message: '404 Not Found' });
});

/* 6) Error handler ------------------------------------------------------- */
app.use(errorHandler);

/* 7) HTTP + Socket.IO ---------------------------------------------------- */
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
  cors: { origin: '*' },
  path: process.env.SOCKET_PATH || '/socket.io',
});
app.locals.io = io;

/* Admin namespace sockets */
try {
  const adminChat = require('./controllers/adminChatController');
  if (typeof adminChat.initAdminChatSockets === 'function') {
    adminChat.initAdminChatSockets(app);
  }
} catch (e) {
  console.warn('initAdminChatSockets not wired:', e?.message);
}

/* Default namespace: actor chat basics */
io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);

  socket.on('joinRoom', (roomId, ack) => {
    if (roomId) {
      socket.join(roomId.toString());
      console.log('[socket] joinRoom', roomId);
      if (typeof ack === 'function') ack({ ok: true });
    } else if (typeof ack === 'function') {
      ack({ ok: false, error: 'bad-roomId' });
    }
  });

  socket.on('leaveRoom', (roomId, ack) => {
    if (roomId) {
      socket.leave(roomId.toString());
      console.log('[socket] leaveRoom', roomId);
      if (typeof ack === 'function') ack({ ok: true });
    } else if (typeof ack === 'function') {
      ack({ ok: false, error: 'bad-roomId' });
    }
  });

  socket.on('chat:typing', (payload) => {
    // payload: { roomId, isTyping, user }
    if (payload?.roomId) {
      socket.to(payload.roomId.toString()).emit('chat:typing', payload);
    }
  });

  socket.on('disconnect', () => {
    console.log('[socket] disconnected', socket.id);
  });
});

/* 8) Listen ---------------------------------------------------------------- */
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
