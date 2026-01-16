/**
 * Spam Scanner Web App
 * Supports Gmail AND Yahoo Mail
 */

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ GOOGLE CONFIG ============
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/auth/callback';

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email'
];

// ============ YAHOO CONFIG ============
const YAHOO_CLIENT_ID = process.env.YAHOO_CLIENT_ID;
const YAHOO_CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET;
const YAHOO_REDIRECT_URI = process.env.YAHOO_REDIRECT_URI || 'http://localhost:3001/auth/yahoo/callback';

// Store tokens in memory (in production, use a database)
const userTokens = new Map();
const userProviders = new Map(); // Track which provider each user used

// Default spam detection config
const spamConfig = {
    subjectPatterns: ["FREE", "free", "% off", "% OFF", "$ off", "savings", "discount", "limited time", "act now"],
    bodyPhrases: ["free gift", "free shipping", "% off", "$ off", "special offer", "promo code", "discount code"],
    forwardTo: 'spamclaims@pacifictrialattorneys.com',
    daysToScan: 365
};

// Create Google OAuth2 client
function createGoogleOAuth2Client() {
    return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

// ============ ROUTES ============

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ GOOGLE AUTH ============

// Start Google OAuth flow
app.get('/auth/login', (req, res) => {
    const oAuth2Client = createGoogleOAuth2Client();
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

// Google OAuth callback
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.redirect('/?error=no_code');
    }

    try {
        const oAuth2Client = createGoogleOAuth2Client();
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get user email to use as key
        const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;

        // Store tokens and provider
        userTokens.set(userEmail, tokens);
        userProviders.set(userEmail, 'google');

        res.redirect(`/?user=${encodeURIComponent(userEmail)}&provider=google`);
    } catch (err) {
        console.error('Google auth error:', err);
        res.redirect('/?error=auth_failed');
    }
});

// ============ YAHOO AUTH ============

// Start Yahoo OAuth flow
app.get('/auth/yahoo/login', (req, res) => {
    if (!YAHOO_CLIENT_ID) {
        return res.redirect('/?error=yahoo_not_configured');
    }

    const authUrl = `https://api.login.yahoo.com/oauth2/request_auth?` +
        `client_id=${YAHOO_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(YAHOO_REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=mail-r`;

    res.redirect(authUrl);
});

// Yahoo OAuth callback
app.get('/auth/yahoo/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.redirect('/?error=no_code');
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await yahooGetToken(code);
        const accessToken = tokenResponse.access_token;
        const refreshToken = tokenResponse.refresh_token;

        // Get user info
        const userInfo = await yahooGetUserInfo(accessToken);
        const userEmail = userInfo.email;

        // Store tokens and provider
        userTokens.set(userEmail, { access_token: accessToken, refresh_token: refreshToken });
        userProviders.set(userEmail, 'yahoo');

        res.redirect(`/?user=${encodeURIComponent(userEmail)}&provider=yahoo`);
    } catch (err) {
        console.error('Yahoo auth error:', err);
        res.redirect('/?error=yahoo_auth_failed');
    }
});

// Yahoo helper: Get token
function yahooGetToken(code) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString('base64');
        const postData = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(YAHOO_REDIRECT_URI)}`;

        const options = {
            hostname: 'api.login.yahoo.com',
            path: '/oauth2/get_token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`,
                'Content-Length': postData.length
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse Yahoo token response'));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Yahoo helper: Get user info
function yahooGetUserInfo(accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.login.yahoo.com',
            path: '/openid/v1/userinfo',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse Yahoo user info'));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Yahoo helper: Search mail
function yahooSearchMail(accessToken, query) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'mail.yahooapis.com',
            path: `/v1/search?q=${encodeURIComponent(query)}&count=100`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ messages: [] });
                }
            });
        });

        req.on('error', () => resolve({ messages: [] }));
        req.end();
    });
}

