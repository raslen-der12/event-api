/**************************************************************************************************
 *  ADMIN CONTROLLER  (Part 2)  —  “People” management
 *  -------------------------------------------------------------------------------------------
 *  Exports (to be wired in routes later):
 *
 *    • createActor        – POST /admins/actors
 *    • createAdmin        – POST /admins
 *    • updateAdmin        – PATCH /admins/:id
 *    • listAdmins         – GET  /admins?role=normal
 *
 *  Helpers:
 *    • hasPerm(adminDoc, perm)      -> Boolean
 *    • logAdminAction(admin, action, target, targetId, payload)
 *
 *  Permissions strings (examples):
 *      'admins.write', 'admins.read', 'actors.create', 'stats.view'
 **************************************************************************************************/

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');

const asyncHandler = require('express-async-handler');
const Admin        = require('../models/admin');
const attendee     = require('../models/attendee');
const Exhibitor    = require('../models/exhibitor');
const Speaker      = require('../models/speaker');
const AdminActivity= require('../models/adminActivity');
const Setting    = require('../models/adminSetting');

const dayjs          = require('dayjs');
const { Parser } = require('json2csv');
const Event          = require('../models/event');
const EventBill      = require('../models/eventModels/bill');
const EventTicket    = require('../models/eventModels/ticket');

const AdminChatRoom  = require('../models/adminChatRoom');
const AdminChatMsg   = require('../models/adminChatMessage');
const AdminCal       = require('../models/adminCalendar');
const AdminNotif     = require('../models/adminNotification');

/* ────────────────────── small helpers ─────────────────────────── */
const ACTOR_MODEL = { attendee:attendee, exhibitor:Exhibitor, speaker:Speaker };

const hasPerm = (adminDoc, perm) =>
  adminDoc.role === 'super' || adminDoc.permissions.includes(perm);

const logAdminAction = async (admin, action, target, targetId, payload={}) => {
  await AdminActivity.create({
    adminId : admin._id,
    ip      : admin._reqIp || '',   // set by middleware if you like
    ua      : admin._ua    || '',
    action, target, targetId, payload
  });
};

/* ────────────────────── 1. createActor ───────────────────────────
   Body: { type:'attendee'|'exhibitor'|'speaker', email, pwd, extra:{} }
   Only admins with 'actors.create' can call.
-------------------------------------------------------------------*/
exports.createActor = asyncHandler(async (req, res) => {
  const admin = req.user;                       // set by protect middleware
  if (!hasPerm(admin, 'actors.create'))
    return res.status(403).json({ message:'No permission' });

  const { type, email, pwd, extra={} } = req.body;
  if (!type || !email || !pwd) return res.status(400).json({ message:'type, email, pwd required' });
  if (!['attendee','exhibitor','speaker'].includes(type))
    return res.status(400).json({ message:'Unknown actor type' });

  const Model = ACTOR_MODEL[type];
  const exists = await Model.findOne({ 'personal.email': email.toLowerCase() })
                 || await Model.findOne({ 'identity.email': email.toLowerCase() });
  if (exists) return res.status(409).json({ message:'Email already in use' });

  const docData = {
    verified : true,
    pwd,
    id_event : extra.eventId || null,
    ...(type==='exhibitor'
        ? { identity:{ email:email.toLowerCase(), exhibitorName:extra.name||email } }
        : { personal:{ email:email.toLowerCase(), fullName:extra.name||email } })
  };
  const actor = await Model.create(docData);
  await logAdminAction(admin,'createActor',type,actor._id,{ email });

  res.status(201).json({ success:true, data:{ actorId:actor._id } });
});

