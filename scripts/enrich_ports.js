// server/scripts/enrich_ports.js
// Enrich server/data/ports.json with coords from public datasets.
// Usage:
//   cd server
//   npm install node-fetch@2 csv-parse lodash
//   node scripts/enrich_ports.js
//
// The script will:
// - back up data/ports.json -> data/ports.backup.json
// - download two datasets (primary JSON, fallback CSV)
// - merge coords into your ports list
// - write enriched file to data/ports.json (overwrite)
// - also write data/ports.enriched.json for inspection

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const _ = require('lodash');

const OUT_FILE = path.join(__dirname, '..', 'data', 'ports.json');
const BACKUP_FILE = path.join(__dirname, '..', 'data', 'ports.backup.json');
const ENRICHED_FILE = path.join(__dirname, '..', 'data', 'ports.enriched.json');

const TAYLJORDAN_URL = 'https://raw.githubusercontent.com/tayljordan/ports/master/ports.json';
const DATAHUB_CSV = 'https://datahub.io/core/un-locode/r/code-list.csv';

function normalizeId(s) {
  if (!s) return '';
  return String(s).replace(/[\s\-_]/g, '').toUpperCase();
}
function normalizeName(s) {
  if (!s) return '';
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').trim();
}
function isValidCoord(n) {
  return n !== null && n !== undefined && Number.isFinite(Number(n)) && Math.abs(Number(n)) > 0.000001;
}

// robust fetch detector
async function getFetchFn() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  try {
    // node-fetch v2
    const nf = require('node-fetch');
    return nf;
  } catch (e) {}
  // fallback: https GET
  const https = require('https');
  return async function fetchPoly(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(bufs);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => buffer.toString('utf8'),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            buffer: async () => buffer
          });
        });
      }).on('error', reject);
    });
  };
}

async function downloadText(url) {
  const fetchFn = await getFetchFn();
  const res = await fetchFn(url);
  if (!res || !res.ok) throw new Error(`Failed to download ${url} (status ${res && res.status})`);
  // try text
  if (typeof res.text === 'function') return await res.text();
  const buf = await res.buffer();
  return buf.toString('utf8');
}

async function downloadBuffer(url) {
  const fetchFn = await getFetchFn();
  const res = await fetchFn(url);
  if (!res || !res.ok) throw new Error(`Failed to download ${url} (status ${res && res.status})`);
  if (typeof res.buffer === 'function') return await res.buffer();
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// attempt to parse external JSON dataset (tayljordan)
async function loadTaylJordan() {
  try {
    const txt = await downloadText(TAYLJORDAN_URL);
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch (e) {
    console.warn('tayljordan data load failed:', e.message || e);
    return [];
  }
}

// parse datahub CSV into records
async function loadDatahubCsv() {
  try {
    const txt = await downloadText(DATAHUB_CSV);
    const recs = parse(txt, { columns: true, skip_empty_lines: true });
    return recs;
  } catch (e) {
    console.warn('DataHub CSV load failed:', e.message || e);
    return [];
  }
}

// robust extraction helpers for coordinates and ids from arbitrary record objects
function extractCoordsFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  // common keys
  const latKeys = ['lat', 'latitude', 'y', 'ycoord'];
  const lonKeys = ['lon', 'lng', 'longitude', 'x', 'xcoord', 'long'];
  for (const lk of latKeys) {
    for (const vk of lonKeys) {
      if (lk in rec && vk in rec) {
        const lat = parseFloat(rec[lk]);
        const lon = parseFloat(rec[vk]);
        if (isValidCoord(lat) && isValidCoord(lon)) return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
      }
    }
  }
  // some records have "coordinates" as "lat,lon" or "lat lon"
  const coordCandidates = ['coordinates', 'coordinate', 'location', 'latlon', 'geolocation'];
  for (const k of coordCandidates) {
    if (k in rec && rec[k]) {
      const txt = String(rec[k]).trim();
      // split by comma or whitespace
      const parts = txt.split(/[;,\/\s]+/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const a = parseFloat(parts[0]);
        const b = parseFloat(parts[1]);
        if (!Number.isNaN(a) && !Number.isNaN(b)) return { lat: +a.toFixed(6), lon: +b.toFixed(6) };
      }
    }
  }
  return null;
}
function extractIdFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const idCandidates = ['id','code','locode','un_locode','unlocode','UN/LOCODE','uniquecode'];
  for (const k of Object.keys(rec)) {
    const nk = k.toLowerCase().replace(/[^a-z0-9]/g,'');
    if (idCandidates.includes(nk) || idCandidates.includes(k.toLowerCase())) {
      const v = String(rec[k] || '').trim();
      if (v) return v;
    }
  }
  // fallback: try known fields
  if (rec.code) return String(rec.code);
  if (rec.UNLOCODE) return String(rec.UNLOCODE);
  if (rec['UN/LOCODE']) return String(rec['UN/LOCODE']);
  if (rec.Code) return String(rec.Code);
  return null;
}
function extractNameFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const nameCandidates = ['name','location','place','portname','locationname'];
  for (const k of Object.keys(rec)) {
    const lk = k.toLowerCase();
    if (nameCandidates.includes(lk) || /name/.test(lk)) {
      const v = String(rec[k] || '').trim();
      if (v) return v;
    }
  }
  // fallback: first string field
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim().length > 2) return v.trim();
  }
  return null;
}

