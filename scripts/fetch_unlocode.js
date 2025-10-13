/**
 * server/scripts/fetch_unlocode.js
 *
 * Downloads the official UN/LOCODE CSV ZIP (UNECE service) or DataHub mirror,
 * extracts the main CSV (code-list), parses it and writes server/data/ports.json
 * containing an array of:
 *   { id: "<country><location>", name: "<name>", lat: <decimal>, lon: <decimal> }
 *
 * Usage:
 *   cd server
 *   npm install node-fetch unzipper csv-parse
 *   node scripts/fetch_unlocode.js
 *
 * Notes:
 * - It tries UNECE download first; if that fails it falls back to DataHub mirror.
 * - Coordinates in the CSV are in the "DDMM[N/S] DDDMM[E/W]" style; parser attempts to convert.
 */

const fs = require("fs");
const path = require("path");

const unzipper = require("unzipper");
const { parse } = require("csv-parse/sync");

const UNECE_ZIP = "https://service.unece.org/trade/locode/loc242csv.zip"; // update if new edition
const DATAHUB_CSV = "https://datahub.io/core/un-locode/r/code-list.csv"; // fallback

const OUT_JSON = path.join(__dirname, "..", "data", "ports.json");

/**
 * Parse coordinate strings like:
 *  - "3120N 12130E"
 *  - "31 20 N 121 30 E"
 *  - "31.3333N 121.5E"
 *  - "31.3333,121.5000"
 */
function parseCoords(coordsRaw) {
  if (!coordsRaw || typeof coordsRaw !== "string") return null;
  const txt = coordsRaw
    .replace(/[^\dNSWE\.\-\+,\/\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // decimal with direction: "31.3333 N 121.5 E"
  const decMatch = txt.match(/([+-]?\d+(?:\.\d+)?)\s*([NS])\s*[,\s]+\s*([+-]?\d+(?:\.\d+)?)\s*([EW])/i);
  if (decMatch) {
    const lat = Number(decMatch[1]) * (decMatch[2].toUpperCase() === "S" ? -1 : 1);
    const lon = Number(decMatch[3]) * (decMatch[4].toUpperCase() === "W" ? -1 : 1);
    return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  }

  // decimal comma/space separated "31.3333,121.5000" or "31.3333 121.5"
  const twoDec = txt.split(/[;,\/\s]+/).map(s => s.trim()).filter(Boolean);
  if (twoDec.length >= 2) {
    const nlat = Number(twoDec[0]);
    const nlon = Number(twoDec[1]);
    if (!Number.isNaN(nlat) && !Number.isNaN(nlon)) {
      return { lat: +nlat.toFixed(6), lon: +nlon.toFixed(6) };
    }
  }

  // D M with N/S and E/W like "3120N 12130E" or "31 20 N 121 30 E"
  const latMatch =
    txt.match(/(\d{1,3})\s*(\d{1,2})\s*([NS])/i) ||
    txt.match(/(\d{2})(\d{2})([NS])/i);
  const lonMatch =
    txt.match(/(\d{1,3})\s*(\d{1,2})\s*([EW])/i) ||
    txt.match(/(\d{3})(\d{2})([EW])/i);

  if (latMatch && lonMatch) {
    const latDeg = Number(latMatch[1]);
    const latMin = Number(latMatch[2] || 0);
    const latDir = latMatch[3].toUpperCase();
    const lonDeg = Number(lonMatch[1]);
    const lonMin = Number(lonMatch[2] || 0);
    const lonDir = lonMatch[3].toUpperCase();

    const lat = latDeg + latMin / 60;
    const lon = lonDeg + lonMin / 60;
    const latSigned = latDir === "S" ? -lat : lat;
    const lonSigned = lonDir === "W" ? -lon : lon;
    return { lat: +latSigned.toFixed(6), lon: +lonSigned.toFixed(6) };
  }

  // compact like 3120N12130E
  const simple = coordsRaw.match(/(\d{2,3})(\d{2})([NS])\s*(\d{2,3})(\d{2})([EW])/i);
  if (simple) {
    const lat = Number(simple[1]) + Number(simple[2]) / 60;
    const lon = Number(simple[4]) + Number(simple[5]) / 60;
    const latSign = simple[3].toUpperCase() === "S" ? -1 : 1;
    const lonSign = simple[6].toUpperCase() === "W" ? -1 : 1;
    return { lat: +(lat * latSign).toFixed(6), lon: +(lon * lonSign).toFixed(6) };
  }

  return null;
}

// --- Robust fetch detection & downloadToBuffer helper ---
const https = require("https");

async function getFetchFnMaybe() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;

  try {
    const nf = require("node-fetch");
    if (typeof nf === "function") return nf;
    if (nf && typeof nf.default === "function") return nf.default;
  } catch (e) { /* ignore */ }

  try {
    const mod = await import("node-fetch");
    return mod.default ?? mod;
  } catch (e) { /* ignore */ }

  return async function httpsFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            buffer: async () => buffer,
            arrayBuffer: async () =>
              buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            text: async () => buffer.toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      if (opts && opts.signal && typeof opts.signal.addEventListener === "function") {
        opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
      }
    });
  };
}