/* ────────────────────── 2. createAdmin ───────────────────────────
   Only SUPER admins can create another admin.
-------------------------------------------------------------------*/
exports.createAdmin = asyncHandler(async (req, res) => {
  const superAdmin = req.user;
  if (superAdmin.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const { email, pwd, permissions=[], role='normal', fullName } = req.body;
  if (!email || !pwd) return res.status(400).json({ message:'email, pwd required' });

  const exists = await Admin.findOne({ email:email.toLowerCase() });
  if (exists) return res.status(409).json({ message:'E-mail already taken' });

  const newAdmin = await Admin.create({ email:email.toLowerCase(), pwd, role, permissions, fullName });
  await logAdminAction(superAdmin,'createAdmin','admin',newAdmin._id,{ role });

  res.status(201).json({ success:true, data:{ adminId:newAdmin._id } });
});

/* ────────────────────── 3. updateAdmin ───────────────────────────
   Admin can update own profile.
   Super admin can update anyone (including permissions).
-------------------------------------------------------------------*/
exports.updateAdmin = asyncHandler(async (req, res) => {
  const me   = req.user;
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message:'Bad id' });

  const target = await Admin.findById(id).select('+pwd');
  if (!target) return res.status(404).json({ message:'Not found' });

  const canEdit =
        me.role === 'super' ||
        me._id.toString() === id;
  if (!canEdit) return res.status(403).json({ message:'No permission' });

  const { fullName, avatar, pwd, permissions } = req.body;
  if (fullName !== undefined) target.fullName = fullName;
  if (avatar   !== undefined) target.avatar   = avatar;

  if (pwd){
    if (me.role !== 'super' && me._id.toString() !== id)
      return res.status(403).json({ message:'Only super or self can change password' });
    const salt = await bcrypt.genSalt(12);
    target.pwd = await bcrypt.hash(pwd, salt);
    target.lastPwdChange = Date.now();
  }

  if (permissions !== undefined){
    if (me.role !== 'super')
      return res.status(403).json({ message:'Only super admin can edit permissions' });
    target.permissions = permissions;
  }

  await target.save();
  await logAdminAction(me,'updateAdmin','admin',id,{ changed: Object.keys(req.body) });

  res.json({ success:true, data:{ adminId:id } });
});

/* ────────────────────── 4. listAdmins ────────────────────────────
   Query ?role=normal|super
-------------------------------------------------------------------*/
exports.listAdmins = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin, 'admins.read'))
    return res.status(403).json({ message:'No permission' });

  const { role } = req.query;
  const q = role ? { role } : {};
  const rows = await Admin.find(q).select('-pwd').lean();
  res.json({ success:true, count:rows.length, data:rows });
});
exports.getGlobalStats = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin, 'stats.view'))
    return res.status(403).json({ message:'No permission' });

  const [events, bills, tickets] = await Promise.all([
    Event.countDocuments(),
    EventBill.aggregate([
      { $match:{ status:'paid' } },
      { $group:{ _id:null, total:{ $sum:'$total' }, count:{ $sum:1 } } }
    ]),
    EventTicket.countDocuments()
  ]);

  res.json({
    success:true,
    data:{
      totalEvents : events,
      totalRevenue: bills[0]?.total || 0,
      paidBills   : bills[0]?.count || 0,
      ticketsSold : tickets
    }
  });
});

/* ───────────────────── DASHBOARD: EVENT STATS ─────────────────────
   GET /admins/stats/event/:eventId
------------------------------------------------------------------------*/
exports.getEventStats = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin, 'stats.view'))
    return res.status(403).json({ message:'No permission' });

  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message:'Bad id' });

  const [bills, tickets] = await Promise.all([
    EventBill.aggregate([
      { $match:{ id_event: new mongoose.Types.ObjectId(eventId), status:'paid' } },
      { $group:{ _id:null, total:{ $sum:'$total' }, count:{ $sum:1 } } }
    ]),
    EventTicket.countDocuments({ id_event:eventId })
  ]);

  res.json({
    success:true,
    data:{
      revenue     : bills[0]?.total || 0,
      paidBills   : bills[0]?.count || 0,
      ticketsSold : tickets
    }
  });
});

/* ───────────────────── DASHBOARD: REVENUE CHART ───────────────────
   GET /admins/stats/revenue?eventId=&days=30
   Returns daily totals for line chart
------------------------------------------------------------------------*/
exports.getRevenueTrend = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin, 'stats.view'))
    return res.status(403).json({ message:'No permission' });

  const { eventId, days=30 } = req.query;
  const from = dayjs().subtract(Number(days)-1,'day').startOf('day').toDate();

  const match = {
    status:'paid',
    createdAt:{ $gte:from }
  };
  if (eventId && mongoose.isValidObjectId(eventId))
    match.id_event = new mongoose.Types.ObjectId(eventId);

  const rows = await EventBill.aggregate([
    { $match:match },
    { $group:{
        _id:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' }},
        total:{ $sum:'$total' }
    }},
    { $sort:{ _id:1 } }
  ]);

  res.json({ success:true, data:rows });
});

/* ───────────────────── CHAT: send message ─────────────────────────
   POST /admins/chat/:roomId  { text, files[] }
------------------------------------------------------------------------*/
exports.sendChatMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { text, files=[] } = req.body;

  const room = await AdminChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Room not found' });

  if (!room.members.some(id=> id.equals(req.user._id)))
    return res.status(403).json({ message:'Not a room member' });

  const msg = await AdminChatMsg.create({
    roomId, senderId:req.user._id, text, files
  });

  // emit real-time via Socket.IO
  req.app.locals.io.to(roomId).emit('chat:newMessage', { roomId, msg });

  res.status(201).json({ success:true, data:{ messageId:msg._id } });
});

