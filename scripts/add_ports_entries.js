// server/scripts/add_ports_entries.js
const fs = require('fs');
const path = require('path');

const DATA = [
  { id: 'CNSHG', name: 'Shanghai, China', lat: 31.230390, lon: 121.473702 },
  { id: 'CNSH',  name: 'Shanghai Shi',    lat: 31.230390, lon: 121.473702 }, // keep existing id too
  { id: 'NLRTM', name: 'Rotterdam, Netherlands', lat: 51.9225, lon: 4.47917 },
];

const file = path.join(__dirname, '..', 'data', 'ports.json');
let arr = [];
if (fs.existsSync(file)) {
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Failed to parse existing ports.json', e); process.exit(1); }
}

const existingById = {};
arr.forEach(p => { existingById[(p.id||'').toUpperCase()] = p; });

let added = 0;
for (const p of DATA) {
  const id = (p.id||'').toUpperCase();
  if (!existingById[id]) {
    arr.push(p);
    existingById[id] = p;
    added++;
  } else {
    // update coords if they are missing or zero
    const ex = existingById[id];
    if ((!ex.lat || !ex.lon || ex.lat === 0 || ex.lon === 0) && p.lat && p.lon) {
      ex.lat = p.lat; ex.lon = p.lon;
      added++;
    }
  }
}

fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
console.log(`Wrote ${arr.length} total ports (added/updated ${added}). File: ${file}`);