async function downloadToBuffer(url) {
  console.log("Downloading from", url);
  const fetchFn = await getFetchFnMaybe();
  if (typeof fetchFn !== "function") throw new Error("No usable fetch implementation found");
  const res = await fetchFn(url);
  if (!res || !res.ok) {
    const status = res && typeof res.status !== "undefined" ? res.status : "no-response";
    throw new Error(`Failed to download ${url} — status ${status}`);
  }
  if (typeof res.buffer === "function") return await res.buffer();
  if (typeof res.arrayBuffer === "function") return Buffer.from(await res.arrayBuffer());
  if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
    const bufs = [];
    for await (const chunk of res.body) bufs.push(chunk);
    return Buffer.concat(bufs);
  }
  throw new Error("downloadToBuffer: cannot read response body");
}
// --- end helper ---

async function extractCsvFromZipBuffer(buf) {
  const directory = await unzipper.Open.buffer(buf);
  let entry = directory.files.find(
    (f) => /code-list/i.test(f.path) && f.path.toLowerCase().endsWith(".csv")
  );
  if (!entry) entry = directory.files.find((f) => f.path.toLowerCase().endsWith(".csv"));
  if (!entry) throw new Error("No CSV entry found in ZIP");
  const content = await entry.buffer();
  return content.toString("utf8");
}

function normalizeKey(k) {
  if (!k || typeof k !== "string") return "";
  return k.replace(/\uFEFF/g, "") // BOM
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ""); // remove punctuation/spaces for matching
}

function findKeyByNormalized(normMap, candidates) {
  for (const c of candidates) {
    const normalizedCandidate = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedCandidate in normMap) return normMap[normalizedCandidate];
  }
  // fallback: try regex on original normalized keys
  for (const origNorm in normMap) {
    for (const c of candidates) {
      const re = new RegExp(c.replace(/[^a-z0-9]/g, ""), "i");
      if (re.test(origNorm)) return normMap[origNorm];
    }
  }
  return null;
}