/* ───────────────────── CHAT: list messages ────────────────────────
   GET /admins/chat/:roomId?limit=50&before=<msgId>
------------------------------------------------------------------------*/
exports.listChatRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { limit=50, before } = req.query;

  const room = await AdminChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Room not found' });
  if (!room.members.some(id=> id.equals(req.user._id)))
    return res.status(403).json({ message:'Not a room member' });

  const query = { roomId };
  if (before && mongoose.isValidObjectId(before))
    query._id = { $lt:before };

  const msgs = await AdminChatMsg.find(query)
                .sort({ _id:-1 })
                .limit(Number(limit))
                .lean();

  res.json({ success:true, count:msgs.length, data:msgs.reverse() });
});

/* ───────────────────── NOTIF: mark read ───────────────────────────
   PATCH /admins/notifs/:id/read
------------------------------------------------------------------------*/
exports.markNotificationRead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const notif = await AdminNotif.findOneAndUpdate(
    { _id:id, adminId:req.user._id },
    { read:true },
    { new:true }
  );
  if (!notif) return res.status(404).json({ message:'Not found' });
  res.json({ success:true });
});

/* ───────────────────── CALENDAR: create entry ─────────────────────
   POST /admins/calendar  { title,start,end,location,notes }
------------------------------------------------------------------------*/
exports.createCalendarEntry = asyncHandler(async (req, res) => {
  const { title, start, end, location, notes } = req.body;
  if (!title || !start || !end)
    return res.status(400).json({ message:'title, start, end required' });

  const entry = await AdminCal.create({
    adminId : req.user._id,
    title, start, end, location, notes
  });
  res.status(201).json({ success:true, data:{ entryId:entry._id } });
});

/* ───────────────────── CALENDAR: list entries ─────────────────────
   GET /admins/calendar?from=&to=
------------------------------------------------------------------------*/
exports.listCalendar = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const query = { adminId:req.user._id };
  if (from || to){
    query.start = {};
    if (from) query.start.$gte = new Date(from);
    if (to)   query.start.$lte = new Date(to);
  }
  const rows = await AdminCal.find(query).sort({ start:1 }).lean();
  res.json({ success:true, count:rows.length, data:rows });
});


exports.getAuditLogs = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin,'audit.view'))
    return res.status(403).json({ message:'No permission' });

  const { adminId, page=1, limit=50 } = req.query;
  const q = adminId && mongoose.isValidObjectId(adminId) ? { adminId } : {};
  const rows = await AdminActivity.find(q)
                 .sort({ createdAt:-1 })
                 .skip((page-1)*limit)
                 .limit(Number(limit))
                 .lean();
  res.json({ success:true, count:rows.length, data:rows });
});

/* ─────────────────── 2. CHAT: create room ───────────────────────
   POST /admins/chat/room  { title, memberIds[] }
------------------------------------------------------------------*/
exports.createChatRoom = asyncHandler(async (req, res) => {
  const { title, memberIds=[] } = req.body;
  if (!title) return res.status(400).json({ message:'title required' });

  const members = [...new Set([...memberIds, req.user._id.toString()])]
                  .filter(id=> mongoose.isValidObjectId(id));

  const room = await AdminChatRoom.create({ title, members });
  await logAdminAction(req.user,'createChatRoom','chatRoom', room._id, { title });

  res.status(201).json({ success:true, data:{ roomId:room._id } });
});

/* ─────────────────── 3. CHAT: list my rooms ─────────────────────
   GET /admins/chat/rooms
------------------------------------------------------------------*/
exports.listChatRooms = asyncHandler(async (req, res) => {
  const rooms = await AdminChatRoom.find({ members:req.user._id }).lean();
  res.json({ success:true, count:rooms.length, data:rooms });
});

/* ─────────────────── 4. CHAT: leave room ────────────────────────
   PATCH /admins/chat/room/:roomId/leave
------------------------------------------------------------------*/
exports.leaveChatRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  await AdminChatRoom.updateOne(
    { _id:roomId },
    { $pull:{ members:req.user._id } }
  );
  await logAdminAction(req.user,'leaveChatRoom','chatRoom',roomId);
  res.json({ success:true });
});

