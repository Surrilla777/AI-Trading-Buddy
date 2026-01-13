const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Use environment variable for PORT (Railway sets this automatically)
const PORT = process.env.PORT || 3000;
const PUSH_TOKENS_FILE = path.join(__dirname, 'push-tokens.json');

// ===== FIREBASE ADMIN SDK (for sending push notifications) =====
let firebaseAdmin = null;
let firebaseMessaging = null;

// Initialize Firebase Admin if credentials are available
const initFirebaseAdmin = () => {
    try {
        // Check for service account credentials (set as env var in Railway)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const admin = require('firebase-admin');
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });

            firebaseAdmin = admin;
            firebaseMessaging = admin.messaging();
            console.log('[Firebase Admin] Initialized successfully');
            return true;
        } else {
            console.log('[Firebase Admin] No service account found - push sending disabled');
            console.log('[Firebase Admin] Set FIREBASE_SERVICE_ACCOUNT env var to enable');
            return false;
        }
    } catch (err) {
        console.error('[Firebase Admin] Init failed:', err.message);
        return false;
    }
};

// Send push notification to a specific token
const sendPushNotification = async (token, title, body, data = {}) => {
    if (!firebaseMessaging) {
        console.log('[Push] Firebase Admin not initialized - cannot send');
        return false;
    }

    try {
        const message = {
            token,
            notification: { title, body },
            data: {
                ...data,
                timestamp: Date.now().toString()
            },
            webpush: {
                notification: {
                    icon: 'https://em-content.zobj.net/source/apple/391/brain_1f9e0.png',
                    badge: 'https://em-content.zobj.net/source/apple/391/chart-increasing_1f4c8.png',
                    requireInteraction: true,
                    vibrate: [200, 100, 200]
                },
                fcmOptions: {
                    link: '/'
                }
            }
        };

        const response = await firebaseMessaging.send(message);
        console.log(`[Push] Sent to ${token.substring(0, 20)}...: ${title}`);
        return true;
    } catch (err) {
        console.error(`[Push] Send failed:`, err.message);
        // Remove invalid tokens
        if (err.code === 'messaging/registration-token-not-registered') {
            pushSubscriptions = pushSubscriptions.filter(s => s.token !== token);
            saveSubscriptions();
            console.log('[Push] Removed invalid token');
        }
        return false;
    }
};

// Initialize Firebase Admin on startup
initFirebaseAdmin();

// ===== PUSH NOTIFICATION STORAGE =====
// In production, this would be a database
let pushSubscriptions = [];

// Load saved subscriptions on startup
try {
    if (fs.existsSync(PUSH_TOKENS_FILE)) {
        pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_TOKENS_FILE, 'utf8'));
        console.log(`[Push] Loaded ${pushSubscriptions.length} saved subscriptions`);
    }
} catch (err) {
    console.log('[Push] No saved subscriptions found');
}

// Save subscriptions to file
const saveSubscriptions = () => {
    try {
        fs.writeFileSync(PUSH_TOKENS_FILE, JSON.stringify(pushSubscriptions, null, 2));
    } catch (err) {
        console.error('[Push] Failed to save subscriptions:', err.message);
    }
};

// Helper to parse JSON body from POST requests
const parseBody = (req) => {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
};

// Yahoo Finance authentication cache
let yahooAuth = {
    cookies: null,
    crumb: null,
    lastFetched: 0
};

