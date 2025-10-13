/*──────────────────────── Dependencies ─────────────────────────*/
const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const bcrypt       = require('bcrypt');
const crypto       = require('crypto');
const Event        = require('../models/event');
const EventBill    = require('../models/eventModels/bill');
const EmailCode    = require('../models/emailCode');
const EventTicket  = require('../models/eventModels/ticket');
const jwt          = require('jsonwebtoken');
const QRCode       = require('qrcode');
const { sendMail , sendCode } = require('../config/mailer');
// const Bank = require('../config/bankGateway');
require('dotenv').config({ path: '../.env' });

exports.refund = async (chargeId, amount) => {
  try {
    const { data } = await api.post(`/payments/${chargeId}/refund`, { amount });
    return { ok:true, refundId: data.id };
  } catch (err) {
    return { ok:false, msg: err.response?.data?.message || 'Refund failed' };
  }
};
/* config */
const PRICE_MAP  = { silver: 79, gold: 129, vip: 199 };
const TAX_RATE   = 0.07;
const EMAIL_RX   = /^[\w.-]+@[\w.-]+\.[\w-]{2,}$/;

/* fake bank sandbox pre-auth */
async function sandboxCardCheck(card, amount) {
  // pretend: validate Luhn, expiry, balance ≥ amount
  await new Promise(r => setTimeout(r, 400));
  const luhnOk = /^\d{16}$/.test(card.number);          // super-simple
  return luhnOk ? { ok:true, holdRef:`hold_${Date.now()}` }
                : { ok:false, msg:'Card declined' };
}

/*────────────────────── INITIATE PURCHASE ─────────────────────*/
exports.initPurchase = asyncHandler(async (req, res) => {
  const {
    eventId,
    ticketType = 'silver',
    currency  = 'USD',
    guest     = {},
    card      = {}          // { number, expMonth, expYear, cvv }
  } = req.body;

  /* 1. basic validation -------------------------------------------------- */
  if (!mongoose.isValidObjectId(eventId))
    return res.status(400).json({ message:'Invalid eventId' });
  if (!['silver','gold','vip'].includes(ticketType))
    return res.status(400).json({ message:'ticketType must be silver|gold|vip' });
  if (!EMAIL_RX.test(guest.email || ''))
    return res.status(400).json({ message:'Valid guest.email required' });

  /* 2. event & capacity -------------------------------------------------- */
  const event = await Event.findById(eventId).exec();
  if (!event) return res.status(404).json({ message:'Event not found' });
  if (event.capacity && event.seatsTaken >= event.capacity)
    return res.status(409).json({ message:'Event sold out' });

  /* 3. pricing ----------------------------------------------------------- */
  const subtotal = PRICE_MAP[ticketType];
  const taxAmt   = subtotal * TAX_RATE;
  const total    = subtotal + taxAmt;

  /* 4. sandbox card pre-authorisation ----------------------------------- */
  const bank = await sandboxCardCheck(card, total);
//   const bank = await Bank.preAuth(card, total, currency);
  if (!bank.ok) return res.status(402).json({ message: bank.msg || 'Card check failed' });

  /* 5. create pending bill ---------------------------------------------- */
  const bill = await EventBill.create({
    id_event : eventId,
    id_actor : null,                    // will attach after e-mail verify
    actorModel:'attendee',
    currency,
    subtotal,
    taxRate : TAX_RATE,
    discount: 0,
    status  : 'pending_email',
    method  : 'card',
    gatewayRef: bank.holdRef
  });

  /* 6. generate & e-mail 6-digit code ----------------------------------- */
  const rawCode  = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(rawCode, 12);

  await EmailCode.create({
    billId : bill._id,
    email  : guest.email.toLowerCase(),
    codeHash,
    expires: Date.now() + 10 * 60_000      // 10 min TTL
  });

  await sendCode(guest.email, rawCode, 10);

  /* 7. respond ----------------------------------------------------------- */
  return res.status(200).json({
    step   : 'VERIFY_EMAIL_CODE',
    billId : bill._id,
    message: 'A verification code has been sent to your e-mail.'
  });
});


async function sandboxCapture(holdRef) {
  await new Promise(r => setTimeout(r, 300));
  return { ok: true, captureId: `cap_${Date.now()}` };
}

/* reuse guest-creation helper */
async function ensureGuest(guest) {
  const email = guest?.email?.toLowerCase();
  if (!EMAIL_RX.test(email)) throw new Error('Valid guest email required');
  let user = await attendee.findOne({ email }).exec();
  if (!user) {
    user = await attendee.create({
      email,
      name: guest.name || email.split('@')[0],
      pwd: '',
      verified: true
    });
  }
  return user;
}