/* ─────────────────── 5. ENABLE / DISABLE ADMIN ──────────────────
   PATCH /admins/:id/toggle  { enabled:true|false }
------------------------------------------------------------------*/
exports.toggleAdminState = asyncHandler(async (req, res) => {
  const superAdmin = req.user;
  if (superAdmin.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const { id } = req.params;
  const { enabled } = req.body;
  if (enabled === undefined)
    return res.status(400).json({ message:'enabled flag required' });

  const adm = await Admin.findById(id);
  if (!adm) return res.status(404).json({ message:'Not found' });
  if (adm.role === 'super' && !enabled)
    return res.status(400).json({ message:'Cannot disable another super admin' });

  adm.disabled = !enabled;
  await adm.save();
  await logAdminAction(superAdmin,'toggleAdmin','admin',id,{ enabled });
  res.json({ success:true, data:{ adminId:id, enabled } });
});

/* ─────────────────── 6. EXPORT EVENT REVENUE CSV ────────────────
   GET /admins/stats/event/:eventId/csv
------------------------------------------------------------------*/
exports.exportEventRevenueCSV = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin,'stats.view'))
    return res.status(403).json({ message:'No permission' });

  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message:'Bad id' });

  const event = await Event.findById(eventId).lean();
  if (!event) return res.status(404).json({ message:'Event not found' });

  const rows = await EventBill.find({ id_event:eventId, status:'paid' })
                 .select('createdAt total currency')
                 .lean();

  const parser = new Parser({ fields:['createdAt','total','currency'] });
  const csv    = parser.parse(rows);

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="revenue_${eventId}.csv"`);
  res.send(csv);
});

exports.broadcastNotification = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (admin.role !== 'super' && !hasPerm(admin, 'notifs.broadcast'))
    return res.status(403).json({ message:'No permission' });

  const { title, body, role='all', permission } = req.body;
  if (!title) return res.status(400).json({ message:'title required' });

  /* build target query */
  const q = {};
  if (role !== 'all') q.role = role;                  // 'normal' | 'super'
  if (permission)      q.permissions = permission;    // admins having that perm

  const targets = await Admin.find(q).select('_id email').lean();

  const docs = targets.map(a => ({
    adminId : a._id,
    title, body
  }));
  await AdminNotif.insertMany(docs, { ordered:false });

  await logAdminAction(admin,'broadcastNotif','adminNotification',null,{ count:targets.length });
  res.json({ success:true, sent:targets.length });
});

/* ─────────────────── 2. UPDATE PERMISSIONS ─────────────────────────
   PATCH /admins/:id/permissions  { permissions:[] }
 --------------------------------------------------------------------*/
exports.updateAdminPermissions = asyncHandler(async (req, res) => {
  const superAdmin = req.user;
  if (superAdmin.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const { id } = req.params;
  const { permissions } = req.body;
  if (!Array.isArray(permissions))
    return res.status(400).json({ message:'permissions array required' });

  const adm = await Admin.findByIdAndUpdate(id,{ permissions },{ new:true });
  if (!adm) return res.status(404).json({ message:'Not found' });

  await logAdminAction(superAdmin,'updatePermissions','admin',id,{ permissions });
  res.json({ success:true, data:{ adminId:id, permissions } });
});

/* ─────────────────── 3. DELETE CALENDAR ENTRY ─────────────────────
   DELETE /admins/calendar/:entryId
 -------------------------------------------------------------------*/
exports.deleteCalendarEntry = asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const entry = await AdminCal.findById(entryId);
  if (!entry) return res.status(404).json({ message:'Not found' });

  const mayDelete = entry.adminId.equals(req.user._id) || req.user.role==='super';
  if (!mayDelete) return res.status(403).json({ message:'No permission' });

  await entry.remove();
  res.json({ success:true });
});

/* ─────────────────── 4. DELETE CHAT MESSAGE ───────────────────────
   DELETE /admins/chat/:msgId
 -------------------------------------------------------------------*/
exports.deleteChatMessage = asyncHandler(async (req, res) => {
  const { msgId } = req.params;
  const msg = await AdminChatMsg.findById(msgId);
  if (!msg) return res.status(404).json({ message:'Not found' });

  const mayDelete = msg.senderId.equals(req.user._id) || req.user.role==='super';
  if (!mayDelete) return res.status(403).json({ message:'No permission' });

  await msg.remove();
  // notify room (front-end can grey out or remove message)
  req.app.locals.io.to(msg.roomId.toString()).emit('chat:deleted', { msgId });
  res.json({ success:true });
});

/* ─────────────────── 5. DELETE CHAT ROOM (super) ──────────────────
   DELETE /admins/chat/room/:roomId
 -------------------------------------------------------------------*/
exports.deleteChatRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  if (req.user.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const room = await AdminChatRoom.findById(roomId);
  if (!room) return res.status(404).json({ message:'Not found' });

  await AdminChatMsg.deleteMany({ roomId });
  await room.remove();
  res.json({ success:true });
});

/* ─────────────────── 6. PERMANENTLY DELETE ADMIN ─────────────────-
   DELETE /admins/:id
 -------------------------------------------------------------------*/
exports.deleteAdmin = asyncHandler(async (req, res) => {
  const superAdmin = req.user;
  if (superAdmin.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const { id } = req.params;
  const target = await Admin.findById(id);
  if (!target) return res.status(404).json({ message:'Not found' });
  if (target.role === 'super')
    return res.status(400).json({ message:'Cannot delete another super admin' });

  await target.remove();
  await logAdminAction(superAdmin,'deleteAdmin','admin',id);
  res.json({ success:true });
});


exports.impersonateActor = asyncHandler(async (req, res) => {
  const superAdmin = req.user;
  if (superAdmin.role !== 'super')
    return res.status(403).json({ message:'Super admin only' });

  const { type, id } = req.params;
  if (!ACTOR_MODEL[type])
    return res.status(400).json({ message:'Bad type' });

  const actor = await ACTOR_MODEL[type].findById(id).lean();
  if (!actor) return res.status(404).json({ message:'Not found' });

  /* create short-lived JWT */
  const email = type==='exhibitor' ? actor.identity.email : actor.personal.email;
  const token = jwt.sign(
    { UserInfo:{ email, role:type }, impersonated:true, by:superAdmin._id },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn:'30m' }
  );

  await logAdminAction(superAdmin,'impersonate',type,id);
  res.json({ success:true, data:{ accessToken:token, expiresIn:'30m' } });
});

/* ─────────────────── 2. RESET ACTOR PASSWORD ───────────────────────
   PATCH /admins/actors/:type/:id/pwd  { newPwd? }
------------------------------------------------------------------------*/
exports.resetActorPassword = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (admin.role !== 'super' && !hasPerm(admin,'actors.resetPwd'))
    return res.status(403).json({ message:'No permission' });

  const { type, id } = req.params;
  const { newPwd }   = req.body;

  const Model = ACTOR_MODEL[type];
  if (!Model) return res.status(400).json({ message:'Bad type' });

  const actor = await Model.findById(id).select('+pwd');
  if (!actor) return res.status(404).json({ message:'Not found' });

  const plain = newPwd || crypto.randomBytes(4).toString('hex'); // e.g. "9f4b7d2a"
  const salt  = await bcrypt.genSalt(12);
  actor.pwd   = await bcrypt.hash(plain, salt);
  actor.lastPwdChange = Date.now();
  await actor.save();

  const email = type==='exhibitor' ? actor.identity.email : actor.personal.email;
  await AdminNotif.create({
    adminId: null,
    title  : 'Password reset',
    body   : `Your new temporary password: ${plain}`,
    link   : '',
    createdAt: Date.now()
  });

  await logAdminAction(admin,'resetActorPwd',type,id);
  res.json({ success:true, data:{ tempPwd: newPwd?undefined:plain } });
});

/* ─────────────────── 3. CSV EXPORT OF ACTORS ───────────────────────
   GET /admins/actors/csv?type=&verified=&from=&to=
------------------------------------------------------------------------*/
exports.exportActorsCSV = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (!hasPerm(admin,'actors.export'))
    return res.status(403).json({ message:'No permission' });

  const { type='attendee', verified, from, to } = req.query;
  const Model = ACTOR_MODEL[type];
  if (!Model) return res.status(400).json({ message:'Bad type' });

  const q = {};
  if (verified !== undefined) q.verified = verified === 'true';
  if (from || to){
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to)   q.createdAt.$lte = new Date(to);
  }

  const rows = await Model.find(q).lean();
  const parser = new Parser();
  const csv = parser.parse(rows);

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${type}_export.csv"`);
  res.send(csv);
});

/* ─────────────────── 4. SETTINGS CRUD (simple) ────────────────────
   GET /admins/settings
   PATCH /admins/settings  { key, value }
------------------------------------------------------------------------*/
exports.getSettings = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (admin.role !== 'super') return res.status(403).json({ message:'Super only' });

  const rows = await Setting.find().lean();
  res.json({ success:true, data:rows });
});

exports.setSettings = asyncHandler(async (req, res) => {
  const admin = req.user;
  if (admin.role !== 'super') return res.status(403).json({ message:'Super only' });

  const { key, value, description } = req.body;
  if (!key) return res.status(400).json({ message:'key required' });

  const s = await Setting.findOneAndUpdate(
    { key },
    { value, description },
    { new:true, upsert:true }
  );
  await logAdminAction(admin,'setSetting','setting',s._id,{ key });
  res.json({ success:true, data:s });
});