const http = require('http');
const https = require('https');

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    const pattern = url.searchParams.get('pattern');

    if (!pattern) {
        res.writeHead(400);
        res.end('Missing pattern');
        return;
    }

    const finvizUrl = `https://finviz.com/screener.ashx?v=111&f=${pattern},cap_smallover,sh_avgvol_o200,sh_price_o5&o=-marketcap`;

    console.log(`Fetching: ${pattern}`);

    https.get(finvizUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        }
    }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            console.log(`Got ${data.length} bytes for ${pattern}`);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }).on('error', (err) => {
        console.error('Error:', err.message);
        res.writeHead(500);
        res.end('Error fetching data');
    });
});

server.listen(3456, () => {
    console.log('');
    console.log('=================================');
    console.log('  FINVIZ PROXY RUNNING');
    console.log('  http://localhost:3456');
    console.log('=================================');
    console.log('');
    console.log('Keep this window open!');
    console.log('');
});
