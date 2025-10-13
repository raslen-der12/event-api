/* utils/bankGateway.js
   Minimal wrapper around the bank’s “authorize / capture / refund” JSON API */

const axios = require('axios');

const baseURL   = process.env.BANK_BASE_URL;
const termId    = process.env.BANK_TERMINAL_ID;
const apiKey    = process.env.BANK_API_KEY;

if (!baseURL || !termId || !apiKey)
  throw new Error('BANK_* env vars missing');

/* Axios instance with auth header */
const api = axios.create({
  baseURL,
  headers: {
    'Content-Type' : 'application/json',
    'X-Terminal-ID': termId,
    'Authorization': `Bearer ${apiKey}`
  },
  timeout: 8000
});

/* ───────────────────────── AUTHORISE (pre-hold) ───────────────────────── */
/**
 * preAuth(card, amount, currency) → { ok, holdRef, msg }
 *  card = { number, expMonth, expYear, cvv }
 */
exports.preAuth = async (card, amount, currency) => {
  try {
    const { data } = await api.post('/payments/authorize', {
      amount, currency,
      card, capture: false   // pre-hold only
    });
    return { ok:true, holdRef: data.id };
  } catch (err) {
    return { ok:false, msg: err.response?.data?.message || 'Card declined' };
  }
};

/* ───────────────────────── CAPTURE (final charge) ───────────────────────── */
/**
 * capture(holdRef, amount) → { ok, captureId, msg }
 */
exports.capture = async (holdRef, amount) => {
  try {
    const { data } = await api.post(`/payments/${holdRef}/capture`, {
      amount
    });
    return { ok:true, captureId: data.id };
  } catch (err) {
    return { ok:false, msg: err.response?.data?.message || 'Capture failed' };
  }
};

/* ───────────────────────── REFUND (future Part 3) ───────────────────────── */
/**
 * refund(chargeId, amount) → { ok, refundId, msg }
 */
exports.refund = async (chargeId, amount) => {
  try {
    const { data } = await api.post(`/payments/${chargeId}/refund`, { amount });
    return { ok:true, refundId: data.id };
  } catch (err) {
    return { ok:false, msg: err.response?.data?.message || 'Refund failed' };
  }
};