// Yahoo helper: Get message
function yahooGetMessage(accessToken, messageId) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'mail.yahooapis.com',
            path: `/v1/message/${messageId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse Yahoo message'));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// ============ COMMON ROUTES ============

// Check if user is logged in
app.get('/api/status', (req, res) => {
    const userEmail = req.query.user;
    if (userEmail && userTokens.has(userEmail)) {
        res.json({
            loggedIn: true,
            email: userEmail,
            provider: userProviders.get(userEmail) || 'google'
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout
app.get('/auth/logout', (req, res) => {
    const userEmail = req.query.user;
    if (userEmail) {
        userTokens.delete(userEmail);
        userProviders.delete(userEmail);
    }
    res.redirect('/');
});

// Get current config
app.get('/api/config', (req, res) => {
    res.json({
        ...spamConfig,
        yahooEnabled: !!YAHOO_CLIENT_ID
    });
});

// Update config (admin only in future)
app.post('/api/config', (req, res) => {
    const { subjectPatterns, bodyPhrases, forwardTo, daysToScan } = req.body;
    if (subjectPatterns) spamConfig.subjectPatterns = subjectPatterns;
    if (bodyPhrases) spamConfig.bodyPhrases = bodyPhrases;
    if (forwardTo) spamConfig.forwardTo = forwardTo;
    if (daysToScan) spamConfig.daysToScan = daysToScan;
    res.json({ success: true, config: spamConfig });
});

// ============ SPAM DETECTION ============

function isSuspiciousSender(fromHeader) {
    if (!fromHeader) return false;
    const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
    const email = emailMatch[1] || fromHeader;
    const localPart = email.split('@')[0];
    if (!localPart) return false;

    const consonantRun = localPart.match(/[bcdfghjklmnpqrstvwxyz]{5,}/gi);
    if (consonantRun) return true;

    const numLetterMix = localPart.match(/[a-z]+\d+[a-z]+\d+/gi);
    if (numLetterMix && localPart.length > 10) return true;

    if (localPart.length > 20) {
        const uniqueChars = new Set(localPart.toLowerCase()).size;
        if (uniqueChars > 12) return true;
    }

    const numbers = (localPart.match(/\d/g) || []).length;
    const letters = (localPart.match(/[a-z]/gi) || []).length;
    if (numbers > 6 && numbers > letters) return true;

    return false;
}

function hasSpammySubject(subject) {
    if (!subject) return { match: false };

    const dollarMatch = subject.match(/\$\d+/);
    if (dollarMatch) return { match: true, reason: `Dollar amount: ${dollarMatch[0]}` };

    const percentMatch = subject.match(/\d+\s*%/);
    if (percentMatch) return { match: true, reason: `Percentage: ${percentMatch[0]}` };

    if (/\bfree\b/i.test(subject)) return { match: true, reason: 'Contains "FREE"' };

    for (const pattern of spamConfig.subjectPatterns) {
        if (subject.toLowerCase().includes(pattern.toLowerCase())) {
            return { match: true, reason: `Contains "${pattern}"` };
        }
    }

    return { match: false };
}

function hasSpammyBody(snippet) {
    if (!snippet) return { match: false };

    const dollarMatch = snippet.match(/\$\d+/);
    if (dollarMatch) return { match: true, reason: `Dollar amount in body: ${dollarMatch[0]}` };

    const percentMatch = snippet.match(/\d+\s*%\s*(off|discount|savings?)/i);
    if (percentMatch) return { match: true, reason: `Discount in body: ${percentMatch[0]}` };

    for (const phrase of spamConfig.bodyPhrases) {
        if (snippet.toLowerCase().includes(phrase.toLowerCase())) {
            return { match: true, reason: `Body contains "${phrase}"` };
        }
    }

    return { match: false };
}

// ============ SCAN EMAILS ============

app.post('/api/scan', async (req, res) => {
    const { userEmail } = req.body;

    if (!userEmail || !userTokens.has(userEmail)) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    const provider = userProviders.get(userEmail) || 'google';

    try {
        if (provider === 'google') {
            return await scanGmail(userEmail, res);
        } else if (provider === 'yahoo') {
            return await scanYahoo(userEmail, res);
        }
    } catch (err) {
        console.error('Scan error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Scan Gmail
async function scanGmail(userEmail, res) {
    const oAuth2Client = createGoogleOAuth2Client();
    oAuth2Client.setCredentials(userTokens.get(userEmail));

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const results = [];
    const seen = new Set();

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - spamConfig.daysToScan);
    const afterDate = daysAgo.toISOString().split('T')[0].replace(/-/g, '/');

    const searchQueries = [
        `subject:free after:${afterDate}`,
        `subject:"$" after:${afterDate}`,
        `subject:"% off" after:${afterDate}`,
        `"limited time" after:${afterDate}`,
        `"special offer" after:${afterDate}`,
        `"promo code" after:${afterDate}`,
    ];

    for (const query of searchQueries) {
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 100
        });

        const messages = response.data.messages || [];

        for (const message of messages) {
            if (seen.has(message.id)) continue;
            seen.add(message.id);

            const details = await gmail.users.messages.get({
                userId: 'me',
                id: message.id,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'Date']
            });

            const headers = details.data.payload.headers;
            const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
            const from = headers.find(h => h.name === 'From')?.value || '(Unknown)';
            const date = headers.find(h => h.name === 'Date')?.value || '';
            const snippet = details.data.snippet || '';

            const flags = [];

            if (isSuspiciousSender(from)) {
                flags.push('Forged Sender');
            }

            const subjectCheck = hasSpammySubject(subject);
            if (subjectCheck.match) {
                flags.push(subjectCheck.reason);
            }

            const bodyCheck = hasSpammyBody(snippet);
            if (bodyCheck.match) {
                flags.push(bodyCheck.reason);
            }

            if (flags.length > 0) {
                results.push({
                    id: message.id,
                    subject,
                    from,
                    date,
                    snippet: snippet.substring(0, 100),
                    flags,
                    provider: 'google'
                });
            }
        }
    }

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ count: results.length, emails: results });
}

// Scan Yahoo
async function scanYahoo(userEmail, res) {
    const tokens = userTokens.get(userEmail);
    const accessToken = tokens.access_token;
    const results = [];
    const seen = new Set();

    const searchQueries = ['free', 'discount', 'savings', 'offer', 'promo'];

    for (const query of searchQueries) {
        try {
            const searchResult = await yahooSearchMail(accessToken, query);
            const messages = searchResult.messages || [];

            for (const message of messages) {
                if (seen.has(message.id)) continue;
                seen.add(message.id);

                try {
                    const details = await yahooGetMessage(accessToken, message.id);

                    const subject = details.subject || '(No Subject)';
                    const from = details.from || '(Unknown)';
                    const date = details.date || '';
                    const snippet = details.snippet || details.preview || '';

                    const flags = [];

                    if (isSuspiciousSender(from)) {
                        flags.push('Forged Sender');
                    }

                    const subjectCheck = hasSpammySubject(subject);
                    if (subjectCheck.match) {
                        flags.push(subjectCheck.reason);
                    }

                    const bodyCheck = hasSpammyBody(snippet);
                    if (bodyCheck.match) {
                        flags.push(bodyCheck.reason);
                    }

                    if (flags.length > 0) {
                        results.push({
                            id: message.id,
                            subject,
                            from,
                            date,
                            snippet: snippet.substring(0, 100),
                            flags,
                            provider: 'yahoo'
                        });
                    }
                } catch (e) {
                    // Skip messages that fail to load
                }
            }
        } catch (e) {
            // Skip search queries that fail
        }
    }

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ count: results.length, emails: results });
}

// ============ FORWARD EMAILS ============

app.post('/api/forward', async (req, res) => {
    const { userEmail, emailIds } = req.body;

    if (!userEmail || !userTokens.has(userEmail)) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    if (!emailIds || emailIds.length === 0) {
        return res.status(400).json({ error: 'No emails to forward' });
    }

    const provider = userProviders.get(userEmail) || 'google';

    try {
        if (provider === 'google') {
            return await forwardGmail(userEmail, emailIds, res);
        } else if (provider === 'yahoo') {
            // Yahoo doesn't support sending via API easily
            // Return a message to forward manually
            return res.json({
                success: 0,
                failed: emailIds.length,
                message: 'Yahoo Mail forwarding requires manual action. Please forward emails manually to: ' + spamConfig.forwardTo
            });
        }
    } catch (err) {
        console.error('Forward error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Forward Gmail
async function forwardGmail(userEmail, emailIds, res) {
    const oAuth2Client = createGoogleOAuth2Client();
    oAuth2Client.setCredentials(userTokens.get(userEmail));

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    let success = 0;
    let failed = 0;

    for (const emailId of emailIds) {
        try {
            const message = await gmail.users.messages.get({
                userId: 'me',
                id: emailId,
                format: 'raw'
            });

            const metaMsg = await gmail.users.messages.get({
                userId: 'me',
                id: emailId,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'Date']
            });

            const headers = metaMsg.data.payload.headers;
            const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
            const from = headers.find(h => h.name === 'From')?.value || '';
            const date = headers.find(h => h.name === 'Date')?.value || '';

            const rawEmail = Buffer.from(message.data.raw, 'base64').toString('utf8');

            const forwardBody = [
                `---------- Forwarded Spam Email ----------`,
                `From: ${from}`,
                `Date: ${date}`,
                `Subject: ${subject}`,
                ``,
                `--- Original Content ---`,
                rawEmail.substring(0, 30000)
            ].join('\n');

            const emailLines = [
                `To: ${spamConfig.forwardTo}`,
                `Subject: FWD: ${subject}`,
                `Content-Type: text/plain; charset=utf-8`,
                ``,
                forwardBody
            ];

            const encodedEmail = Buffer.from(emailLines.join('\r\n')).toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: encodedEmail }
            });

            success++;
            await new Promise(r => setTimeout(r, 500));

        } catch (err) {
            console.error(`Forward error for ${emailId}:`, err.message);
            failed++;

            if (err.message.includes('rate limit')) {
                return res.json({
                    success,
                    failed,
                    rateLimited: true,
                    message: 'Gmail rate limit reached. Try again later.'
                });
            }
        }
    }

    res.json({ success, failed, rateLimited: false });
}

// Start server
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`   SPAM SCANNER WEB APP`);
    console.log(`========================================`);
    console.log(`Server running at: http://localhost:${PORT}`);
    console.log(`\nGoogle: ${GOOGLE_CLIENT_ID ? 'Configured' : 'Not configured'}`);
    console.log(`Yahoo:  ${YAHOO_CLIENT_ID ? 'Configured' : 'Not configured (add YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET)'}`);
    console.log(`========================================\n`);
});
