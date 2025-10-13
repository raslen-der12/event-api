// scripts/import_ports.js
const fs = require('fs');
const path = require('path');
const parse = require('csv-parse/lib/sync');

const csvPath = path.join(__dirname, '..', 'data', 'ports.csv'); // place CSV here
if (!fs.existsSync(csvPath)) {
  console.error('No CSV at', csvPath);
  process.exit(1);
}
const text = fs.readFileSync(csvPath, 'utf8');
const records = parse(text, { columns: true, skip_empty_lines: true });

const out = records.map(r => {
  const id = r.UNLOCODE || r.code || r.id || '';
  const name = r.Name || r.name || r.port || r.Location || '';
  const lat = parseFloat(r.Lat || r.lat || r.latitude || r.Latitude || 0) || 0;
  const lon = parseFloat(r.Lon || r.lon || r.longitude || r.Longitude || 0) || 0;
  return { id: id.trim(), name: name.trim(), lat, lon };
}).filter(x => x.id || x.name);

fs.writeFileSync(path.join(__dirname, '..', 'data', 'ports.json'), JSON.stringify(out, null, 2));
console.log('Wrote', out.length, 'ports to data/ports.json');
