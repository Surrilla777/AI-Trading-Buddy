const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// SnapTrade SDK for brokerage integration
const { Snaptrade } = require('snaptrade-typescript-sdk');

// Use environment variable for PORT (Railway sets this automatically)
const PORT = process.env.PORT || 3000;
const PUSH_TOKENS_FILE = path.join(__dirname, 'push-tokens.json');

// ===== FIREBASE ADMIN SDK (for sending push notifications) =====
let firebaseAdmin = null;
let firebaseMessaging = null;

// Initialize Firebase Admin if credentials are available
const initFirebaseAdmin = () => {
    try {
        const admin = require('firebase-admin');
        let serviceAccount = null;

        // Try environment variable first (for Railway deployment)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log('[Firebase Admin] Using credentials from environment variable');
        }
        // Fall back to local file (for local development)
        else {
            const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
            if (fs.existsSync(serviceAccountPath)) {
                serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
                console.log('[Firebase Admin] Using credentials from local file');
            }
        }

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });

            firebaseAdmin = admin;
            firebaseMessaging = admin.messaging();
            console.log('[Firebase Admin] Initialized successfully');
            return true;
        } else {
            console.log('[Firebase Admin] No service account found - push sending disabled');
            console.log('[Firebase Admin] Add firebase-service-account.json or set FIREBASE_SERVICE_ACCOUNT env var');
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

// ===== SNAPTRADE BROKERAGE INTEGRATION =====
const SNAPTRADE_USERS_FILE = path.join(__dirname, 'snaptrade-users.json');

// Initialize SnapTrade client
let snaptrade = null;
const initSnapTrade = () => {
    const clientId = process.env.SNAPTRADE_CLIENT_ID;
    const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;

    if (clientId && consumerKey) {
        snaptrade = new Snaptrade({
            clientId,
            consumerKey
        });
        console.log('[SnapTrade] Initialized successfully');
        return true;
    } else {
        console.log('[SnapTrade] Missing API credentials - brokerage sync disabled');
        console.log('[SnapTrade] Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY in .env');
        return false;
    }
};

// Load saved SnapTrade users
let snaptradeUsers = {};
try {
    if (fs.existsSync(SNAPTRADE_USERS_FILE)) {
        snaptradeUsers = JSON.parse(fs.readFileSync(SNAPTRADE_USERS_FILE, 'utf8'));
        console.log(`[SnapTrade] Loaded ${Object.keys(snaptradeUsers).length} saved users`);
    }
} catch (err) {
    console.log('[SnapTrade] No saved users found');
}

// Save SnapTrade users to file
const saveSnaptradeUsers = () => {
    try {
        fs.writeFileSync(SNAPTRADE_USERS_FILE, JSON.stringify(snaptradeUsers, null, 2));
    } catch (err) {
        console.error('[SnapTrade] Failed to save users:', err.message);
    }
};

// Supported brokerages
const SUPPORTED_BROKERAGES = [
    { id: 'ROBINHOOD', name: 'Robinhood', shortCode: 'RH', color: '#00C805' },
    { id: 'WEBULL', name: 'Webull', shortCode: 'WB', color: '#F5A623' },
    { id: 'SCHWAB', name: 'Schwab / Thinkorswim', shortCode: 'ToS', color: '#00A0DF' },
    { id: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers', shortCode: 'IBKR', color: '#D81E05' },
    { id: 'FIDELITY', name: 'Fidelity', shortCode: 'FID', color: '#4B8B3B' },
    { id: 'ETRADE', name: 'E*Trade', shortCode: 'ET', color: '#6633CC' }
];

initSnapTrade();

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

    // Serve image files (rocket icons, etc.)
    if (url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') || url.pathname.endsWith('.jpeg')) {
        const filePath = path.join(__dirname, url.pathname.slice(1));
        const contentType = url.pathname.endsWith('.png') ? 'image/png' : 'image/jpeg';
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Image not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
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
        const range = url.searchParams.get('range') || '1d';
        const interval = url.searchParams.get('interval') || '1d';
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
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

    // ===== TECHNICAL SCREENER ENDPOINT =====
    // Scans major stocks for technical indicator signals
    if (url.pathname === '/api/technical-screener') {
        (async () => {
        const screenType = url.searchParams.get('type') || 'rsi_oversold';

        // Major stocks to scan (popular large caps)
        const SCREENER_STOCKS = [
            'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'NFLX', 'CRM',
            'ORCL', 'ADBE', 'INTC', 'CSCO', 'AVGO', 'TXN', 'QCOM', 'MU', 'AMAT', 'LRCX',
            'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'V', 'MA', 'PYPL',
            'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO', 'ABT', 'DHR', 'BMY',
            'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'VLO', 'PSX', 'HAL',
            'DIS', 'CMCSA', 'NFLX', 'T', 'VZ', 'TMUS',
            'WMT', 'COST', 'HD', 'LOW', 'TGT', 'AMZN', 'SBUX', 'MCD', 'NKE', 'LULU',
            'BA', 'CAT', 'DE', 'HON', 'UPS', 'FDX', 'RTX', 'LMT', 'GE', 'MMM',
            'KO', 'PEP', 'PG', 'CL', 'KMB', 'MO', 'PM',
            'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'ARKK',
            'COIN', 'MARA', 'RIOT', 'MSTR', 'SQ', 'HOOD', 'SOFI', 'AFRM', 'UPST',
            'PLTR', 'SNOW', 'DDOG', 'NET', 'ZS', 'CRWD', 'PANW', 'OKTA', 'MDB', 'TEAM'
        ];

        // Remove duplicates
        const uniqueStocks = [...new Set(SCREENER_STOCKS)];

        console.log(`[Technical Screener] Scanning ${uniqueStocks.length} stocks for: ${screenType}`);

        const results = [];
        const batchSize = 10;

        const scanStock = async (ticker) => {
            try {
                const indicators = await getTechnicalIndicators(ticker);
                if (!indicators) return null;

                let match = false;
                let signal = '';
                let value = '';

                switch (screenType) {
                    case 'rsi_oversold':
                        if (indicators.rsi && indicators.rsi <= 30) {
                            match = true;
                            signal = 'RSI Oversold';
                            value = `RSI: ${indicators.rsi.toFixed(1)}`;
                        }
                        break;
                    case 'rsi_overbought':
                        if (indicators.rsi && indicators.rsi >= 70) {
                            match = true;
                            signal = 'RSI Overbought';
                            value = `RSI: ${indicators.rsi.toFixed(1)}`;
                        }
                        break;
                    case 'golden_cross':
                        if (indicators.crossType === 'golden') {
                            match = true;
                            signal = 'Golden Cross';
                            value = '50 SMA > 200 SMA';
                        }
                        break;
                    case 'death_cross':
                        if (indicators.crossType === 'death') {
                            match = true;
                            signal = 'Death Cross';
                            value = '50 SMA < 200 SMA';
                        }
                        break;
                    case 'near_sma_50':
                        if (indicators.sma50Distance !== null && Math.abs(indicators.sma50Distance) <= 2) {
                            match = true;
                            const dir = indicators.sma50Distance >= 0 ? 'above' : 'below';
                            signal = 'Near 50 SMA';
                            value = `${Math.abs(indicators.sma50Distance).toFixed(1)}% ${dir}`;
                        }
                        break;
                    case 'near_sma_200':
                        if (indicators.sma200Distance !== null && Math.abs(indicators.sma200Distance) <= 2) {
                            match = true;
                            const dir = indicators.sma200Distance >= 0 ? 'above' : 'below';
                            signal = 'Near 200 SMA';
                            value = `${Math.abs(indicators.sma200Distance).toFixed(1)}% ${dir}`;
                        }
                        break;
                    case 'above_sma_200':
                        if (indicators.sma200Distance !== null && indicators.sma200Distance > 0) {
                            match = true;
                            signal = 'Above 200 SMA';
                            value = `${indicators.sma200Distance.toFixed(1)}% above`;
                        }
                        break;
                    case 'below_sma_200':
                        if (indicators.sma200Distance !== null && indicators.sma200Distance < 0) {
                            match = true;
                            signal = 'Below 200 SMA';
                            value = `${Math.abs(indicators.sma200Distance).toFixed(1)}% below`;
                        }
                        break;
                    case 'sma_200_super':
                    case 'sma_super':
                        // Super scanner - categorize ALL stocks by 50 & 200 SMA position
                        if (indicators.sma200Distance !== null || indicators.sma50Distance !== null) {
                            match = true;
                            const dist200 = indicators.sma200Distance;
                            const dist50 = indicators.sma50Distance;

                            // Prioritize 200 SMA signals, but include 50 SMA info
                            if (dist200 !== null) {
                                const absDist = Math.abs(dist200);
                                if (absDist <= 0.5) {
                                    signal = 'ON 200 SMA';
                                    value = `${dist200 >= 0 ? '+' : ''}${dist200.toFixed(2)}%`;
                                } else if (dist200 > 0 && dist200 <= 2) {
                                    signal = '200 SMA Near Above';
                                    value = `+${dist200.toFixed(1)}%`;
                                } else if (dist200 < 0 && dist200 >= -2) {
                                    signal = '200 SMA Near Below';
                                    value = `${dist200.toFixed(1)}%`;
                                } else if (dist50 !== null && Math.abs(dist50) <= 2) {
                                    // If not near 200, check if near 50
                                    if (Math.abs(dist50) <= 0.5) {
                                        signal = 'ON 50 SMA';
                                        value = `${dist50 >= 0 ? '+' : ''}${dist50.toFixed(2)}%`;
                                    } else if (dist50 > 0) {
                                        signal = '50 SMA Near Above';
                                        value = `+${dist50.toFixed(1)}%`;
                                    } else {
                                        signal = '50 SMA Near Below';
                                        value = `${dist50.toFixed(1)}%`;
                                    }
                                } else {
                                    match = false; // Not near any SMA
                                }
                            }
                        }
                        break;
                }

                if (match) {
                    return {
                        ticker,
                        price: indicators.price?.toFixed(2),
                        signal,
                        value,
                        rsi: indicators.rsi?.toFixed(1),
                        sma50: indicators.sma50?.toFixed(2),
                        sma200: indicators.sma200?.toFixed(2),
                        sma50Dist: indicators.sma50Distance?.toFixed(1),
                        sma200Dist: indicators.sma200Distance?.toFixed(1)
                    };
                }
                return null;
            } catch (err) {
                return null;
            }
        };

        // Process in batches to avoid overwhelming the API
        for (let i = 0; i < uniqueStocks.length; i += batchSize) {
            const batch = uniqueStocks.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(scanStock));
            results.push(...batchResults.filter(r => r !== null));
        }

        console.log(`[Technical Screener] Found ${results.length} matches for ${screenType}`);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            type: screenType,
            count: results.length,
            stocks: results,
            scannedAt: new Date().toISOString()
        }));
        })().catch(err => {
            console.error('[Technical Screener] Error:', err);
            res.writeHead(500, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Screener failed', message: err.message }));
        });
        return;
    }

    // ===== MARKET EDGE ENDPOINTS (Edgeful-style features) =====

    // Gap Scanner - Find stocks that gapped up/down from previous close
    if (url.pathname === '/api/gap-scanner') {
        (async () => {
            const minGap = parseFloat(url.searchParams.get('minGap')) || 1; // Minimum % gap
            const direction = url.searchParams.get('direction') || 'all'; // 'up', 'down', or 'all'

            // Stocks to scan for gaps - includes volatile/meme stocks that gap big
            const GAP_STOCKS = [
                // Major indices
                'SPY', 'QQQ', 'IWM', 'DIA',
                // Big tech
                'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'NFLX', 'INTC',
                // Financials
                'JPM', 'BAC', 'GS', 'V', 'MA', 'C', 'WFC',
                // Energy
                'XOM', 'CVX', 'COP', 'OXY', 'SLB',
                // Healthcare
                'UNH', 'JNJ', 'PFE', 'LLY', 'MRNA', 'BNTX',
                // Industrials
                'BA', 'CAT', 'DE', 'HON', 'GE',
                // Crypto-related (high gap potential)
                'COIN', 'MARA', 'RIOT', 'MSTR', 'CLSK', 'HUT',
                // High-growth tech
                'PLTR', 'SNOW', 'CRWD', 'NET', 'DDOG', 'MDB',
                // Fintech
                'SOFI', 'HOOD', 'AFRM', 'SQ', 'UPST',
                // Retail
                'WMT', 'COST', 'HD', 'TGT',
                // Meme stocks (tend to gap big)
                'GME', 'AMC', 'BBBY', 'KOSS', 'BB',
                // Other volatile names
                'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'F', 'GM',
                // Semiconductors
                'MU', 'QCOM', 'AVGO', 'ARM', 'SMCI'
            ];

            console.log(`[Gap Scanner] Scanning ${GAP_STOCKS.length} stocks for gaps >= ${minGap}%`);

            const results = [];

            const scanGap = async (ticker) => {
                try {
                    // Fetch 2-day data to compare
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
                    const response = await fetch(yahooUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const data = await response.json();

                    if (!data.chart?.result?.[0]) return null;

                    const result = data.chart.result[0];
                    const quotes = result.indicators?.quote?.[0];
                    const meta = result.meta;

                    if (!quotes?.close || quotes.close.length < 2) return null;

                    // Get previous close and current/pre-market price
                    const closes = quotes.close.filter(c => c !== null);
                    const opens = quotes.open?.filter(o => o !== null) || [];

                    if (closes.length < 2) return null;

                    const prevClose = closes[closes.length - 2];
                    const todayOpen = opens[opens.length - 1] || meta.regularMarketPrice;
                    const currentPrice = meta.regularMarketPrice;

                    // Calculate gap from previous close to today's open
                    const gapPercent = ((todayOpen - prevClose) / prevClose) * 100;
                    const gapAbs = Math.abs(gapPercent);

                    // Check if meets criteria
                    if (gapAbs < minGap) return null;
                    if (direction === 'up' && gapPercent <= 0) return null;
                    if (direction === 'down' && gapPercent >= 0) return null;

                    // Calculate gap fill status
                    const gapFilled = gapPercent > 0
                        ? currentPrice <= prevClose  // Gap up filled if price comes back to prev close
                        : currentPrice >= prevClose; // Gap down filled if price comes back up

                    const gapFillPercent = gapPercent > 0
                        ? Math.max(0, Math.min(100, ((todayOpen - currentPrice) / (todayOpen - prevClose)) * 100))
                        : Math.max(0, Math.min(100, ((currentPrice - todayOpen) / (prevClose - todayOpen)) * 100));

                    return {
                        ticker,
                        prevClose: prevClose.toFixed(2),
                        open: todayOpen.toFixed(2),
                        current: currentPrice.toFixed(2),
                        gapPercent: gapPercent.toFixed(2),
                        gapDirection: gapPercent > 0 ? 'UP' : 'DOWN',
                        gapFilled,
                        gapFillPercent: gapFillPercent.toFixed(0),
                        dayChange: (((currentPrice - todayOpen) / todayOpen) * 100).toFixed(2)
                    };
                } catch (err) {
                    return null;
                }
            };

            // Process in batches
            const batchSize = 10;
            for (let i = 0; i < GAP_STOCKS.length; i += batchSize) {
                const batch = GAP_STOCKS.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(scanGap));
                results.push(...batchResults.filter(r => r !== null));
            }

            // Sort by gap size (largest first)
            results.sort((a, b) => Math.abs(parseFloat(b.gapPercent)) - Math.abs(parseFloat(a.gapPercent)));

            console.log(`[Gap Scanner] Found ${results.length} gaps >= ${minGap}%`);

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                count: results.length,
                minGap,
                direction,
                gaps: results,
                scannedAt: new Date().toISOString()
            }));
        })().catch(err => {
            console.error('[Gap Scanner] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Gap scanner failed', message: err.message }));
        });
        return;
    }

    // ORB & IB Levels - Opening Range Breakout and Initial Balance
    if (url.pathname === '/api/orb-levels') {
        (async () => {
            const ticker = url.searchParams.get('ticker') || 'SPY';

            console.log(`[ORB Levels] Fetching for ${ticker}`);

            try {
                // Fetch intraday 5-min data
                const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`;
                const response = await fetch(yahooUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const data = await response.json();

                if (!data.chart?.result?.[0]) {
                    throw new Error('No data returned');
                }

                const result = data.chart.result[0];
                const timestamps = result.timestamp || [];
                const quotes = result.indicators?.quote?.[0];
                const meta = result.meta;

                if (!quotes?.high || !quotes?.low) {
                    throw new Error('Missing quote data');
                }

                // Find market open time (9:30 AM ET)
                const marketOpenET = new Date();
                marketOpenET.setUTCHours(14, 30, 0, 0); // 9:30 AM ET = 14:30 UTC

                // Filter candles to find first 15 min (ORB) and first 60 min (IB)
                const candles = timestamps.map((ts, i) => ({
                    time: new Date(ts * 1000),
                    high: quotes.high[i],
                    low: quotes.low[i],
                    open: quotes.open[i],
                    close: quotes.close[i],
                    volume: quotes.volume[i]
                })).filter(c => c.high !== null && c.low !== null);

                // Get today's candles only (after market open)
                const todayCandles = candles.filter(c => {
                    const hour = c.time.getUTCHours();
                    const min = c.time.getUTCMinutes();
                    return (hour > 14 || (hour === 14 && min >= 30)) && hour < 21;
                });

                if (todayCandles.length === 0) {
                    throw new Error('No market hours data yet');
                }

                // ORB = First 15 minutes (3 x 5-min candles)
                const orbCandles = todayCandles.slice(0, 3);
                const orbHigh = Math.max(...orbCandles.map(c => c.high));
                const orbLow = Math.min(...orbCandles.map(c => c.low));

                // IB = First 60 minutes (12 x 5-min candles)
                const ibCandles = todayCandles.slice(0, 12);
                const ibHigh = Math.max(...ibCandles.map(c => c.high));
                const ibLow = Math.min(...ibCandles.map(c => c.low));

                // Pre-market high/low (before 9:30 AM ET)
                const preMarketCandles = candles.filter(c => {
                    const hour = c.time.getUTCHours();
                    const min = c.time.getUTCMinutes();
                    return hour < 14 || (hour === 14 && min < 30);
                });
                const pmHigh = preMarketCandles.length > 0 ? Math.max(...preMarketCandles.map(c => c.high)) : null;
                const pmLow = preMarketCandles.length > 0 ? Math.min(...preMarketCandles.map(c => c.low)) : null;

                // Previous day high/low (from meta or calculate)
                const prevDayHigh = meta.regularMarketDayHigh || meta.fiftyTwoWeekHigh;
                const prevDayLow = meta.regularMarketDayLow || meta.fiftyTwoWeekLow;

                const currentPrice = meta.regularMarketPrice;

                // Determine current status relative to levels
                const aboveOrbHigh = currentPrice > orbHigh;
                const belowOrbLow = currentPrice < orbLow;
                const aboveIbHigh = currentPrice > ibHigh;
                const belowIbLow = currentPrice < ibLow;

                let orbStatus = 'INSIDE';
                if (aboveOrbHigh) orbStatus = 'ABOVE (Bullish)';
                if (belowOrbLow) orbStatus = 'BELOW (Bearish)';

                let ibStatus = 'INSIDE';
                if (aboveIbHigh) ibStatus = 'ABOVE (Bullish)';
                if (belowIbLow) ibStatus = 'BELOW (Bearish)';

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    ticker,
                    currentPrice: currentPrice?.toFixed(2),
                    orb: {
                        high: orbHigh?.toFixed(2),
                        low: orbLow?.toFixed(2),
                        range: (orbHigh - orbLow)?.toFixed(2),
                        status: orbStatus,
                        candleCount: orbCandles.length
                    },
                    ib: {
                        high: ibHigh?.toFixed(2),
                        low: ibLow?.toFixed(2),
                        range: (ibHigh - ibLow)?.toFixed(2),
                        status: ibStatus,
                        candleCount: ibCandles.length
                    },
                    preMarket: pmHigh ? {
                        high: pmHigh?.toFixed(2),
                        low: pmLow?.toFixed(2)
                    } : null,
                    prevDay: {
                        high: prevDayHigh?.toFixed(2),
                        low: prevDayLow?.toFixed(2)
                    },
                    fetchedAt: new Date().toISOString()
                }));
            } catch (err) {
                console.error('[ORB Levels] Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'ORB fetch failed', message: err.message }));
            }
        })();
        return;
    }

    // Momentum Scanner - Find stocks moving big right now
    if (url.pathname === '/api/momentum-scanner') {
        (async () => {
            const timeframe = url.searchParams.get('timeframe') || '1d'; // 1d, 5d
            const minMove = parseFloat(url.searchParams.get('minMove')) || 3; // Minimum % move

            const MOMENTUM_STOCKS = [
                'SPY', 'QQQ', 'IWM',
                'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'NFLX',
                'COIN', 'MARA', 'RIOT', 'MSTR', 'HOOD', 'SOFI', 'AFRM', 'SQ',
                'PLTR', 'SNOW', 'CRWD', 'NET', 'DDOG', 'MDB',
                'BA', 'CAT', 'XOM', 'CVX',
                'JPM', 'GS', 'BAC',
                'GME', 'AMC', 'BBBY', 'KOSS'
            ];

            console.log(`[Momentum Scanner] Scanning for moves >= ${minMove}%`);

            const results = [];

            const scanMomentum = async (ticker) => {
                try {
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
                    const response = await fetch(yahooUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const data = await response.json();

                    if (!data.chart?.result?.[0]) return null;

                    const meta = data.chart.result[0].meta;
                    const quotes = data.chart.result[0].indicators?.quote?.[0];

                    const currentPrice = meta.regularMarketPrice;
                    const prevClose = meta.chartPreviousClose || meta.previousClose;
                    const dayChange = ((currentPrice - prevClose) / prevClose) * 100;

                    // Volume analysis
                    const volumes = quotes?.volume?.filter(v => v !== null) || [];
                    const avgVolume = volumes.length > 1
                        ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
                        : volumes[0] || 0;
                    const todayVolume = volumes[volumes.length - 1] || 0;
                    const relativeVolume = avgVolume > 0 ? (todayVolume / avgVolume) : 1;

                    if (Math.abs(dayChange) < minMove) return null;

                    // Determine momentum status
                    let status = 'MOVING';
                    if (dayChange >= 5) status = 'RIPPING 🚀';
                    else if (dayChange >= 3) status = 'BULLISH 📈';
                    else if (dayChange <= -5) status = 'DRILLING 💀';
                    else if (dayChange <= -3) status = 'BEARISH 📉';

                    return {
                        ticker,
                        price: currentPrice?.toFixed(2),
                        change: dayChange.toFixed(2),
                        status,
                        volume: todayVolume,
                        relativeVolume: relativeVolume.toFixed(1) + 'x',
                        volumeStatus: relativeVolume >= 2 ? 'HIGH' : relativeVolume >= 1.5 ? 'ELEVATED' : 'NORMAL'
                    };
                } catch (err) {
                    return null;
                }
            };

            const batchSize = 10;
            for (let i = 0; i < MOMENTUM_STOCKS.length; i += batchSize) {
                const batch = MOMENTUM_STOCKS.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(scanMomentum));
                results.push(...batchResults.filter(r => r !== null));
            }

            // Sort by absolute change (biggest movers first)
            results.sort((a, b) => Math.abs(parseFloat(b.change)) - Math.abs(parseFloat(a.change)));

            // Split into gainers and losers
            const gainers = results.filter(r => parseFloat(r.change) > 0);
            const losers = results.filter(r => parseFloat(r.change) < 0);

            console.log(`[Momentum Scanner] Found ${gainers.length} gainers, ${losers.length} losers`);

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                minMove,
                gainers,
                losers,
                all: results,
                scannedAt: new Date().toISOString()
            }));
        })().catch(err => {
            console.error('[Momentum Scanner] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Momentum scanner failed', message: err.message }));
        });
        return;
    }

    // Key Levels for multiple tickers (batch)
    if (url.pathname === '/api/key-levels') {
        (async () => {
            const tickers = (url.searchParams.get('tickers') || 'SPY,QQQ,IWM').split(',');

            console.log(`[Key Levels] Fetching for ${tickers.join(', ')}`);

            const results = [];

            for (const ticker of tickers) {
                try {
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
                    const response = await fetch(yahooUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const data = await response.json();

                    if (!data.chart?.result?.[0]) continue;

                    const result = data.chart.result[0];
                    const meta = result.meta;
                    const quotes = result.indicators?.quote?.[0];

                    const closes = quotes?.close?.filter(c => c !== null) || [];
                    const highs = quotes?.high?.filter(h => h !== null) || [];
                    const lows = quotes?.low?.filter(l => l !== null) || [];

                    const currentPrice = meta.regularMarketPrice;
                    const prevDayHigh = highs.length >= 2 ? highs[highs.length - 2] : meta.regularMarketDayHigh;
                    const prevDayLow = lows.length >= 2 ? lows[lows.length - 2] : meta.regularMarketDayLow;
                    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;

                    // Calculate pivot points (classic formula)
                    const pivot = (prevDayHigh + prevDayLow + prevClose) / 3;
                    const r1 = (2 * pivot) - prevDayLow;
                    const s1 = (2 * pivot) - prevDayHigh;
                    const r2 = pivot + (prevDayHigh - prevDayLow);
                    const s2 = pivot - (prevDayHigh - prevDayLow);

                    results.push({
                        ticker,
                        currentPrice: currentPrice?.toFixed(2),
                        prevDay: {
                            high: prevDayHigh?.toFixed(2),
                            low: prevDayLow?.toFixed(2),
                            close: prevClose?.toFixed(2)
                        },
                        pivots: {
                            pivot: pivot?.toFixed(2),
                            r1: r1?.toFixed(2),
                            r2: r2?.toFixed(2),
                            s1: s1?.toFixed(2),
                            s2: s2?.toFixed(2)
                        },
                        distanceFromPivot: ((currentPrice - pivot) / pivot * 100)?.toFixed(2) + '%'
                    });
                } catch (err) {
                    console.error(`[Key Levels] Error for ${ticker}:`, err.message);
                }
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                levels: results,
                fetchedAt: new Date().toISOString()
            }));
        })().catch(err => {
            console.error('[Key Levels] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Key levels fetch failed', message: err.message }));
        });
        return;
    }

    // ===== IV SCANNER ENDPOINT =====
    // Analyzes IV conditions for 0DTE trading at market open
    if (url.pathname === '/api/iv-scanner') {
        (async () => {
            const tickers = (url.searchParams.get('tickers') || 'SPY,QQQ,IWM').split(',').map(t => t.trim().toUpperCase());
            console.log(`[IV Scanner] Analyzing: ${tickers.join(', ')}`);

            // Helper to fetch Yahoo data with auth
            const fetchYahooOptions = (ticker, expiryTimestamp = null) => {
                return new Promise((resolve, reject) => {
                    getYahooAuth().then(auth => {
                        const yahooUrl = expiryTimestamp
                            ? `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiryTimestamp}&crumb=${encodeURIComponent(auth.crumb)}`
                            : `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(auth.crumb)}`;

                        https.get(yahooUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Accept': 'application/json',
                                'Cookie': auth.cookies
                            }
                        }, (response) => {
                            let data = '';
                            response.on('data', chunk => data += chunk);
                            response.on('end', () => {
                                try {
                                    resolve(JSON.parse(data));
                                } catch (e) {
                                    reject(new Error('Failed to parse options data'));
                                }
                            });
                        }).on('error', reject);
                    }).catch(reject);
                });
            };

            // Helper to fetch price history
            const fetchYahooChart = (ticker, range = '5d', interval = '1d') => {
                return new Promise((resolve, reject) => {
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
                    https.get(yahooUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }, (response) => {
                        let data = '';
                        response.on('data', chunk => data += chunk);
                        response.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error('Failed to parse chart data'));
                            }
                        });
                    }).on('error', reject);
                });
            };

            try {
                const results = {};
                const now = new Date();
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const todayTimestamp = Math.floor(today.getTime() / 1000);

                // Calculate 7DTE timestamp (next week, same day)
                const sevenDaysOut = new Date(today);
                sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
                const sevenDteTimestamp = Math.floor(sevenDaysOut.getTime() / 1000);

                // 1. Fetch VIX data for context
                console.log('[IV Scanner] Fetching VIX data...');
                const vixData = await fetchYahooChart('^VIX', '5d', '1d');
                let vixAnalysis = { current: null, avg5d: null, elevated: null };

                if (vixData?.chart?.result?.[0]) {
                    const vixResult = vixData.chart.result[0];
                    const closes = vixResult.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
                    if (closes.length > 0) {
                        vixAnalysis.current = closes[closes.length - 1];
                        vixAnalysis.avg5d = closes.reduce((a, b) => a + b, 0) / closes.length;
                        const deviation = ((vixAnalysis.current - vixAnalysis.avg5d) / vixAnalysis.avg5d) * 100;
                        vixAnalysis.deviation = deviation;
                        vixAnalysis.elevated = deviation > 10 ? 'HIGH' : deviation < -10 ? 'LOW' : 'NORMAL';
                    }
                }
                console.log(`[IV Scanner] VIX: ${vixAnalysis.current?.toFixed(2)} (5d avg: ${vixAnalysis.avg5d?.toFixed(2)}, ${vixAnalysis.elevated})`);

                // 2. VIX Trend Analysis (rising or falling)
                console.log('[IV Scanner] Analyzing VIX trend...');
                let vixTrend = 'NEUTRAL';
                if (vixData?.chart?.result?.[0]) {
                    const vixResult = vixData.chart.result[0];
                    const closes = vixResult.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
                    if (closes.length >= 2) {
                        const prevVix = closes[closes.length - 2];
                        const currVix = closes[closes.length - 1];
                        const vixChange = ((currVix - prevVix) / prevVix) * 100;
                        vixTrend = vixChange > 3 ? 'RISING' : vixChange < -3 ? 'FALLING' : 'FLAT';
                        vixAnalysis.trend = vixTrend;
                        vixAnalysis.change = vixChange;
                    }
                }
                console.log(`[IV Scanner] VIX Trend: ${vixTrend}`);

                // 3. Fetch pre-market range for SPY (using extended hours if available)
                console.log('[IV Scanner] Fetching pre-market range...');
                const spyPremarket = await fetchYahooChart('SPY', '1d', '1m');
                let premarketRange = { high: null, low: null, range: null, verdict: null, direction: null };

                // Also get yesterday's close for pre-market direction
                const spyDaily = await fetchYahooChart('SPY', '5d', '1d');
                let prevClose = null;
                if (spyDaily?.chart?.result?.[0]) {
                    const dailyCloses = spyDaily.chart.result[0].indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
                    if (dailyCloses.length >= 2) {
                        prevClose = dailyCloses[dailyCloses.length - 2];
                    }
                }

                if (spyPremarket?.chart?.result?.[0]) {
                    const spyResult = spyPremarket.chart.result[0];
                    const highs = spyResult.indicators?.quote?.[0]?.high?.filter(h => h != null) || [];
                    const lows = spyResult.indicators?.quote?.[0]?.low?.filter(l => l != null) || [];
                    const closes = spyResult.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
                    if (highs.length > 0 && lows.length > 0) {
                        premarketRange.high = Math.max(...highs);
                        premarketRange.low = Math.min(...lows);
                        premarketRange.range = premarketRange.high - premarketRange.low;
                        premarketRange.verdict = premarketRange.range > 3 ? 'LARGE_MOVE' : premarketRange.range < 1.5 ? 'COILED' : 'NORMAL';

                        // Pre-market direction
                        const currentPrice = closes[closes.length - 1];
                        if (prevClose && currentPrice) {
                            const pmChange = ((currentPrice - prevClose) / prevClose) * 100;
                            premarketRange.currentPrice = currentPrice;
                            premarketRange.prevClose = prevClose;
                            premarketRange.change = pmChange;
                            premarketRange.direction = pmChange > 0.2 ? 'GREEN' : pmChange < -0.2 ? 'RED' : 'FLAT';
                        }
                    }
                }
                console.log(`[IV Scanner] SPY Range: $${premarketRange.range?.toFixed(2)} (${premarketRange.verdict}), Direction: ${premarketRange.direction}`);

                // 3. Analyze each ticker
                for (const ticker of tickers) {
                    console.log(`[IV Scanner] Analyzing ${ticker}...`);
                    try {
                        // Get options chain (includes available expirations)
                        const optionsData = await fetchYahooOptions(ticker);

                        if (!optionsData?.optionChain?.result?.[0]) {
                            results[ticker] = { error: 'No options data available' };
                            continue;
                        }

                        const optionResult = optionsData.optionChain.result[0];
                        const expirations = optionResult.expirationDates || [];
                        const currentPrice = optionResult.quote?.regularMarketPrice || optionResult.quote?.postMarketPrice;

                        if (!currentPrice) {
                            results[ticker] = { error: 'No price data' };
                            continue;
                        }

                        // Find 0DTE (today's expiry) and ~7DTE expiry
                        const zeroDteExpiry = expirations.find(e => {
                            const expDate = new Date(e * 1000);
                            return expDate.toDateString() === today.toDateString();
                        });

                        const sevenDteExpiry = expirations.find(e => {
                            const expDate = new Date(e * 1000);
                            const diffDays = Math.round((expDate - today) / (1000 * 60 * 60 * 24));
                            return diffDays >= 5 && diffDays <= 9; // 5-9 days out
                        });

                        // Get ATM strike
                        const calls = optionResult.options?.[0]?.calls || [];
                        const atmStrike = calls.reduce((closest, opt) => {
                            return Math.abs(opt.strike - currentPrice) < Math.abs(closest.strike - currentPrice) ? opt : closest;
                        }, calls[0])?.strike;

                        // Get 0DTE IV for ATM
                        let zeroDteIV = null;
                        let zeroDteBidAsk = null;
                        if (zeroDteExpiry) {
                            const zeroDteData = await fetchYahooOptions(ticker, zeroDteExpiry);
                            const zeroDteCalls = zeroDteData?.optionChain?.result?.[0]?.options?.[0]?.calls || [];
                            const atmOption = zeroDteCalls.find(c => c.strike === atmStrike);
                            if (atmOption) {
                                zeroDteIV = atmOption.impliedVolatility;
                                const bid = atmOption.bid || 0;
                                const ask = atmOption.ask || 0;
                                const mid = (bid + ask) / 2;
                                zeroDteBidAsk = mid > 0 ? ((ask - bid) / mid) * 100 : null;
                            }
                        }

                        // Get 7DTE IV for ATM (same strike)
                        let sevenDteIV = null;
                        if (sevenDteExpiry) {
                            const sevenDteData = await fetchYahooOptions(ticker, sevenDteExpiry);
                            const sevenDteCalls = sevenDteData?.optionChain?.result?.[0]?.options?.[0]?.calls || [];
                            const atmOption = sevenDteCalls.find(c => c.strike === atmStrike);
                            if (atmOption) {
                                sevenDteIV = atmOption.impliedVolatility;
                            }
                        }

                        // Calculate term structure
                        let termStructure = null;
                        let termStructureVerdict = null;
                        if (zeroDteIV && sevenDteIV) {
                            termStructure = ((zeroDteIV - sevenDteIV) / sevenDteIV) * 100;
                            // If 0DTE IV > 7DTE IV by 15%+, premium is elevated (sell favored)
                            termStructureVerdict = termStructure > 15 ? 'ELEVATED' : termStructure < -10 ? 'INVERTED' : 'NORMAL';
                        }

                        // Spread analysis
                        let spreadVerdict = null;
                        if (zeroDteBidAsk !== null) {
                            spreadVerdict = zeroDteBidAsk > 10 ? 'WIDE' : zeroDteBidAsk < 5 ? 'TIGHT' : 'NORMAL';
                        }

                        // === DIRECTIONAL ANALYSIS ===
                        // Fetch historical data for this ticker to calculate RSI, trend, VWAP
                        const tickerDaily = await fetchYahooChart(ticker, '1mo', '1d');
                        let rsi = null;
                        let trend = 'NEUTRAL';
                        let closeVsVwap = null;
                        let consecutiveDirection = { red: 0, green: 0 };

                        if (tickerDaily?.chart?.result?.[0]) {
                            const dailyResult = tickerDaily.chart.result[0];
                            const closes = dailyResult.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
                            const opens = dailyResult.indicators?.quote?.[0]?.open?.filter(o => o != null) || [];
                            const highs = dailyResult.indicators?.quote?.[0]?.high?.filter(h => h != null) || [];
                            const lows = dailyResult.indicators?.quote?.[0]?.low?.filter(l => l != null) || [];
                            const volumes = dailyResult.indicators?.quote?.[0]?.volume?.filter(v => v != null) || [];

                            if (closes.length >= 15) {
                                // RSI Calculation (14-period)
                                let gains = 0, losses = 0;
                                for (let i = closes.length - 14; i < closes.length; i++) {
                                    const change = closes[i] - closes[i - 1];
                                    if (change > 0) gains += change;
                                    else losses -= change;
                                }
                                const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
                                rsi = 100 - (100 / (1 + rs));

                                // Trend (SMA comparison)
                                const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
                                const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
                                trend = sma5 > sma20 * 1.005 ? 'BULLISH' : sma5 < sma20 * 0.995 ? 'BEARISH' : 'NEUTRAL';

                                // Yesterday's close vs VWAP approximation
                                const lastIdx = closes.length - 1;
                                const typicalPrice = (highs[lastIdx] + lows[lastIdx] + closes[lastIdx]) / 3;
                                closeVsVwap = closes[lastIdx] > typicalPrice ? 'ABOVE' : 'BELOW';

                                // Consecutive red/green days
                                for (let i = lastIdx; i >= Math.max(0, lastIdx - 5); i--) {
                                    if (closes[i] < opens[i]) {
                                        if (consecutiveDirection.green > 0) break;
                                        consecutiveDirection.red++;
                                    } else if (closes[i] > opens[i]) {
                                        if (consecutiveDirection.red > 0) break;
                                        consecutiveDirection.green++;
                                    } else break;
                                }
                            }
                        }

                        // Calculate Directional Bias Score
                        let bullishPoints = 0;
                        let bearishPoints = 0;
                        let directionSignals = [];

                        // VIX Trend: falling = bullish, rising = bearish
                        if (vixTrend === 'FALLING') {
                            bullishPoints += 2;
                            directionSignals.push({ signal: 'VIX Falling', bias: 'bullish' });
                        } else if (vixTrend === 'RISING') {
                            bearishPoints += 2;
                            directionSignals.push({ signal: 'VIX Rising', bias: 'bearish' });
                        }

                        // Pre-market direction
                        if (premarketRange.direction === 'GREEN') {
                            bullishPoints += 2;
                            directionSignals.push({ signal: `Pre-market +${premarketRange.change?.toFixed(2)}%`, bias: 'bullish' });
                        } else if (premarketRange.direction === 'RED') {
                            bearishPoints += 2;
                            directionSignals.push({ signal: `Pre-market ${premarketRange.change?.toFixed(2)}%`, bias: 'bearish' });
                        }

                        // RSI
                        if (rsi !== null) {
                            if (rsi < 30) {
                                bullishPoints += 2;
                                directionSignals.push({ signal: `RSI Oversold (${rsi.toFixed(0)})`, bias: 'bullish' });
                            } else if (rsi > 70) {
                                bearishPoints += 2;
                                directionSignals.push({ signal: `RSI Overbought (${rsi.toFixed(0)})`, bias: 'bearish' });
                            } else if (rsi < 45) {
                                bullishPoints += 1;
                                directionSignals.push({ signal: `RSI Low (${rsi.toFixed(0)})`, bias: 'bullish' });
                            } else if (rsi > 55) {
                                bearishPoints += 1;
                                directionSignals.push({ signal: `RSI High (${rsi.toFixed(0)})`, bias: 'bearish' });
                            }
                        }

                        // Trend
                        if (trend === 'BULLISH') {
                            bullishPoints += 1;
                            directionSignals.push({ signal: 'Uptrend', bias: 'bullish' });
                        } else if (trend === 'BEARISH') {
                            bearishPoints += 1;
                            directionSignals.push({ signal: 'Downtrend', bias: 'bearish' });
                        }

                        // VWAP Position
                        if (closeVsVwap === 'ABOVE') {
                            bullishPoints += 1;
                            directionSignals.push({ signal: 'Closed Above VWAP', bias: 'bullish' });
                        } else if (closeVsVwap === 'BELOW') {
                            bearishPoints += 1;
                            directionSignals.push({ signal: 'Closed Below VWAP', bias: 'bearish' });
                        }

                        // Mean reversion from consecutive days
                        if (consecutiveDirection.red >= 3) {
                            bullishPoints += 2;
                            directionSignals.push({ signal: `${consecutiveDirection.red} Red Days (bounce?)`, bias: 'bullish' });
                        } else if (consecutiveDirection.green >= 3) {
                            bearishPoints += 1;
                            directionSignals.push({ signal: `${consecutiveDirection.green} Green Days (pullback?)`, bias: 'bearish' });
                        }

                        // Determine direction verdict
                        const directionScore = bullishPoints - bearishPoints;
                        let direction = 'NEUTRAL';
                        let directionConfidence = 5;

                        if (directionScore >= 4) {
                            direction = 'CALLS';
                            directionConfidence = Math.min(10, 6 + Math.floor(directionScore / 2));
                        } else if (directionScore >= 2) {
                            direction = 'LEAN_CALLS';
                            directionConfidence = 6;
                        } else if (directionScore <= -4) {
                            direction = 'PUTS';
                            directionConfidence = Math.min(10, 6 + Math.floor(Math.abs(directionScore) / 2));
                        } else if (directionScore <= -2) {
                            direction = 'LEAN_PUTS';
                            directionConfidence = 6;
                        }

                        // Generate overall verdict
                        let verdict = 'NEUTRAL';
                        let confidence = 5;
                        let notes = [];

                        // VIX elevated + high term structure = IV crush likely
                        if (vixAnalysis.elevated === 'HIGH' && termStructureVerdict === 'ELEVATED') {
                            verdict = 'IV_CRUSH_LIKELY';
                            confidence = 8;
                            notes.push('VIX elevated + 0DTE premium high - take quick profits');
                        }
                        // VIX low + normal/inverted term structure = IV expansion possible
                        else if (vixAnalysis.elevated === 'LOW' && termStructureVerdict !== 'ELEVATED') {
                            verdict = 'IV_EXPANSION_LIKELY';
                            confidence = 7;
                            notes.push('VIX depressed - could see volatility spike');
                        }
                        // Coiled premarket = potential for expansion
                        else if (premarketRange.verdict === 'COILED') {
                            verdict = 'IV_EXPANSION_LIKELY';
                            confidence = 6;
                            notes.push('Tight pre-market range - breakout potential');
                        }
                        // Large premarket move = IV may be priced in
                        else if (premarketRange.verdict === 'LARGE_MOVE') {
                            verdict = 'IV_CRUSH_LIKELY';
                            confidence = 6;
                            notes.push('Big pre-market move - IV may be priced in');
                        }
                        // Wide spreads = wait
                        if (spreadVerdict === 'WIDE') {
                            if (verdict !== 'WAIT') {
                                notes.push('Wide spreads - consider waiting for tightening');
                            }
                            if (confidence > 3) confidence -= 2;
                        }

                        results[ticker] = {
                            price: currentPrice,
                            atmStrike,
                            zeroDteExpiry: zeroDteExpiry ? new Date(zeroDteExpiry * 1000).toISOString().split('T')[0] : null,
                            sevenDteExpiry: sevenDteExpiry ? new Date(sevenDteExpiry * 1000).toISOString().split('T')[0] : null,
                            zeroDteIV: zeroDteIV ? (zeroDteIV * 100).toFixed(1) + '%' : null,
                            sevenDteIV: sevenDteIV ? (sevenDteIV * 100).toFixed(1) + '%' : null,
                            termStructure: termStructure ? termStructure.toFixed(1) + '%' : null,
                            termStructureVerdict,
                            bidAskSpread: zeroDteBidAsk ? zeroDteBidAsk.toFixed(1) + '%' : null,
                            spreadVerdict,
                            verdict,
                            confidence,
                            notes,
                            // Direction data
                            direction,
                            directionConfidence,
                            directionSignals,
                            rsi: rsi ? rsi.toFixed(0) : null,
                            trend,
                            closeVsVwap,
                            consecutiveRed: consecutiveDirection.red,
                            consecutiveGreen: consecutiveDirection.green
                        };

                    } catch (tickerErr) {
                        console.error(`[IV Scanner] Error for ${ticker}:`, tickerErr.message);
                        results[ticker] = { error: tickerErr.message };
                    }
                }

                // Send response
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    scanTime: new Date().toISOString(),
                    marketStatus: now.getHours() >= 9 && now.getHours() < 16 ? 'OPEN' : 'CLOSED',
                    vix: vixAnalysis,
                    premarketRange,
                    tickers: results
                }));

            } catch (err) {
                console.error('[IV Scanner] Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'IV scan failed', message: err.message }));
            }
        })();
        return;
    }

    // ===== TEST MORNING IV PUSH NOTIFICATION =====
    // Manual trigger for testing the morning IV scan push notification
    if (url.pathname === '/api/test-morning-iv-push') {
        (async () => {
            console.log('[Test] Triggering morning IV push notification...');
            await runMorningIVScan();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ success: true, message: 'Morning IV push notification sent' }));
        })();
        return;
    }

    // ===== NEXT DAY PREDICTION ENDPOINT =====
    // Predicts open/close direction based on historical patterns
    if (url.pathname === '/api/next-day-prediction') {
        (async () => {
            const tickers = (url.searchParams.get('tickers') || 'SPY,QQQ,IWM').split(',').map(t => t.trim().toUpperCase());
            console.log(`[Next Day Prediction] Analyzing: ${tickers.join(', ')}`);

            // Helper to fetch price history
            const fetchYahooChart = (ticker, range = '6mo', interval = '1d') => {
                return new Promise((resolve, reject) => {
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
                    https.get(yahooUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }, (response) => {
                        let data = '';
                        response.on('data', chunk => data += chunk);
                        response.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error('Failed to parse chart data'));
                            }
                        });
                    }).on('error', reject);
                });
            };

            try {
                const results = {};

                for (const ticker of tickers) {
                    console.log(`[Next Day Prediction] Analyzing ${ticker}...`);
                    try {
                        // Fetch 6 months of daily data for pattern matching
                        const data = await fetchYahooChart(ticker, '6mo', '1d');

                        if (!data?.chart?.result?.[0]) {
                            results[ticker] = { error: 'No data available' };
                            continue;
                        }

                        const result = data.chart.result[0];
                        const timestamps = result.timestamp || [];
                        const quotes = result.indicators?.quote?.[0] || {};
                        const opens = quotes.open || [];
                        const highs = quotes.high || [];
                        const lows = quotes.low || [];
                        const closes = quotes.close || [];
                        const volumes = quotes.volume || [];

                        if (closes.length < 60) {
                            results[ticker] = { error: 'Insufficient history' };
                            continue;
                        }

                        const lastIdx = closes.length - 1;
                        const today = {
                            open: opens[lastIdx],
                            high: highs[lastIdx],
                            low: lows[lastIdx],
                            close: closes[lastIdx],
                            volume: volumes[lastIdx],
                            prevClose: closes[lastIdx - 1]
                        };

                        // Calculate today's indicators
                        const dayChange = ((today.close - today.prevClose) / today.prevClose) * 100;
                        const todayRed = today.close < today.open;
                        const todayGreen = today.close > today.open;

                        // RSI (14-period)
                        let gains = 0, losses = 0;
                        for (let i = lastIdx - 13; i <= lastIdx; i++) {
                            const change = closes[i] - closes[i - 1];
                            if (change > 0) gains += change;
                            else losses -= change;
                        }
                        const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
                        const rsi = 100 - (100 / (1 + rs));

                        // Moving averages
                        const sma20 = closes.slice(lastIdx - 19, lastIdx + 1).reduce((a, b) => a + b, 0) / 20;
                        const sma50 = closes.slice(lastIdx - 49, lastIdx + 1).reduce((a, b) => a + b, 0) / 50;

                        // Volume analysis
                        const avgVolume20 = volumes.slice(lastIdx - 19, lastIdx + 1).reduce((a, b) => a + b, 0) / 20;
                        const volumeRatio = today.volume / avgVolume20;

                        // Consecutive days
                        let consecutiveRed = 0;
                        let consecutiveGreen = 0;
                        for (let i = lastIdx; i >= lastIdx - 5 && i >= 0; i--) {
                            if (closes[i] < opens[i]) {
                                if (consecutiveGreen > 0) break;
                                consecutiveRed++;
                            } else if (closes[i] > opens[i]) {
                                if (consecutiveRed > 0) break;
                                consecutiveGreen++;
                            } else break;
                        }

                        // Candle pattern detection
                        const bodySize = Math.abs(today.close - today.open);
                        const upperWick = today.high - Math.max(today.open, today.close);
                        const lowerWick = Math.min(today.open, today.close) - today.low;
                        const range = today.high - today.low;

                        let candlePattern = 'none';
                        if (bodySize < range * 0.1 && range > 0) candlePattern = 'doji';
                        else if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && todayGreen) candlePattern = 'hammer';
                        else if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && todayRed) candlePattern = 'shooting_star';
                        else if (todayGreen && bodySize > range * 0.6) candlePattern = 'bullish_engulfing';
                        else if (todayRed && bodySize > range * 0.6) candlePattern = 'bearish_engulfing';

                        // VWAP approximation (using typical price * volume)
                        const typicalPrice = (today.high + today.low + today.close) / 3;
                        const closeAboveVwap = today.close > typicalPrice;

                        // Day of week (0 = Sunday, 5 = Friday)
                        const dayOfWeek = new Date(timestamps[lastIdx] * 1000).getDay();
                        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

                        // Historical pattern matching - find similar setups
                        let gapUpCount = 0, gapDownCount = 0;
                        let greenCloseCount = 0, redCloseCount = 0;
                        let matchCount = 0;
                        const matchDetails = [];

                        for (let i = 60; i < lastIdx - 1; i++) {
                            // Check if this historical day matches today's pattern
                            const histRsi = (() => {
                                let g = 0, l = 0;
                                for (let j = i - 13; j <= i; j++) {
                                    const c = closes[j] - closes[j - 1];
                                    if (c > 0) g += c; else l -= c;
                                }
                                const r = l === 0 ? 100 : (g / 14) / (l / 14);
                                return 100 - (100 / (1 + r));
                            })();

                            const histDayChange = ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100;
                            const histRed = closes[i] < opens[i];
                            const histGreen = closes[i] > opens[i];

                            // Count consecutive red/green before this day
                            let histConsecRed = 0, histConsecGreen = 0;
                            for (let j = i; j >= i - 5 && j >= 0; j--) {
                                if (closes[j] < opens[j]) {
                                    if (histConsecGreen > 0) break;
                                    histConsecRed++;
                                } else if (closes[j] > opens[j]) {
                                    if (histConsecRed > 0) break;
                                    histConsecGreen++;
                                } else break;
                            }

                            // Match criteria (fuzzy matching)
                            const rsiMatch = Math.abs(histRsi - rsi) < 15;
                            const trendMatch = (histRed === todayRed) || (histGreen === todayGreen);
                            const consecMatch = (consecutiveRed > 0 && histConsecRed > 0) || (consecutiveGreen > 0 && histConsecGreen > 0);
                            const moveMatch = Math.abs(histDayChange - dayChange) < 1.5;

                            // Require at least 3 matches
                            const matchScore = (rsiMatch ? 1 : 0) + (trendMatch ? 1 : 0) + (consecMatch ? 1 : 0) + (moveMatch ? 1 : 0);

                            if (matchScore >= 3) {
                                matchCount++;
                                // Check what happened the NEXT day
                                const nextOpen = opens[i + 1];
                                const nextClose = closes[i + 1];
                                const thisClose = closes[i];

                                const gappedUp = nextOpen > thisClose;
                                const closedGreen = nextClose > nextOpen;

                                if (gappedUp) gapUpCount++;
                                else gapDownCount++;

                                if (closedGreen) greenCloseCount++;
                                else redCloseCount++;

                                // Store for details
                                if (matchDetails.length < 5) {
                                    matchDetails.push({
                                        date: new Date(timestamps[i] * 1000).toLocaleDateString(),
                                        nextDayGap: ((nextOpen - thisClose) / thisClose * 100).toFixed(2) + '%',
                                        nextDayClose: closedGreen ? 'GREEN' : 'RED',
                                        nextDayMove: ((nextClose - nextOpen) / nextOpen * 100).toFixed(2) + '%'
                                    });
                                }
                            }
                        }

                        // Calculate probabilities
                        const gapUpProb = matchCount > 0 ? Math.round((gapUpCount / matchCount) * 100) : 50;
                        const gapDownProb = 100 - gapUpProb;
                        const greenProb = matchCount > 0 ? Math.round((greenCloseCount / matchCount) * 100) : 50;
                        const redProb = 100 - greenProb;

                        // Build signals list
                        const signals = [];
                        if (rsi < 30) signals.push({ signal: 'RSI Oversold', bias: 'bullish', value: rsi.toFixed(0) });
                        if (rsi > 70) signals.push({ signal: 'RSI Overbought', bias: 'bearish', value: rsi.toFixed(0) });
                        if (consecutiveRed >= 3) signals.push({ signal: `${consecutiveRed} Red Days`, bias: 'bullish', value: 'mean reversion' });
                        if (consecutiveGreen >= 3) signals.push({ signal: `${consecutiveGreen} Green Days`, bias: 'bearish', value: 'mean reversion' });
                        if (today.close > sma20) signals.push({ signal: 'Above SMA20', bias: 'bullish', value: `$${sma20.toFixed(2)}` });
                        if (today.close < sma20) signals.push({ signal: 'Below SMA20', bias: 'bearish', value: `$${sma20.toFixed(2)}` });
                        if (today.close > sma50) signals.push({ signal: 'Above SMA50', bias: 'bullish', value: `$${sma50.toFixed(2)}` });
                        if (today.close < sma50) signals.push({ signal: 'Below SMA50', bias: 'bearish', value: `$${sma50.toFixed(2)}` });
                        if (volumeRatio > 1.5) signals.push({ signal: 'High Volume', bias: todayGreen ? 'bullish' : 'bearish', value: `${volumeRatio.toFixed(1)}x avg` });
                        if (candlePattern !== 'none') signals.push({ signal: candlePattern.replace('_', ' '), bias: candlePattern.includes('bull') || candlePattern === 'hammer' ? 'bullish' : candlePattern.includes('bear') || candlePattern === 'shooting_star' ? 'bearish' : 'neutral', value: 'pattern' });
                        if (closeAboveVwap) signals.push({ signal: 'Closed Above VWAP', bias: 'bullish', value: '' });
                        else signals.push({ signal: 'Closed Below VWAP', bias: 'bearish', value: '' });

                        // Day of week bias (historical tendencies)
                        if (dayOfWeek === 1) signals.push({ signal: 'Monday', bias: 'neutral', value: 'often follows Friday' });
                        if (dayOfWeek === 5) signals.push({ signal: 'Friday', bias: 'neutral', value: 'weekend positioning' });

                        // Overall bias calculation
                        const bullishSignals = signals.filter(s => s.bias === 'bullish').length;
                        const bearishSignals = signals.filter(s => s.bias === 'bearish').length;
                        const overallBias = bullishSignals > bearishSignals ? 'BULLISH' : bearishSignals > bullishSignals ? 'BEARISH' : 'NEUTRAL';

                        results[ticker] = {
                            price: today.close.toFixed(2),
                            dayChange: dayChange.toFixed(2) + '%',
                            todayColor: todayGreen ? 'GREEN' : todayRed ? 'RED' : 'FLAT',
                            rsi: rsi.toFixed(0),
                            sma20: sma20.toFixed(2),
                            sma50: sma50.toFixed(2),
                            volumeRatio: volumeRatio.toFixed(1) + 'x',
                            consecutiveRed,
                            consecutiveGreen,
                            candlePattern,
                            dayOfWeek: dayNames[dayOfWeek],
                            closeAboveVwap,
                            signals,
                            overallBias,
                            prediction: {
                                open: {
                                    gapUp: gapUpProb,
                                    gapDown: gapDownProb,
                                    prediction: gapUpProb > 55 ? 'GAP UP' : gapDownProb > 55 ? 'GAP DOWN' : 'FLAT/UNCERTAIN'
                                },
                                close: {
                                    green: greenProb,
                                    red: redProb,
                                    prediction: greenProb > 55 ? 'GREEN' : redProb > 55 ? 'RED' : 'UNCERTAIN'
                                }
                            },
                            historicalMatches: matchCount,
                            recentMatches: matchDetails,
                            confidence: matchCount >= 20 ? 'HIGH' : matchCount >= 10 ? 'MEDIUM' : 'LOW'
                        };

                    } catch (tickerErr) {
                        console.error(`[Next Day Prediction] Error for ${ticker}:`, tickerErr.message);
                        results[ticker] = { error: tickerErr.message };
                    }
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    scanTime: new Date().toISOString(),
                    tickers: results
                }));

            } catch (err) {
                console.error('[Next Day Prediction] Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Prediction failed', message: err.message }));
            }
        })();
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

    // ===== SNAPTRADE BROKERAGE ENDPOINTS =====

    // Get supported brokerages
    if (url.pathname === '/api/brokerage/supported') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            enabled: !!snaptrade,
            brokerages: SUPPORTED_BROKERAGES
        }));
        return;
    }

    // Get or create SnapTrade user (needed before connecting brokerages)
    if (url.pathname === '/api/brokerage/user' && req.method === 'POST') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        parseBody(req).then(async (body) => {
            const { userId } = body; // Local user identifier

            if (!userId) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Missing userId' }));
                return;
            }

            try {
                // Check if user already exists
                if (snaptradeUsers[userId]) {
                    console.log(`[SnapTrade] Using existing user: ${userId}`);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ success: true, userId, existing: true }));
                    return;
                }

                // Register new user with SnapTrade
                console.log(`[SnapTrade] Registering new user: ${userId}`);
                const response = await snaptrade.authentication.registerSnapTradeUser({
                    userId: userId
                });

                snaptradeUsers[userId] = {
                    snaptradeUserId: response.data.userId,
                    userSecret: response.data.userSecret,
                    createdAt: new Date().toISOString(),
                    accounts: []
                };
                saveSnaptradeUsers();

                console.log(`[SnapTrade] Registered user: ${userId}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: true, userId, existing: false }));
            } catch (err) {
                console.error('[SnapTrade] Register user error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }).catch(err => {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Get connection link for a brokerage
    if (url.pathname === '/api/brokerage/connect' && req.method === 'POST') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        parseBody(req).then(async (body) => {
            const { userId, brokerage } = body;

            if (!userId || !snaptradeUsers[userId]) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'User not registered. Call /api/brokerage/user first.' }));
                return;
            }

            const user = snaptradeUsers[userId];

            try {
                console.log(`[SnapTrade] Getting connect link for ${userId} -> ${brokerage || 'any'}`);

                const linkParams = {
                    userId: user.snaptradeUserId,
                    userSecret: user.userSecret,
                    customRedirect: `http://localhost:${PORT}/api/brokerage/callback`
                };

                // If specific brokerage requested, filter to that
                if (brokerage) {
                    linkParams.broker = brokerage;
                }

                const response = await snaptrade.authentication.loginSnapTradeUser(linkParams);

                console.log(`[SnapTrade] Got connect link for ${userId}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({
                    success: true,
                    redirectUrl: response.data.redirectURI || response.data.loginLink
                }));
            } catch (err) {
                console.error('[SnapTrade] Connect error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }).catch(err => {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // OAuth callback from SnapTrade
    if (url.pathname === '/api/brokerage/callback') {
        // This is where SnapTrade redirects after user authorizes
        // Parse the authorization info from URL params
        const authorizationId = url.searchParams.get('authorizationId');
        const brokerage = url.searchParams.get('brokerage');

        console.log(`[SnapTrade] OAuth callback - auth: ${authorizationId}, brokerage: ${brokerage}`);

        // Redirect to app with success message
        res.writeHead(302, {
            'Location': `/?brokerage_connected=${brokerage || 'success'}&auth_id=${authorizationId || ''}`
        });
        res.end();
        return;
    }

    // Get connected accounts for a user
    if (url.pathname === '/api/brokerage/accounts') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        const userId = url.searchParams.get('userId');
        if (!userId || !snaptradeUsers[userId]) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'User not found' }));
            return;
        }

        const user = snaptradeUsers[userId];

        (async () => {
            try {
                console.log(`[SnapTrade] Fetching accounts for ${userId}`);
                const response = await snaptrade.accountInformation.getAllUserHoldings({
                    userId: user.snaptradeUserId,
                    userSecret: user.userSecret
                });

                // Map accounts to our format
                const accounts = (response.data || []).map(account => {
                    const brokerageInfo = SUPPORTED_BROKERAGES.find(b =>
                        account.brokerage?.slug?.toUpperCase().includes(b.id) ||
                        b.id.includes(account.brokerage?.slug?.toUpperCase() || '')
                    ) || { shortCode: 'OTH', color: '#888888' };

                    return {
                        id: account.account?.id,
                        name: account.account?.name || account.brokerage?.name,
                        brokerage: account.brokerage?.name,
                        brokerageSlug: account.brokerage?.slug,
                        shortCode: brokerageInfo.shortCode,
                        color: brokerageInfo.color,
                        number: account.account?.number,
                        syncStatus: account.account?.sync_status,
                        cash: account.account?.cash,
                        positions: (account.positions || []).map(pos => ({
                            id: pos.symbol?.id,
                            ticker: pos.symbol?.symbol,
                            name: pos.symbol?.description,
                            quantity: pos.units,
                            averageCost: pos.average_purchase_price,
                            currentPrice: pos.price,
                            marketValue: pos.units * (pos.price || 0),
                            pnl: pos.units * ((pos.price || 0) - (pos.average_purchase_price || 0)),
                            pnlPercent: pos.average_purchase_price ?
                                ((pos.price - pos.average_purchase_price) / pos.average_purchase_price * 100) : 0,
                            source: brokerageInfo.shortCode
                        }))
                    };
                });

                // Update cached accounts
                snaptradeUsers[userId].accounts = accounts;
                snaptradeUsers[userId].lastSync = new Date().toISOString();
                saveSnaptradeUsers();

                console.log(`[SnapTrade] Found ${accounts.length} accounts for ${userId}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ accounts }));
            } catch (err) {
                console.error('[SnapTrade] Fetch accounts error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    // Get all positions across all connected accounts
    if (url.pathname === '/api/brokerage/positions') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        const userId = url.searchParams.get('userId');
        if (!userId || !snaptradeUsers[userId]) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'User not found' }));
            return;
        }

        const user = snaptradeUsers[userId];

        (async () => {
            try {
                console.log(`[SnapTrade] Fetching positions for ${userId}`);
                const response = await snaptrade.accountInformation.getAllUserHoldings({
                    userId: user.snaptradeUserId,
                    userSecret: user.userSecret
                });

                // Flatten all positions from all accounts
                const allPositions = [];
                let totalValue = 0;
                let totalPnL = 0;

                for (const account of (response.data || [])) {
                    const brokerageInfo = SUPPORTED_BROKERAGES.find(b =>
                        account.brokerage?.slug?.toUpperCase().includes(b.id) ||
                        b.id.includes(account.brokerage?.slug?.toUpperCase() || '')
                    ) || { shortCode: 'OTH', color: '#888888' };

                    for (const pos of (account.positions || [])) {
                        const marketValue = pos.units * (pos.price || 0);
                        const pnl = pos.units * ((pos.price || 0) - (pos.average_purchase_price || 0));

                        allPositions.push({
                            id: `${account.account?.id}-${pos.symbol?.id}`,
                            ticker: pos.symbol?.symbol,
                            name: pos.symbol?.description,
                            quantity: pos.units,
                            averageCost: pos.average_purchase_price,
                            currentPrice: pos.price,
                            marketValue,
                            pnl,
                            pnlPercent: pos.average_purchase_price ?
                                ((pos.price - pos.average_purchase_price) / pos.average_purchase_price * 100) : 0,
                            source: brokerageInfo.shortCode,
                            sourceColor: brokerageInfo.color,
                            accountId: account.account?.id,
                            accountName: account.account?.name || account.brokerage?.name
                        });

                        totalValue += marketValue;
                        totalPnL += pnl;
                    }
                }

                // Sort by market value descending
                allPositions.sort((a, b) => b.marketValue - a.marketValue);

                console.log(`[SnapTrade] Found ${allPositions.length} positions totaling $${totalValue.toFixed(2)}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({
                    positions: allPositions,
                    totalValue,
                    totalPnL,
                    lastSync: new Date().toISOString()
                }));
            } catch (err) {
                console.error('[SnapTrade] Fetch positions error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    // Get recent trades/activities for auto-journaling
    if (url.pathname === '/api/brokerage/trades') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        const userId = url.searchParams.get('userId');
        const days = parseInt(url.searchParams.get('days') || '7', 10);

        if (!userId || !snaptradeUsers[userId]) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'User not found' }));
            return;
        }

        const user = snaptradeUsers[userId];

        (async () => {
            try {
                console.log(`[SnapTrade] Fetching trades for ${userId} (last ${days} days)`);

                // Get all accounts first
                const holdingsResponse = await snaptrade.accountInformation.getAllUserHoldings({
                    userId: user.snaptradeUserId,
                    userSecret: user.userSecret
                });

                const allTrades = [];
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - days);

                // Fetch activities for each account
                for (const account of (holdingsResponse.data || [])) {
                    if (!account.account?.id) continue;

                    const brokerageInfo = SUPPORTED_BROKERAGES.find(b =>
                        account.brokerage?.slug?.toUpperCase().includes(b.id) ||
                        b.id.includes(account.brokerage?.slug?.toUpperCase() || '')
                    ) || { shortCode: 'OTH', color: '#888888' };

                    try {
                        const activitiesResponse = await snaptrade.transactionsAndReporting.getActivities({
                            userId: user.snaptradeUserId,
                            userSecret: user.userSecret,
                            accountId: account.account.id,
                            startDate: startDate.toISOString().split('T')[0],
                            endDate: new Date().toISOString().split('T')[0]
                        });

                        for (const activity of (activitiesResponse.data || [])) {
                            // Filter to buy/sell trades only
                            if (!['BUY', 'SELL', 'buy', 'sell'].includes(activity.type)) continue;

                            allTrades.push({
                                id: activity.id,
                                ticker: activity.symbol?.symbol,
                                name: activity.symbol?.description,
                                type: activity.type?.toLowerCase(),
                                quantity: activity.units,
                                price: activity.price,
                                amount: activity.amount,
                                date: activity.trade_date || activity.settlement_date,
                                source: brokerageInfo.shortCode,
                                sourceColor: brokerageInfo.color,
                                accountId: account.account?.id,
                                accountName: account.account?.name || account.brokerage?.name,
                                currency: activity.currency?.id
                            });
                        }
                    } catch (actErr) {
                        console.error(`[SnapTrade] Activities error for account ${account.account?.id}:`, actErr.message);
                    }
                }

                // Sort by date descending
                allTrades.sort((a, b) => new Date(b.date) - new Date(a.date));

                console.log(`[SnapTrade] Found ${allTrades.length} trades for ${userId}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ trades: allTrades }));
            } catch (err) {
                console.error('[SnapTrade] Fetch trades error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    // Disconnect a brokerage account
    if (url.pathname === '/api/brokerage/disconnect' && req.method === 'POST') {
        if (!snaptrade) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'SnapTrade not configured' }));
            return;
        }

        parseBody(req).then(async (body) => {
            const { userId, authorizationId } = body;

            if (!userId || !snaptradeUsers[userId]) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'User not found' }));
                return;
            }

            const user = snaptradeUsers[userId];

            try {
                console.log(`[SnapTrade] Disconnecting authorization ${authorizationId} for ${userId}`);

                await snaptrade.connections.removeBrokerageAuthorization({
                    userId: user.snaptradeUserId,
                    userSecret: user.userSecret,
                    authorizationId
                });

                console.log(`[SnapTrade] Disconnected ${authorizationId}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                console.error('[SnapTrade] Disconnect error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }).catch(err => {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: err.message }));
        });
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

    // Start morning IV scan scheduler (6:30am PT)
    startMorningIVScheduler();
});

// ===== BACKGROUND ALERT MONITORING =====
// This runs on the server and sends push notifications even when users' browsers are closed

// Cache for stock prices to reduce API calls
const serverPriceCache = {};
const PRICE_CACHE_TTL = 15000; // 15 seconds

// Fetch stock price (server-side) - uses 1-minute data for real-time accuracy
const fetchStockPrice = (ticker) => {
    return new Promise((resolve) => {
        // Check cache first
        const cached = serverPriceCache[ticker];
        if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_TTL) {
            resolve(cached.price);
            return;
        }

        // Use 1-minute interval for more accurate real-time price
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;

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
                    const result = json.chart?.result?.[0];

                    // Try multiple sources for the price, in order of accuracy
                    let price = result?.meta?.regularMarketPrice;

                    // Fallback: get the most recent close from the chart data
                    if (!price || price < 100) {
                        const closes = result?.indicators?.quote?.[0]?.close;
                        if (closes && closes.length > 0) {
                            // Get the last non-null close price
                            for (let i = closes.length - 1; i >= 0; i--) {
                                if (closes[i] !== null) {
                                    price = closes[i];
                                    break;
                                }
                            }
                        }
                    }

                    if (price && price > 0) {
                        console.log(`[Price] ${ticker}: $${price.toFixed(2)}`);
                        serverPriceCache[ticker] = { price, timestamp: Date.now() };
                        resolve(price);
                    } else {
                        console.log(`[Price] ${ticker}: No valid price found`);
                        resolve(null);
                    }
                } catch (e) {
                    console.log(`[Price] ${ticker}: Parse error - ${e.message}`);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.log(`[Price] ${ticker}: Fetch error - ${e.message}`);
            resolve(null);
        });
    });
};

// Cache for technical indicators (longer TTL since they don't change as fast)
const technicalCache = {};
const TECHNICAL_CACHE_TTL = 60000; // 1 minute

// Fetch historical data for technical analysis
const fetchHistoricalData = (ticker, days = 200) => {
    return new Promise((resolve) => {
        const cacheKey = `${ticker}_history`;
        const cached = technicalCache[cacheKey];
        if (cached && (Date.now() - cached.timestamp) < TECHNICAL_CACHE_TTL) {
            resolve(cached.data);
            return;
        }

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;

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
                    const result = json.chart?.result?.[0];
                    if (result?.indicators?.quote?.[0]?.close) {
                        const closes = result.indicators.quote[0].close.filter(p => p != null);
                        technicalCache[cacheKey] = { data: closes, timestamp: Date.now() };
                        resolve(closes);
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

// Calculate RSI (Relative Strength Index)
const calculateRSI = (prices, period = 14) => {
    if (!prices || prices.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate smoothed RSI for remaining prices
    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

// Calculate Simple Moving Average
const calculateSMA = (prices, period) => {
    if (!prices || prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((sum, p) => sum + p, 0) / period;
};

// Get all technical indicators for a ticker
const getTechnicalIndicators = async (ticker) => {
    const cacheKey = `${ticker}_indicators`;
    const cached = technicalCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < TECHNICAL_CACHE_TTL) {
        return cached.data;
    }

    const prices = await fetchHistoricalData(ticker);
    if (!prices || prices.length < 200) {
        console.log(`[Technical] Not enough data for ${ticker}: ${prices?.length || 0} days`);
        return null;
    }

    const currentPrice = prices[prices.length - 1];
    const rsi = calculateRSI(prices);
    const sma50 = calculateSMA(prices, 50);
    const sma200 = calculateSMA(prices, 200);

    // Calculate previous SMAs for crossover detection
    const prevPrices = prices.slice(0, -1);
    const prevSma50 = calculateSMA(prevPrices, 50);
    const prevSma200 = calculateSMA(prevPrices, 200);

    // Detect Golden Cross (50 crosses above 200) or Death Cross (50 crosses below 200)
    let crossType = null;
    if (prevSma50 && prevSma200 && sma50 && sma200) {
        if (prevSma50 <= prevSma200 && sma50 > sma200) {
            crossType = 'golden';
        } else if (prevSma50 >= prevSma200 && sma50 < sma200) {
            crossType = 'death';
        }
    }

    const indicators = {
        price: currentPrice,
        rsi: rsi ? Math.round(rsi * 100) / 100 : null,
        sma50,
        sma200,
        sma50Distance: sma50 ? ((currentPrice - sma50) / sma50 * 100) : null,
        sma200Distance: sma200 ? ((currentPrice - sma200) / sma200 * 100) : null,
        crossType
    };

    technicalCache[cacheKey] = { data: indicators, timestamp: Date.now() };
    console.log(`[Technical] ${ticker}: RSI=${indicators.rsi}, SMA50 dist=${indicators.sma50Distance?.toFixed(1)}%, SMA200 dist=${indicators.sma200Distance?.toFixed(1)}%`);

    return indicators;
};

// Track which alerts have been triggered (to prevent spam)
const triggeredAlertCache = {};

// Check a single alert against current price or technical indicator
const checkAlert = async (alert, subscription) => {
    const { ticker, type, value } = alert;
    const alertKey = `${subscription.token}-${alert.id}`;

    // Skip if recently triggered (5 minute cooldown)
    if (triggeredAlertCache[alertKey] && (Date.now() - triggeredAlertCache[alertKey]) < 300000) {
        return;
    }

    let shouldTrigger = false;
    let title = '';
    let body = '';
    let notificationData = { type, ticker, alertId: alert.id.toString() };

    // Technical indicator alerts
    const technicalTypes = ['rsi_above', 'rsi_below', 'sma_50', 'sma_200', 'golden_cross', 'death_cross'];

    if (technicalTypes.includes(type)) {
        const indicators = await getTechnicalIndicators(ticker);
        if (!indicators) return;

        switch (type) {
            case 'rsi_above':
                if (indicators.rsi && indicators.rsi >= value) {
                    shouldTrigger = true;
                    title = `📈 ${ticker} RSI Overbought!`;
                    body = `RSI: ${indicators.rsi.toFixed(1)} (above ${value}) - Consider taking profits`;
                    notificationData.rsi = indicators.rsi.toString();
                }
                break;
            case 'rsi_below':
                if (indicators.rsi && indicators.rsi <= value) {
                    shouldTrigger = true;
                    title = `📉 ${ticker} RSI Oversold!`;
                    body = `RSI: ${indicators.rsi.toFixed(1)} (below ${value}) - Potential buying opportunity`;
                    notificationData.rsi = indicators.rsi.toString();
                }
                break;
            case 'sma_50':
                // value = percentage distance threshold (e.g., 2 means within 2%)
                if (indicators.sma50Distance !== null && Math.abs(indicators.sma50Distance) <= value) {
                    shouldTrigger = true;
                    const aboveBelow = indicators.sma50Distance >= 0 ? 'above' : 'below';
                    title = `📊 ${ticker} Near 50 SMA!`;
                    body = `Price $${indicators.price.toFixed(2)} is ${Math.abs(indicators.sma50Distance).toFixed(1)}% ${aboveBelow} 50 SMA ($${indicators.sma50.toFixed(2)})`;
                    notificationData.price = indicators.price.toString();
                }
                break;
            case 'sma_200':
                // value = percentage distance threshold (e.g., 2 means within 2%)
                if (indicators.sma200Distance !== null && Math.abs(indicators.sma200Distance) <= value) {
                    shouldTrigger = true;
                    const aboveBelow = indicators.sma200Distance >= 0 ? 'above' : 'below';
                    title = `📊 ${ticker} Near 200 SMA!`;
                    body = `Price $${indicators.price.toFixed(2)} is ${Math.abs(indicators.sma200Distance).toFixed(1)}% ${aboveBelow} 200 SMA ($${indicators.sma200.toFixed(2)})`;
                    notificationData.price = indicators.price.toString();
                }
                break;
            case 'golden_cross':
                if (indicators.crossType === 'golden') {
                    shouldTrigger = true;
                    title = `⚡ ${ticker} GOLDEN CROSS!`;
                    body = `50 SMA crossed ABOVE 200 SMA - Major bullish signal!`;
                }
                break;
            case 'death_cross':
                if (indicators.crossType === 'death') {
                    shouldTrigger = true;
                    title = `💀 ${ticker} DEATH CROSS!`;
                    body = `50 SMA crossed BELOW 200 SMA - Major bearish signal!`;
                }
                break;
        }
    } else {
        // Price-based alerts
        const price = await fetchStockPrice(ticker);
        if (!price) return;
        notificationData.price = price.toString();

        switch (type) {
            case 'price_above':
                if (price >= value) {
                    shouldTrigger = true;
                    title = `🎯 ${ticker} Hit Target!`;
                    body = `Price: $${price.toFixed(2)} (above $${value})`;
                }
                break;
            case 'price_below':
                if (price <= value) {
                    shouldTrigger = true;
                    title = `⚠️ ${ticker} Alert!`;
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
    }

    if (shouldTrigger) {
        console.log(`[Alert Monitor] Triggering alert: ${title}`);
        const sent = await sendPushNotification(subscription.token, title, body, notificationData);

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

// ===== MORNING IV SCAN (6:30am PT / 9:30am ET) =====
// Auto-scans IV conditions and sends push notification at market open

const runMorningIVScan = async () => {
    console.log('[Morning IV Scan] Running scheduled scan...');

    if (pushSubscriptions.length === 0) {
        console.log('[Morning IV Scan] No push subscriptions, skipping');
        return;
    }

    try {
        // Fetch IV data for SPY, QQQ, IWM
        const tickers = ['SPY', 'QQQ', 'IWM'];

        // Helper to fetch price history
        const fetchYahooChart = (ticker, range = '5d', interval = '1d') => {
            return new Promise((resolve, reject) => {
                const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
                https.get(yahooUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                }, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error('Failed to parse data'));
                        }
                    });
                }).on('error', reject);
            });
        };

        // Get VIX data
        const vixData = await fetchYahooChart('^VIX', '5d', '1d');
        let vixTrend = 'FLAT';
        let vixCurrent = null;

        if (vixData?.chart?.result?.[0]) {
            const closes = vixData.chart.result[0].indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
            if (closes.length >= 2) {
                vixCurrent = closes[closes.length - 1];
                const prevVix = closes[closes.length - 2];
                const vixChange = ((vixCurrent - prevVix) / prevVix) * 100;
                vixTrend = vixChange > 3 ? 'RISING' : vixChange < -3 ? 'FALLING' : 'FLAT';
            }
        }

        // Get SPY pre-market direction
        const spyDaily = await fetchYahooChart('SPY', '5d', '1d');
        const spyIntraday = await fetchYahooChart('SPY', '1d', '1m');
        let preMarketDirection = 'FLAT';
        let preMarketChange = 0;

        if (spyDaily?.chart?.result?.[0] && spyIntraday?.chart?.result?.[0]) {
            const dailyCloses = spyDaily.chart.result[0].indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
            const intradayCloses = spyIntraday.chart.result[0].indicators?.quote?.[0]?.close?.filter(c => c != null) || [];

            if (dailyCloses.length >= 2 && intradayCloses.length > 0) {
                const prevClose = dailyCloses[dailyCloses.length - 2];
                const currentPrice = intradayCloses[intradayCloses.length - 1];
                preMarketChange = ((currentPrice - prevClose) / prevClose) * 100;
                preMarketDirection = preMarketChange > 0.2 ? 'GREEN' : preMarketChange < -0.2 ? 'RED' : 'FLAT';
            }
        }

        // Determine direction call
        let bullishScore = 0;
        let bearishScore = 0;

        if (vixTrend === 'FALLING') bullishScore += 2;
        if (vixTrend === 'RISING') bearishScore += 2;
        if (preMarketDirection === 'GREEN') bullishScore += 2;
        if (preMarketDirection === 'RED') bearishScore += 2;

        const directionScore = bullishScore - bearishScore;
        let direction = 'NEUTRAL';
        if (directionScore >= 3) direction = 'CALLS';
        else if (directionScore >= 1) direction = 'LEAN CALLS';
        else if (directionScore <= -3) direction = 'PUTS';
        else if (directionScore <= -1) direction = 'LEAN PUTS';

        // Build notification message
        const directionEmoji = direction.includes('CALLS') ? '📞' : direction.includes('PUTS') ? '🔻' : '⚖️';
        const vixEmoji = vixTrend === 'FALLING' ? '📉' : vixTrend === 'RISING' ? '📈' : '➖';
        const pmEmoji = preMarketDirection === 'GREEN' ? '🟢' : preMarketDirection === 'RED' ? '🔴' : '⚪';

        const title = `${directionEmoji} Morning IV: ${direction}`;
        const body = `VIX ${vixEmoji} ${vixTrend} (${vixCurrent?.toFixed(1)}) | SPY ${pmEmoji} ${preMarketChange >= 0 ? '+' : ''}${preMarketChange.toFixed(2)}%`;

        console.log(`[Morning IV Scan] ${title} - ${body}`);

        // Send push notification to all subscribers
        for (const subscription of pushSubscriptions) {
            await sendPushNotification(subscription.token, title, body, {
                type: 'morning_iv_scan',
                direction,
                vixTrend,
                preMarketDirection
            });
        }

        console.log(`[Morning IV Scan] Sent to ${pushSubscriptions.length} subscribers`);

    } catch (err) {
        console.error('[Morning IV Scan] Error:', err.message);
    }
};

// Schedule morning IV scan
const startMorningIVScheduler = () => {
    console.log('[Morning IV Scan] Scheduler started - will scan at 6:30am PT / 9:30am ET');

    // Check every minute if it's time for the scan
    setInterval(() => {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const dayOfWeek = now.getDay();

        // Skip weekends
        if (dayOfWeek === 0 || dayOfWeek === 6) return;

        // 6:30am PT = 9:30am ET (adjust for your timezone)
        // Server runs in local time, so use 6:30 for PT or 9:30 for ET
        // Using 6:30 assuming PT
        if (hours === 6 && minutes === 30) {
            runMorningIVScan();
        }

        // Also scan at 6:35am and 6:40am for redundancy
        if (hours === 6 && (minutes === 35 || minutes === 40)) {
            // Only run if we haven't scanned in the last 4 minutes
            // (prevents duplicate notifications)
        }
    }, 60000); // Check every minute
};

// Manual trigger endpoint for testing
// Add this before server.listen if needed
