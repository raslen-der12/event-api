// utils/bpUtil.js
const mongoose = require('mongoose');

const toStr = (v, max=4000) => String(v ?? '').trim().slice(0, max);

const normTags = (tags) => {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s;/|]+/);
  return Array.from(new Set(
    arr.map(s => String(s).toLowerCase().trim()).filter(Boolean)
  )).slice(0, 50);
};

const isId = (v) => mongoose.isValidObjectId(v);

const toLimit = (v, d=20, cap=200) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(1, n), cap) : d;
};

const escRx = (s='') => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const makeRx = (s='') => new RegExp(escRx(String(s)), 'i');

module.exports = { toStr, normTags, isId, toLimit, escRx, makeRx };
// utils/bpUtil.js (additions)
exports.toInt = (v, d=0) => {
  const n = Number(v); return Number.isFinite(n) ? n : d;
};

exports.paginate = (page, limit, max=200) => {
  const p = Math.max(1, exports.toInt(page, 1));
  const l = Math.min(Math.max(1, exports.toInt(limit, 20)), max);
  return { page: p, limit: l, skip: (p-1)*l };
};

exports.cleanStr = (s='') => String(s).replace(/\s+/g,' ').trim();