(async function main() {
  try {
    console.log('Enrichment script starting...');

    // 1) load original ports.json
    let original = [];
    if (fs.existsSync(OUT_FILE)) {
      original = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      console.log('Loaded original ports.json with', original.length, 'entries');
    } else {
      console.log('No original ports.json found at', OUT_FILE, '- starting with an empty list');
      original = [];
    }

    // 2) backup original
    try {
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(original, null, 2), 'utf8');
      console.log('Backed up original to', BACKUP_FILE);
    } catch (e) {
      console.warn('Failed to write backup file:', e.message || e);
    }

    // 3) download external datasets
    console.log('Downloading external datasets (primary JSON and DataHub CSV)...');
    const [tayArr, datahubRecs] = await Promise.all([ loadTaylJordan(), loadDatahubCsv() ]);

    console.log('Primary JSON rows:', tayArr.length, 'DataHub CSV rows:', datahubRecs.length);

    // build lookup maps for external sets
    const tayById = {};
    const tayByName = {};
    for (const r of tayArr) {
      // try to find id/name/coords
      const id = extractIdFromRecord(r) || r.code || r.locode || r.id || r.UNLOCODE || r.UNLOCODE;
      const name = extractNameFromRecord(r) || r.name || r.port || r.city || r.location;
      const coords = extractCoordsFromRecord(r);
      if (id) tayById[normalizeId(id)] = { raw: r, id, name: name || id, coords };
      if (name) tayByName[normalizeName(name)] = { raw: r, id, name, coords };
    }

    // DataHub records -> map by id and name
    const dhById = {};
    const dhByName = {};
    for (const r of datahubRecs) {
      const rec = r;
      const id = rec['UN/LOCODE'] || rec.UNLOCODE || rec.UNLOC || rec.locode || rec.loc || rec.Code || rec.code || null;
      const name = rec.Name || rec.name || rec.Location || rec.location || rec['Location name'] || null;
      const coords = extractCoordsFromRecord(rec);
      if (id) dhById[normalizeId(id)] = { raw: rec, id, name: name || id, coords };
      if (name) dhByName[normalizeName(name)] = { raw: rec, id, name, coords };
    }

    // 4) Use merging strategy
    const merged = [];
    const stats = { total: 0, enriched: 0, kept: 0, addedFromExternal: 0, stillMissing: 0 };

    // first, index original by normalized id & name
    const origById = {};
    const origByName = {};
    for (const p of original) {
      const nid = normalizeId(p.id || '');
      const nname = normalizeName(p.name || '');
      if (nid) origById[nid] = p;
      if (nname) origByName[nname] = p;
    }

    // helper to pick coords from priority list
    function pickCoords(order) {
      for (const o of order) {
        if (o && o.coords && isValidCoord(o.coords.lat) && isValidCoord(o.coords.lon)) return o.coords;
      }
      return null;
    }

    // enrich existing originals
    for (const p of original) {
      stats.total++;
      const nid = normalizeId(p.id || '');
      const nname = normalizeName(p.name || '');
      let final = { id: p.id, name: p.name, lat: Number(p.lat || 0), lon: Number(p.lon || 0), source: 'original', confidence: 0 };

      // if original already has valid coords, keep
      if (isValidCoord(final.lat) && isValidCoord(final.lon)) {
        final.confidence = 1;
        stats.kept++;
        merged.push(final);
        continue;
      }

      // try matches: exact id in tay, dh
      const candidates = [];
      if (nid && tayById[nid]) candidates.push(tayById[nid]);
      if (nid && dhById[nid]) candidates.push(dhById[nid]);
      // try by name
      if (nname && tayByName[nname]) candidates.push(tayByName[nname]);
      if (nname && dhByName[nname]) candidates.push(dhByName[nname]);
      // fuzzy name (token overlap)
      if (nname) {
        const tokens = nname.split(/\s+/).filter(Boolean).slice(0,3);
        for (const key of Object.keys(tayByName)) {
          const kTokens = key.split(/\s+/);
          if (tokens.some(t => kTokens.includes(t))) candidates.push(tayByName[key]);
        }
        for (const key of Object.keys(dhByName)) {
          const kTokens = key.split(/\s+/);
          if (tokens.some(t => kTokens.includes(t))) candidates.push(dhByName[key]);
        }
      }

      // pick coords from candidates priority: tay > datahub
      const coords = pickCoords(candidates);
      if (coords) {
        final.lat = coords.lat; final.lon = coords.lon; final.source = 'merged(tay|dh)'; final.confidence = 0.9;
        stats.enriched++;
      } else {
        final.lat = Number(final.lat || 0); final.lon = Number(final.lon || 0); final.source = 'original'; final.confidence = 0;
        stats.stillMissing++;
      }
      merged.push(final);
    }

    // add external ports that were not in original
    const seenIds = new Set(merged.map(m => normalizeId(m.id || '')));
    const addFrom = [];
    // add from tay
    for (const k of Object.keys(tayById)) {
      if (!seenIds.has(k)) {
        const r = tayById[k];
        const coords = r.coords || null;
        const id = r.id || (r.raw && (r.raw.code || r.raw.locode)) || k;
        const name = r.name || (r.raw && (r.raw.name || r.raw.port || r.raw.city)) || id;
        addFrom.push({ id, name, lat: coords ? coords.lat : 0, lon: coords ? coords.lon : 0, source: 'tayljordan', confidence: coords ? 0.95 : 0 });
        seenIds.add(k);
      }
    }
    // add from datahub (if not seen)
    for (const k of Object.keys(dhById)) {
      if (!seenIds.has(k)) {
        const r = dhById[k];
        const coords = r.coords || null;
        const id = r.id || k;
        const name = r.name || (r.raw && (r.raw.Name || r.raw.name)) || id;
        addFrom.push({ id, name, lat: coords ? coords.lat : 0, lon: coords ? coords.lon : 0, source: 'datahub', confidence: coords ? 0.85 : 0 });
        seenIds.add(k);
      }
    }

    for (const a of addFrom) {
      merged.push(a);
      stats.addedFromExternal++;
      if (!isValidCoord(a.lat) || !isValidCoord(a.lon)) stats.stillMissing++;
    }

    // write enriched file (temporary)
    fs.writeFileSync(ENRICHED_FILE, JSON.stringify(merged, null, 2), 'utf8');
    // overwrite original ports.json (backup already written)
    fs.writeFileSync(OUT_FILE, JSON.stringify(merged.map(m => ({ id: m.id, name: m.name, lat: m.lat || 0, lon: m.lon || 0 })), null, 2), 'utf8');

    console.log('Enrichment complete. Stats:', stats);
    console.log('Wrote enriched files:', ENRICHED_FILE, '->', OUT_FILE);
    // log sample of problematic entries (no coords)
    const missing = merged.filter(m => !isValidCoord(m.lat) || !isValidCoord(m.lon)).slice(0, 20);
    console.log('Sample ports still missing coords (first 20):');
    missing.forEach(p => console.log('  ', p.id, '|', p.name, '| source=', p.source, 'confidence=', p.confidence));
    console.log('If you are happy, restart your server (node server.js or npm run start).');

  } catch (err) {
    console.error('Script failed:', err);
    process.exit(1);
  }
})();
