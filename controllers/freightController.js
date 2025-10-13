// controllers/freightController.js
const path = require('path');
const fs = require('fs');

const PORTS_FILE = path.join(__dirname, '..', 'data', 'ports.json');

let PORTS = [];
try {
  if (fs.existsSync(PORTS_FILE)) {
    PORTS = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    console.log(`Loaded ${PORTS.length} ports from ${PORTS_FILE}`);
  } else {
    PORTS = [
      { id: 'CHN-SHG', name: 'Shanghai, China', lat: 31.2304, lon: 121.4737 },
      { id: 'SGP-SGP', name: 'Singapore, Singapore', lat: 1.3521, lon: 103.8198 },
      { id: 'NLD-RTM', name: 'Rotterdam, Netherlands', lat: 51.9225, lon: 4.47917 }
    ];
    console.log('Using builtin sample ports (no data/ports.json found).');
  }
} catch (err) {
  console.error('Failed to load ports data:', err);
  PORTS = [];
}

function persistPorts() {
  try {
    const dir = path.dirname(PORTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORTS_FILE, JSON.stringify(PORTS, null, 2), 'utf8');
    console.log(`Persisted ports to ${PORTS_FILE}`);
  } catch (e) {
    console.warn('Failed to persist ports.json:', e?.message || e);
  }
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = v => (v * Math.PI) / 180;
  const R_km = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const dist_km = R_km * c;
  return Math.round(dist_km * 0.539957);
}

