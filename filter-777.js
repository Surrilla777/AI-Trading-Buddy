const fs = require('fs');
const r = JSON.parse(fs.readFileSync('scan-results-777.json', 'utf8'));
const filtered = r.filter(e => !e.from.toLowerCase().includes('surrilla@gmail'));
console.log('Total found:', r.length);
console.log('After removing forwarded tests:', filtered.length);
fs.writeFileSync('scan-results-777.json', JSON.stringify(filtered, null, 2));
console.log('Saved filtered results');
