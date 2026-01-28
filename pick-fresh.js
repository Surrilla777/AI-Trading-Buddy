const fs = require('fs');
const results = JSON.parse(fs.readFileSync('scan-results.json', 'utf8'));

// Find emails from different senders we haven't tested
const tested = ['cookunity', 'eaze', 'fever', 'surrilla'];
const fresh = results.find(r => {
    const fromLower = r.from.toLowerCase();
    return !tested.some(t => fromLower.includes(t));
});

if (fresh) {
    console.log('Fresh email:', fresh.subject);
    console.log('From:', fresh.from);
    // Move to front
    const idx = results.indexOf(fresh);
    results.splice(idx, 1);
    results.unshift(fresh);
    fs.writeFileSync('scan-results.json', JSON.stringify(results, null, 2));
    console.log('Moved to front');
}