function normalizeId(s) {
  if (!s) return '';
  return String(s).replace(/[\s\-_]/g, '').toUpperCase();
}
function normalizeName(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function debugLogPrefix() {
  const ts = new Date().toISOString();
  return `[freight:${ts}]`;
}

// very tolerant port finder; returns { port, reason } or null
function findPortLooseDetailed(input) {
  const candidate = input == null ? '' : String(input).trim();
  const normId = normalizeId(candidate);
  const normName = normalizeName(candidate);
  const debug = [];

  debug.push(`trying to resolve input="${candidate}" normId="${normId}" normName="${normName}"`);

  // 1) exact id
  let p = PORTS.find(x => (x.id === candidate) || (normalizeId(x.id) === normId));
  if (p) return { port: p, reason: 'exact-id' , debug };

  // 2) exact name
  p = PORTS.find(x => normalizeName(x.name) === normName);
  if (p) return { port: p, reason: 'exact-name', debug };

  // 3) name includes (substring) - require >2 chars
  if (normName.length >= 3) {
    p = PORTS.find(x => normalizeName(x.name).includes(normName));
    if (p) return { port: p, reason: 'name-substring', debug };
  }

  // 4) id prefix / id contains (e.g. user gave CNSH vs CNSHG)
  p = PORTS.find(x => {
    const xId = normalizeId(x.id);
    return (xId && normId && (xId.startsWith(normId) || normId.startsWith(xId) || xId.includes(normId) || normId.includes(xId)));
  });
  if (p) return { port: p, reason: 'id-prefix-or-contains', debug };

  // 5) split inputs like "CN SHG" or "CN-SHG"
  if (/\w{2}\s*\w{2,}/.test(candidate)) {
    const merged = normalizeId(candidate);
    p = PORTS.find(x => normalizeId(x.id) === merged);
    if (p) return { port: p, reason: 'merged-split-id', debug };
  }

  // 6) try matching by first token of name (e.g., "Shanghai")
  const firstWord = (normName.split(/\s+/)[0] || '');
  if (firstWord.length >= 3) {
    p = PORTS.find(x => normalizeName(x.name).includes(firstWord));
    if (p) return { port: p, reason: 'first-word-name', debug };
  }

  // 7) fallback: any id or name that contains the input as substring
  if (normId || normName) {
    p = PORTS.find(x => normalizeId(x.id).includes(normId) || normalizeName(x.name).includes(normName));
    if (p) return { port: p, reason: 'fallback-substring', debug };
  }

  // nothing found
  debug.push('no match strategies succeeded');
  return { port: null, reason: 'not-found', debug };
}

// geocode helper (Nominatim)
let fetchFn;
function getFetch() {
  if (fetchFn) return fetchFn;
  try {
    if (typeof globalThis.fetch === 'function') { fetchFn = globalThis.fetch; return fetchFn; }
  } catch (e) {}
  try {
    fetchFn = require('node-fetch');
    return fetchFn;
  } catch (e) {
    fetchFn = null;
    return null;
  }
}

async function geocodeText(q) {
  const f = getFetch();
  if (!f) return null;
  const txt = encodeURIComponent(`${q} port`);
  const url = `https://nominatim.openstreetmap.org/search?q=${txt}&format=json&limit=1&addressdetails=0`;
  try {
    const res = await f(url, { headers: { 'User-Agent': 'freight-calc/1.0 (dev)' } });
    if (!res) return null;
    const json = await (typeof res.json === 'function' ? res.json() : Promise.resolve(null));
    if (!Array.isArray(json) || json.length === 0) return null;
    const first = json[0];
    const lat = Number(first.lat);
    const lon = Number(first.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
    return null;
  } catch (e) {
    console.warn(debugLogPrefix(), 'geocodeText error', e?.message || e);
    return null;
  }
}

async function ensureCoordsForPort(port, originalQuery) {
  if (!port) return port;
  const hasCoords = port.lat && port.lon && Number(port.lat) !== 0 && Number(port.lon) !== 0;
  if (hasCoords) return port;

  // Try geocode using port.name first
  let parsed = null;
  if (port.name) {
    parsed = await geocodeText(port.name);
    if (parsed) {
      port.lat = parsed.lat; port.lon = parsed.lon;
      const idx = PORTS.findIndex(x => normalizeId(x.id) === normalizeId(port.id));
      if (idx >= 0) { PORTS[idx] = port; persistPorts(); console.log(debugLogPrefix(), `Enriched coords for ${port.id} via name -> ${port.lat},${port.lon}`); return port; }
    }
  }

  // If still missing, try geocoding the original query the user used
  if (originalQuery) {
    parsed = await geocodeText(originalQuery);
    if (parsed) {
      port.lat = parsed.lat; port.lon = parsed.lon;
      const idx = PORTS.findIndex(x => normalizeId(x.id) === normalizeId(port.id));
      if (idx >= 0) { PORTS[idx] = port; persistPorts(); console.log(debugLogPrefix(), `Enriched coords for ${port.id} via originalQuery -> ${port.lat},${port.lon}`); return port; }
    }
  }

  // still missing
  return port;
}

// simple container registry
const CONTAINER_REGISTRY = [
  { id: '20std', label: "20' Standard", factor: 1 },
  { id: '40std', label: "40' Standard", factor: 1.6 },
  { id: '40hc',  label: "40' High Cube", factor: 1.7 }
];

// controllers
exports.searchPorts = (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ ok: true, data: PORTS.slice(0, 200) });
    const results = PORTS.filter(p => {
      return (String(p.id || '').toLowerCase().includes(q)) || (String(p.name || '').toLowerCase().includes(q));
    }).slice(0, 200);
    return res.json({ ok: true, data: results });
  } catch (e) {
    console.error(debugLogPrefix(), 'searchPorts error', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.getRates = (req, res) => {
  return res.json({ ok: true, data: { USD: 1, EUR: 0.92, TND: 3.1 } });
};

exports.postQuote = async (req, res) => {
  try {
    const startTs = new Date().toISOString();
    const { from, to, containers = [], currency = 'USD', fromLat, fromLon, toLat, toLon } = req.body;
    console.log(debugLogPrefix(), 'postQuote request', { from, to, containersCount: Array.isArray(containers) ? containers.length : 0 });

    // Attempt to resolve both endpoints with detailed logs
    let fromResolved = findPortLooseDetailed(from);
    console.log(debugLogPrefix(), 'fromResolved', { reason: fromResolved.reason, debug: fromResolved.debug.slice(0,5) });
    let toResolved = findPortLooseDetailed(to);
    console.log(debugLogPrefix(), 'toResolved', { reason: toResolved.reason, debug: toResolved.debug.slice(0,5) });

    let fromPort = fromResolved.port || (fromLat && fromLon ? { name: from || 'Custom origin', lat: Number(fromLat), lon: Number(fromLon) } : null);
    let toPort   = toResolved.port   || (toLat && toLon   ? { name: to || 'Custom destination', lat: Number(toLat), lon: Number(toLon) } : null);

    // If not found, try normalized alt forms already in controller (existing logic)
    if (!fromPort && typeof from === 'string') {
      const alt = normalizeId(from);
      const altRes = findPortLooseDetailed(alt);
      console.log(debugLogPrefix(), 'from altResolved', { reason: altRes.reason });
      fromPort = altRes.port || fromPort;
    }
    if (!toPort && typeof to === 'string') {
      const alt = normalizeId(to);
      const altRes = findPortLooseDetailed(alt);
      console.log(debugLogPrefix(), 'to altResolved', { reason: altRes.reason });
      toPort = altRes.port || toPort;
    }

    // NEW: If still not found, try geocoding raw input strings and build a temporary port object
    // This helps when the imported ports.json uses different id formats or missing entries
    if (!fromPort && typeof from === 'string' && from.trim().length > 2) {
      console.log(debugLogPrefix(), `from port not found, attempting geocode for "${from}"`);
      const g = await geocodeText(from);
      if (g) {
        fromPort = { id: normalizeId(from).slice(0, 10), name: from, lat: g.lat, lon: g.lon };
        // persist a new record to ports.json to speed future lookups
        try {
          PORTS.push(fromPort);
          persistPorts();
          console.log(debugLogPrefix(), `Persisted geocoded origin ${fromPort.id} -> ${fromPort.lat},${fromPort.lon}`);
        } catch (e) {
          console.warn(debugLogPrefix(), 'failed to persist geocoded origin', e?.message || e);
        }
      } else {
        console.warn(debugLogPrefix(), `geocode for origin "${from}" returned nothing`);
      }
    }

    if (!toPort && typeof to === 'string' && to.trim().length > 2) {
      console.log(debugLogPrefix(), `to port not found, attempting geocode for "${to}"`);
      const g2 = await geocodeText(to);
      if (g2) {
        toPort = { id: normalizeId(to).slice(0, 10), name: to, lat: g2.lat, lon: g2.lon };
        try {
          PORTS.push(toPort);
          persistPorts();
          console.log(debugLogPrefix(), `Persisted geocoded destination ${toPort.id} -> ${toPort.lat},${toPort.lon}`);
        } catch (e) {
          console.warn(debugLogPrefix(), 'failed to persist geocoded destination', e?.message || e);
        }
      } else {
        console.warn(debugLogPrefix(), `geocode for destination "${to}" returned nothing`);
      }
    }

    // final check
    if (!fromPort || !toPort) {
      console.warn(debugLogPrefix(), 'Could not resolve from/to', { fromPortFound: !!fromPort, toPortFound: !!toPort });
      return res.status(400).json({ ok: false, error: 'Could not resolve origin or destination. Provide known port ID/name or lat/lon.' });
    }

    // verify coords exist and non-zero
    const fromHasCoords = fromPort && fromPort.lat && fromPort.lon && Number(fromPort.lat) !== 0 && Number(fromPort.lon) !== 0;
    const toHasCoords   = toPort   && toPort.lat   && toPort.lon   && Number(toPort.lat) !== 0 && Number(toPort.lon) !== 0;
    if (!fromHasCoords || !toHasCoords) {
      console.warn(debugLogPrefix(), 'Missing coords after attempts', { fromHasCoords, toHasCoords, fromPort, toPort });
      return res.status(400).json({ ok: false, error: 'Origin or destination missing coordinates. Try selecting a different suggestion or provide lat/lon.' });
    }

    // compute distance & quote
    const distance = haversineNm(Number(fromPort.lat), Number(fromPort.lon), Number(toPort.lat), Number(toPort.lon));
    const basePerNm = 0.35;
    let lines = [];
    let totalUSD = 0;
    for (const c of containers) {
      const spec = CONTAINER_REGISTRY.find(x => x.id === c.type) || CONTAINER_REGISTRY[0];
      const qty = Number(c.qty || 1);
      for (let i = 0; i < qty; i++) {
        const base = Math.round(distance * basePerNm * spec.factor);
        const bunker = Math.round(base * 0.12);
        const security = Math.round(40 * spec.factor);
        const terminal = Math.round(75 * spec.factor);
        const local = Math.round(50 * spec.factor);
        const lineTotal = base + bunker + security + terminal + local;
        lines.push({ container: spec.label, base, bunker, security, terminal, local, lineTotal });
        totalUSD += lineTotal;
      }
    }

    const transitDays = Math.max(3, Math.round(distance / 700));
    const rates = { USD: 1, EUR: 0.92, TND: 3.1 };
    const totalInCurrency = Math.round((totalUSD * (rates[currency] || 1)) * 100) / 100;
    console.log(debugLogPrefix(), `Quote completed`, { distance, totalUSD, totalInCurrency });

    return res.json({
      ok: true,
      data: {
        from: fromPort.name,
        to: toPort.name,
        distance,
        transitDays,
        lines,
        totalUSD,
        total: totalInCurrency,
        currency,
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error(debugLogPrefix(), 'postQuote error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