async function fetchAndWrite() {
  try {
    let csvText = null;
    try {
      const buf = await downloadToBuffer(UNECE_ZIP);
      csvText = await extractCsvFromZipBuffer(buf);
      console.log("Extracted CSV from UNECE ZIP.");
    } catch (e) {
      console.warn("UNECE download/extract failed:", e.message || e);
      console.log("Falling back to DataHub CSV URL...");
      const buf2 = await downloadToBuffer(DATAHUB_CSV);
      csvText = buf2.toString("utf8");
    }

    // Attempt parse with columns:true (common case)
    let records = parse(csvText, { columns: true, skip_empty_lines: true });
    console.log("Parsed", records.length, "rows from CSV.");

    // If parse produced objects with header keys that look like data (e.g. "AD","02",...),
    // that means the CSV likely has no header row. Detect this by checking the first row keys.
    let usedArrayMode = false;
    if (records && records.length > 0) {
      const origKeys = Object.keys(records[0]);
      // heuristic: if many keys are short uppercase codes (2-3 chars) or numeric strings,
      // assume first row was data and reparse with columns:false
      const suspicious = origKeys.filter(k => /^[A-Z0-9]{1,4}$/.test(k.trim())).length;
      if (suspicious >= Math.min(2, origKeys.length)) {
        // reparse as arrays
        console.warn("CSV appears to have no header row; reparsing as raw rows using fixed indices.");
        records = parse(csvText, { columns: false, skip_empty_lines: true });
        usedArrayMode = true;
      }
    }

    const out = [];

    if (!usedArrayMode) {
      // original object-based processing (header present)
      if (!records || records.length === 0) {
        console.log("No records found in CSV.");
        return;
      }

      // Build normalized header map: normalized -> original key
      const origKeys = Object.keys(records[0]);
      const normMap = {};
      for (const k of origKeys) {
        normMap[normalizeKey(k)] = k;
      }

      // Candidate sets (ordered)
      const countryCandidates = [
        "countrycode","country","countrycode2","cc","iso3166","countryiso",
        "su_country","countrycodewithsubdivision","countryname"
      ];
      const locationCandidates = [
        "locationcode","location","locode","place","placecode","locationname","subdivision"
      ];
      const nameCandidates = [
        "name","namewodiacritics","locationname","placename","namewo","name_wo_diacritics"
      ];
      const coordsCandidates = [
        "coordinates","coordinate","latlon","lat_lon","locationcoordinates","geolocation","geocode"
      ];
      const latCandidates = ["latitude","lat"];
      const lonCandidates = ["longitude","lon","long"];

      const countryKey = findKeyByNormalized(normMap, countryCandidates);
      const locationKey = findKeyByNormalized(normMap, locationCandidates);
      const nameKey = findKeyByNormalized(normMap, nameCandidates);
      const coordsKey = findKeyByNormalized(normMap, coordsCandidates);
      const latKey = findKeyByNormalized(normMap, latCandidates);
      const lonKey = findKeyByNormalized(normMap, lonCandidates);

      // also detect any key that literally contains 'locode' or looks like 'code' (for fallback)
      const locodeKey = Object.keys(records[0]).find(k => /locode/i.test(k)) || Object.keys(records[0]).find(k => /^code$/i.test(k) || /code$/.test(k));

      for (const r of records) {
        let country = countryKey && r[countryKey] ? String(r[countryKey]).trim() : "";
        let location = locationKey && r[locationKey] ? String(r[locationKey]).trim() : "";
        const name = nameKey && r[nameKey] ? String(r[nameKey]).trim() : "";
        let coords = coordsKey && r[coordsKey] ? String(r[coordsKey]).trim() : "";

        // If locode field exists and country or location missing, try split
        if ((!country || !location) && locodeKey && r[locodeKey]) {
          const val = String(r[locodeKey]).trim().replace(/\s+/g, "");
          if (val.length >= 3) {
            if (!country) country = val.slice(0, 2);
            if (!location) location = val.slice(2);
          }
        }

        // If location contains something like USNYC, split
        if (!country && location) {
          const m = location.match(/^([A-Za-z]{2})(.+)$/);
          if (m) {
            country = m[1];
            location = m[2];
          }
        }

        // If coords are empty but lat/lon columns exist, use them
        let lat = 0, lon = 0;
        if ((!coords || coords.length === 0) && latKey && lonKey) {
          const lv = r[latKey];
          const lo = r[lonKey];
          if (lv != null && lo != null && String(lv).trim() !== "" && String(lo).trim() !== "") {
            const nlat = Number(String(lv).trim());
            const nlon = Number(String(lo).trim());
            if (!Number.isNaN(nlat) && !Number.isNaN(nlon)) {
              lat = +nlat.toFixed(6);
              lon = +nlon.toFixed(6);
            }
          }
        }

        // parse coords if present
        if (coords && coords.length > 0) {
          const parsed = parseCoords(coords);
          if (parsed) {
            lat = parsed.lat; lon = parsed.lon;
          } else {
            // try comma separated numeric
            const parts = coords.split(/[;,]/).map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2) {
              const nlat = Number(parts[0]); const nlon = Number(parts[1]);
              if (!Number.isNaN(nlat) && !Number.isNaN(nlon)) {
                lat = +nlat.toFixed(6); lon = +nlon.toFixed(6);
              }
            }
          }
        }

        if (!country || !location) continue;

        const id = `${country}${location}`.replace(/\s+/g, "").toUpperCase();
        const nameOut = name || `${country} ${location}`;
        out.push({ id, name: nameOut, lat, lon });
      }

    } else {
      // Array-mode processing (CSV had no header row)
      // records is array of arrays: [ [col0, col1, col2, ...], ... ]
      for (const row of records) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const country = String(row[0] || "").trim();
        const location = String(row[1] || "").trim();
        const name = String(row[2] || "").trim();
        // attempt to find coords in any column (search columns 3..end)
        let coordsCandidate = "";
        for (let i = 3; i < row.length; i++) {
          const cell = String(row[i] || "").trim();
          if (!cell) continue;
          // if looks like coords (numbers, N/S/E/W or decimal pair), take it
          if (/[NSWE]/i.test(cell) || /[0-9]+\.[0-9]+/.test(cell) || /[0-9]{4,}/.test(cell) || /,/.test(cell)) {
            coordsCandidate = cell;
            break;
          }
        }
        // also check column 2 if it's actually coordinates (some files vary)
        if (!coordsCandidate && row.length >= 3 && /[NSWE]|[0-9]+\.[0-9]+|,/.test(String(row[2]||""))) {
          coordsCandidate = String(row[2] || "").trim();
        }

        let lat = 0, lon = 0;
        if (coordsCandidate) {
          const parsed = parseCoords(coordsCandidate);
          if (parsed) {
            lat = parsed.lat; lon = parsed.lon;
          }
        }

        if (!country || !location) continue;
        const id = `${country}${location}`.replace(/\s+/g, "").toUpperCase();
        const nameOut = name || `${country} ${location}`;
        out.push({ id, name: nameOut, lat, lon });
      }
    }

    // write results
    const dataDir = path.join(__dirname, "..", "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
    console.log("Wrote", out.length, "ports to", OUT_JSON);

    // If zero ports written, print helpful debug info
    if (out.length === 0) {
      console.warn("\n== DEBUG: No ports written. Dumping detection info ==");
      try {
        // show a small sample of the raw file to help debugging
        const lines = csvText.split(/\r?\n/).slice(0, 12);
        console.warn("First 12 lines of CSV (trimmed):");
        lines.forEach((ln, i) => console.warn(String(i + 1).padStart(2, " "), ln.slice(0, 400)));
      } catch (e) {
        // ignore
      }
      console.warn("\nPlease paste the above output here so I can adjust detection further.\n");
    } else {
      console.log("Done. Restart your server to load the data (node server.js or npm start).");
    }
  } catch (err) {
    console.error("Error in fetch_unlocode:", err);
    process.exit(1);
  }
}

fetchAndWrite();