/* ─── VERIFY E-MAIL CODE & ISSUE TICKET ─────────────────────────── */
exports.verifyEmailCode = asyncHandler(async (req, res) => {
  const { billId, code, guest = {} } = req.body;

  /* 1. sanity ----------------------------------------------------------- */
  if (!mongoose.isValidObjectId(billId))
    return res.status(400).json({ message: 'Invalid billId' });
  if (!/^\d{6}$/.test(code))
    return res.status(400).json({ message: 'Code must be 6 digits' });

  /* 2. fetch EmailCode -------------------------------------------------- */
  const entry = await EmailCode.findOne({ billId, used: false }).exec();
  if (!entry || entry.expires < Date.now())
    return res.status(403).json({ message: 'Code expired. Start over.' });

  const ok = await bcrypt.compare(code, entry.codeHash);
  if (!ok) return res.status(403).json({ message: 'Invalid code' });

  entry.used = true;
  await entry.save();

  /* 3. fetch Bill & Event ---------------------------------------------- */
  const bill = await EventBill.findById(billId).exec();
  if (!bill || bill.status !== 'pending_email')
    return res.status(400).json({ message: 'Bill not in pending state' });

  const event = await Event.findById(bill.id_event).exec();
  if (!event) return res.status(404).json({ message: 'Event missing' });
  if (event.capacity && event.seatsTaken >= event.capacity)
    return res.status(409).json({ message: 'Sold-out while waiting; refund will process.' });

  /* 4. resolve actor ---------------------------------------------------- */
  let actorId   = req.user?._id;
  let actorType = req.user?.role;

  if (!actorId) {
    try {
      const guestUser = await ensureGuest({ name: guest.name, email: entry.email });
      actorId   = guestUser._id;
      actorType = 'attendee';
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }
  }

  /* 5. capture payment hold -------------------------------------------- */
  const cap = await sandboxCapture(bill.gatewayRef);
//   const cap = await Bank.capture(bill.gatewayRef, bill.total);
  if (!cap.ok) return res.status(500).json({ message: 'Payment capture failed' });

  /* 6. finalise Bill ---------------------------------------------------- */
  bill.status      = 'paid';
  bill.paidAt      = Date.now();
  bill.id_actor    = actorId;
  bill.actorModel  = actorType;
  await bill.save();

  /* 7. create Ticket ---------------------------------------------------- */
  const ticket = await EventTicket.create({
    id_event : bill.id_event,
    id_actor : actorId,
    actorModel: actorType,
    id_bill  : bill._id,
    ticketType: 'silver'   // adjust when you store chosen type
  });

  /* 8. generate QR-code -------------------------------------------------- */
  const qrToken = jwt.sign(
    { tid: ticket._id.toString(), aid: actorId.toString() },
    process.env.QR_SECRET,
    { expiresIn: '4h' }
  );
  const qrUrl   = `${process.env.FRONTEND_URL}/scan?q=${qrToken}`;
  const qrData  = await QRCode.toDataURL(qrUrl, { margin: 1, width: 300 });

  ticket.qrCode = qrData;           // store data-URL in the doc
  await ticket.save();

  /* 9. increment capacity ---------------------------------------------- */
  await Event.updateOne({ _id: bill.id_event }, { $inc: { seatsTaken: 1 } }).exec();

  /* 10. send receipt with QR ------------------------------------------- */
  await sendMail(entry.email, 'Your Ticket & QR-Code',
    `<p>Payment successful! Show this QR at the entrance.</p>
     <p><img src="${qrData}" alt="QR Code" /></p>
     <p>Ticket ID: ${ticket._id}</p>
     <p>Total Paid: ${bill.total} ${bill.currency}</p>`);

  /* 11. response -------------------------------------------------------- */
  res.status(201).json({
    success: true,
    message: 'Ticket issued',
    data: {
      ticketId: ticket._id,
      billId  : bill._id,
      total   : bill.total,
      currency: bill.currency,
      status  : 'paid',
      qrCode  : qrData
    }
  });
});
function adminOnly(req, res) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ message: 'Admin rights required' });
}

/*────────────────────── REFUND endpoint ───────────────────
 *  POST /api/tickets/refund
 *  Body: { billId, reason }
 */
const sandboxRefund = async (chargeId, amount) => {
  await new Promise(r => setTimeout(r, 300));
    return { ok: true, refundId: `refund_${Date.now()}` };
};
exports.refundTicket = asyncHandler(async (req, res) => {
  if (adminOnly(req, res)) return;   // simple gate

  const { billId, reason = '' } = req.body;

  if (!mongoose.isValidObjectId(billId))
    return res.status(400).json({ message: 'Invalid billId' });

  const bill = await EventBill.findById(billId).exec();
  if (!bill)  return res.status(404).json({ message: 'Bill not found' });
  if (bill.status !== 'paid')
    return res.status(400).json({ message: 'Only PAID bills can be refunded' });

  /* 1. Initiate refund with bank --------------------------------------- */
  const refundRes =
    // await Bank.refund(bill.gatewayRef, bill.total);  // REAL bank call
    await sandboxRefund(bill.gatewayRef, bill.total); // ← Uncomment if you keep a sandbox

  if (!refundRes.ok)
    return res.status(502).json({ message: `Gateway error: ${refundRes.msg}` });

  /* 2. Update bill & ticket ------------------------------------------- */
  bill.status   = 'refunded';
  bill.updatedAt = Date.now();
  await bill.save();

  await EventTicket.updateOne(
    { id_bill: bill._id },
    { $set: { ticketType: 'refunded' } }
  ).exec();

  /* 3. Decrement event seatsTaken ------------------------------------- */
  await Event.updateOne(
    { _id: bill.id_event, seatsTaken: { $gt: 0 } },
    { $inc: { seatsTaken: -1 } }
  ).exec();

  /* 4. Notify customer ------------------------------------------------- */
  await sendMail(
    bill.actorModel === 'attendee' ? undefined : '', // unknown; add email lookup as needed
    'Your refund is processed',
    `<p>Your refund (bill ${billId}) has been processed.</p>
     <p>Amount: ${bill.total} ${bill.currency}</p>
     <p>Reason: ${reason}</p>`
  );

  res.json({ success:true, message:'Refund processed', data:{ refundId: refundRes.refundId } });
});


/*────────────────────── ADMIN LIST endpoint ───────────────────
 *  GET /api/bills?status=paid&eventId=...
 */
exports.listBills = asyncHandler(async (req, res) => {
  if (adminOnly(req, res)) return;

  const { status, eventId, page = 1, limit = 20 } = req.query;
  const query = {};
  if (status)  query.status   = status;
  if (eventId && mongoose.isValidObjectId(eventId))
    query.id_event = eventId;

  const bills = await EventBill.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .lean();

  res.json({ success:true, page:Number(page), count:bills.length, data:bills });
});