// Get Yahoo authentication (cookies + crumb)
const getYahooAuth = () => {
    return new Promise((resolve, reject) => {
        // Use cached auth if less than 30 minutes old
        if (yahooAuth.crumb && (Date.now() - yahooAuth.lastFetched) < 1800000) {
            console.log('[Yahoo Auth] Using cached credentials');
            resolve(yahooAuth);
            return;
        }

        console.log('[Yahoo Auth] Fetching new credentials...');

        // Step 1: Get cookies from Yahoo Finance
        https.get('https://fc.yahoo.com', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            }
        }, (response) => {
            // Extract cookies from response
            const cookies = response.headers['set-cookie'];
            if (!cookies) {
                reject(new Error('No cookies received from Yahoo'));
                return;
            }

            // Parse cookies - we need A1, A3, etc.
            const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
            console.log('[Yahoo Auth] Got cookies');

            // Step 2: Get crumb using the cookies
            https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Cookie': cookieString
                }
            }, (crumbResponse) => {
                let crumbData = '';
                crumbResponse.on('data', chunk => crumbData += chunk);
                crumbResponse.on('end', () => {
                    if (crumbData && crumbData.length < 50) {
                        yahooAuth = {
                            cookies: cookieString,
                            crumb: crumbData,
                            lastFetched: Date.now()
                        };
                        console.log('[Yahoo Auth] Got crumb:', crumbData);
                        resolve(yahooAuth);
                    } else {
                        reject(new Error('Invalid crumb response'));
                    }
                });
            }).on('error', reject);
        }).on('error', reject);
    });
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Serve HTML files
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const filePath = path.join(__dirname, fileName);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading app');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Serve manifest.json for PWA
    if (url.pathname === '/manifest.json') {
        const filePath = path.join(__dirname, 'manifest.json');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Manifest not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        });
        return;
    }

    // Serve Firebase service worker (must be at root for scope)
    // Dynamically inject config from firebase-config.js
    if (url.pathname === '/firebase-messaging-sw.js') {
        const swPath = path.join(__dirname, 'firebase-messaging-sw.js');
        const configPath = path.join(__dirname, 'firebase-config.js');

        fs.readFile(swPath, 'utf8', (err, swContent) => {
            if (err) {
                res.writeHead(404);
                res.end('Service worker not found');
                return;
            }

            // Try to read and inject the actual config
            fs.readFile(configPath, 'utf8', (configErr, configContent) => {
                let finalContent = swContent;

                if (!configErr && configContent) {
                    // Extract FIREBASE_CONFIG from the config file
                    const configMatch = configContent.match(/const FIREBASE_CONFIG\s*=\s*(\{[\s\S]*?\});/);
                    if (configMatch && configMatch[1]) {
                        // Replace placeholder config in service worker
                        finalContent = swContent.replace(
                            /const firebaseConfig\s*=\s*\{[\s\S]*?\};/,
                            `const firebaseConfig = ${configMatch[1]};`
                        );
                    }
                }

                res.writeHead(200, {
                    'Content-Type': 'application/javascript',
                    'Service-Worker-Allowed': '/'
                });
                res.end(finalContent);
            });
        });
        return;
    }

    // Serve Firebase config file
    if (url.pathname === '/firebase-config.js') {
        const filePath = path.join(__dirname, 'firebase-config.js');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Firebase config not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(data);
        });
        return;
    }

    // Helper function to fetch external URLs
    const fetchExternal = (targetUrl, res, source) => {
        const isHttps = targetUrl.startsWith('https');
        const client = isHttps ? https : http;

        console.log(`[${source}] Fetching: ${targetUrl.substring(0, 80)}...`);

        client.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        }, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                fetchExternal(response.headers.location, res, source);
                return;
            }

            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                console.log(`[${source}] Got ${data.length} bytes`);
                res.writeHead(200, {
                    'Content-Type': 'text/html',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(data);
            });
        }).on('error', (err) => {
            console.error(`[${source}] Error:`, err.message);
            res.writeHead(500);
            res.end('Error fetching');
        });
    };

    // API endpoint for Finviz patterns
    if (url.pathname === '/api/finviz') {
        const pattern = url.searchParams.get('pattern') || '';
        const finvizUrl = `https://finviz.com/screener.ashx?v=111&f=${pattern},cap_smallover,sh_avgvol_o200,sh_price_o5&o=-marketcap`;
        fetchExternal(finvizUrl, res, 'Finviz');
        return;
    }

    // Finviz news/buzz
    if (url.pathname === '/api/finviz-news') {
        fetchExternal('https://finviz.com/news.ashx', res, 'Finviz News');
        return;
    }

    // OpenInsider - insider buying
    if (url.pathname === '/api/openinsider') {
        const insiderUrl = 'http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=7&fdr=&td=0&tdr=&feession=&feo=&fit=&fin=&fc=1&fci=&fsales=0&fpurchases=1&fsize=1&cnt=50';
        fetchExternal(insiderUrl, res, 'OpenInsider');
        return;
    }

    // Reddit (old.reddit for easier parsing)
    if (url.pathname === '/api/reddit') {
        const sub = url.searchParams.get('sub') || 'wallstreetbets';
        fetchExternal(`https://old.reddit.com/r/${sub}/hot.json?limit=50`, res, 'Reddit');
        return;
    }

    // Yahoo Finance trending
    if (url.pathname === '/api/yahoo-trending') {
        fetchExternal('https://finance.yahoo.com/trending-tickers', res, 'Yahoo');
        return;
    }

    // MarketWatch
    if (url.pathname === '/api/marketwatch') {
        fetchExternal('https://www.marketwatch.com/investing/stocks', res, 'MarketWatch');
        return;
    }

    // Bloomberg Markets
    if (url.pathname === '/api/bloomberg') {
        fetchExternal('https://www.bloomberg.com/markets/stocks', res, 'Bloomberg');
        return;
    }

    // Seeking Alpha
    if (url.pathname === '/api/seekingalpha') {
        fetchExternal('https://seekingalpha.com/market-news', res, 'SeekingAlpha');
        return;
    }

    // CNBC
    if (url.pathname === '/api/cnbc') {
        fetchExternal('https://www.cnbc.com/stocks/', res, 'CNBC');
        return;
    }

    // Motley Fool
    if (url.pathname === '/api/motleyfool') {
        fetchExternal('https://www.fool.com/investing-news/', res, 'MotleyFool');
        return;
    }

    // NerdWallet
    if (url.pathname === '/api/nerdwallet') {
        fetchExternal('https://www.nerdwallet.com/article/investing/stock-market-news', res, 'NerdWallet');
        return;
    }

    // Yahoo Finance API - specific endpoint with JSON handling
    if (url.pathname === '/api/yahoo') {
        const ticker = url.searchParams.get('ticker');
        const type = url.searchParams.get('type') || 'quote'; // quote, options, chart
        const expiry = url.searchParams.get('expiry'); // for options at specific expiry

        if (!ticker) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing ticker parameter' }));
            return;
        }

        // For options, we need authentication
        if (type === 'options') {
            getYahooAuth().then(auth => {
                const yahooUrl = expiry
                    ? `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiry}&crumb=${encodeURIComponent(auth.crumb)}`
                    : `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(auth.crumb)}`;

                console.log(`[Yahoo options] Fetching: ${ticker} with auth`);

                https.get(yahooUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Cookie': auth.cookies,
                        'Connection': 'keep-alive'
                    }
                }, (response) => {
                    console.log(`[Yahoo options] Status: ${response.statusCode} for ${ticker}`);

                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        console.log(`[Yahoo options] Got ${data.length} bytes for ${ticker}`);

                        // Log response if it's small (likely an error)
                        if (data.length < 500) {
                            console.log(`[Yahoo options] Response: ${data.substring(0, 300)}`);
                        }

                        // Check if we got an auth error - invalidate cache if so
                        if (data.includes('Invalid Crumb') || data.includes('Unauthorized')) {
                            console.log('[Yahoo Auth] Crumb expired, clearing cache');
                            yahooAuth.crumb = null;
                            yahooAuth.lastFetched = 0;
                        }

                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        });
                        res.end(data);
                    });
                }).on('error', (err) => {
                    console.error(`[Yahoo options] Error:`, err.message);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: err.message }));
                });
            }).catch(err => {
                console.error('[Yahoo Auth] Failed:', err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to authenticate with Yahoo: ' + err.message }));
            });
            return;
        }

        // For chart/quote, no auth needed
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        console.log(`[Yahoo ${type}] Fetching: ${ticker}`);

        https.get(yahooUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        }, (response) => {
            console.log(`[Yahoo ${type}] Status: ${response.statusCode} for ${ticker}`);

            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                console.log(`[Yahoo ${type}] Got ${data.length} bytes for ${ticker}`);

                if (data.length < 500) {
                    console.log(`[Yahoo ${type}] Response: ${data.substring(0, 200)}`);
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(data);
            });
        }).on('error', (err) => {
            console.error(`[Yahoo] Error:`, err.message);
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Generic proxy for any URL (use carefully)
    if (url.pathname === '/api/proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400);
            res.end('Missing url parameter');
            return;
        }
        fetchExternal(decodeURIComponent(targetUrl), res, 'Proxy');
        return;
    }

    // ===== PUSH NOTIFICATION ENDPOINTS =====

    // Register push token and alerts
    if (url.pathname === '/api/register-push-token' && req.method === 'POST') {
        parseBody(req).then(body => {
            const { token, alerts } = body;

            if (!token) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing token' }));
                return;
            }

            // Find existing subscription or create new one
            const existingIndex = pushSubscriptions.findIndex(s => s.token === token);

            const subscription = {
                token,
                alerts: alerts || [],
                registeredAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            };

            if (existingIndex >= 0) {
                pushSubscriptions[existingIndex] = subscription;
                console.log(`[Push] Updated subscription for token: ${token.substring(0, 20)}...`);
            } else {
                pushSubscriptions.push(subscription);
                console.log(`[Push] Registered new token: ${token.substring(0, 20)}...`);
            }

            saveSubscriptions();

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ success: true, alertCount: alerts?.length || 0 }));
        }).catch(err => {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Update alerts for a token
    if (url.pathname === '/api/update-subscription' && req.method === 'POST') {
        parseBody(req).then(body => {
            const { token, alerts } = body;

            const subscription = pushSubscriptions.find(s => s.token === token);
            if (subscription) {
                subscription.alerts = alerts || [];
                subscription.lastSeen = new Date().toISOString();
                saveSubscriptions();
                console.log(`[Push] Updated alerts for token: ${token.substring(0, 20)}...`);
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ success: true }));
        }).catch(err => {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Get push status
    if (url.pathname === '/api/push-status') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            enabled: pushSubscriptions.length > 0,
            subscriptionCount: pushSubscriptions.length,
            totalAlerts: pushSubscriptions.reduce((sum, s) => sum + (s.alerts?.length || 0), 0)
        }));
        return;
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end('Not found');
});

