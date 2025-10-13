/**
 * fix_ports_coords_with_country.js
 *
 * Reads ports.json, finds all ports with lat=0 && lon=0,
 * queries OpenStreetMap Nominatim API using "name + country code",
 * writes updated coordinates back to ports_fixed.json.
 *
 * Usage:
 *   node fix_ports_coords_with_country.js
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PORTS_JSON = path.join( 'data', 'ports.json');
const OUTPUT_JSON = path.join('data', 'ports_fixed.json');

// Map ISO country codes to full country names for better accuracy
const countryMap = {
  AD: 'Andorra',
  AE: 'United Arab Emirates',
  AF: 'Afghanistan',
  AG: 'Antigua and Barbuda',
  // ... add all countries you need
};

// Load ports.json
let ports = JSON.parse(fs.readFileSync(PORTS_JSON, 'utf8'));
console.log(`Loaded ${ports.length} ports`);

// Filter ports with missing coordinates
const missingCoords = ports.filter(p => !p.lat || !p.lon);
console.log(`${missingCoords.length} ports with missing coordinates`);

async function geocodePort(port) {
  const countryCode = port.id.slice(0,2).toUpperCase();
  const countryName = countryMap[countryCode] || '';
  const query = encodeURIComponent(`${port.name}, ${countryName}`);
  const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
  
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ports-fixer-script" }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };
    }
  } catch (err) {
    console.error(`Error geocoding ${port.name} (${countryName}):`, err.message);
  }
  return null;
}

(async () => {
  for (let i = 0; i < missingCoords.length; i++) {
    const port = missingCoords[i];
    const countryCode = port.id.slice(0,2).toUpperCase();
    const countryName = countryMap[countryCode] || '';
    console.log(`[${i+1}/${missingCoords.length}] Geocoding: ${port.name}, ${countryName} (${port.id})`);
    
    const coords = await geocodePort(port);
    if (coords) {
      port.lat = coords.lat;
      port.lon = coords.lon;
      console.log(` -> ${coords.lat}, ${coords.lon}`);
    } else {
      console.log(' -> Could not find coordinates');
    }

    // Nominatim usage policy: max 1 request per second
    await new Promise(r => setTimeout(r, 1100));
  }

  // Write updated JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(ports, null, 2), 'utf8');
  console.log(`Updated ports written to ${OUTPUT_JSON}`);
})();