// Get local IP address for mobile access
const getLocalIP = () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
};

// Listen on all interfaces (0.0.0.0) so phone can connect
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('');
    console.log('========================================');
    console.log('  AI TRADING BUDDY SERVER RUNNING');
    console.log('========================================');
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Mobile:  http://${localIP}:${PORT}`);
    console.log('');
    console.log('  Scan from same WiFi to test on phone!');
    console.log('========================================');
    console.log('');

    // Start background alert monitoring (every 30 seconds)
    if (process.env.ENABLE_BACKGROUND_ALERTS !== 'false') {
        startAlertMonitoring();
    }
});

// ===== BACKGROUND ALERT MONITORING =====
// This runs on the server and sends push notifications even when users' browsers are closed

// Cache for stock prices to reduce API calls
const serverPriceCache = {};
const PRICE_CACHE_TTL = 15000; // 15 seconds

// Fetch stock price (server-side)
const fetchStockPrice = (ticker) => {
    return new Promise((resolve) => {
        // Check cache first
        const cached = serverPriceCache[ticker];
        if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_TTL) {
            resolve(cached.price);
            return;
        }

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;

        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
                    if (price) {
                        serverPriceCache[ticker] = { price, timestamp: Date.now() };
                        resolve(price);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
};

// Track which alerts have been triggered (to prevent spam)
const triggeredAlertCache = {};

// Check a single alert against current price
const checkAlert = async (alert, subscription) => {
    const { ticker, type, value } = alert;
    const alertKey = `${subscription.token}-${alert.id}`;

    // Skip if recently triggered (5 minute cooldown)
    if (triggeredAlertCache[alertKey] && (Date.now() - triggeredAlertCache[alertKey]) < 300000) {
        return;
    }

    const price = await fetchStockPrice(ticker);
    if (!price) return;

    let shouldTrigger = false;
    let title = '';
    let body = '';

    switch (type) {
        case 'price_above':
            if (price >= value) {
                shouldTrigger = true;
                title = `${ticker} Hit Target!`;
                body = `Price: $${price.toFixed(2)} (above $${value})`;
            }
            break;
        case 'price_below':
            if (price <= value) {
                shouldTrigger = true;
                title = `${ticker} Alert!`;
                body = `Price: $${price.toFixed(2)} (below $${value})`;
            }
            break;
        case 'percent_gain':
            // Need previous close for this - skip for now in server monitoring
            break;
        case 'percent_loss':
            // Need previous close for this - skip for now in server monitoring
            break;
    }

    if (shouldTrigger) {
        console.log(`[Alert Monitor] Triggering alert: ${title}`);
        const sent = await sendPushNotification(subscription.token, title, body, {
            type,
            ticker,
            alertId: alert.id.toString(),
            price: price.toString()
        });

        if (sent) {
            triggeredAlertCache[alertKey] = Date.now();
        }
    }
};

// Main monitoring loop
const runAlertCheck = async () => {
    if (pushSubscriptions.length === 0) {
        return;
    }

    const totalAlerts = pushSubscriptions.reduce((sum, s) => sum + (s.alerts?.length || 0), 0);
    if (totalAlerts === 0) {
        return;
    }

    console.log(`[Alert Monitor] Checking ${totalAlerts} alerts for ${pushSubscriptions.length} users...`);

    for (const subscription of pushSubscriptions) {
        if (!subscription.alerts || subscription.alerts.length === 0) continue;

        for (const alert of subscription.alerts) {
            await checkAlert(alert, subscription);
        }
    }
};

// Start the monitoring loop
const startAlertMonitoring = () => {
    console.log('[Alert Monitor] Starting background alert monitoring (every 30 seconds)');

    // Initial check after 10 seconds
    setTimeout(runAlertCheck, 10000);

    // Then every 30 seconds
    setInterval(runAlertCheck, 30000);
};
