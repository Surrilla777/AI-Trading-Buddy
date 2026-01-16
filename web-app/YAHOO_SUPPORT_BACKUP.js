/**
 * YAHOO MAIL SUPPORT - SAVED FOR FUTURE USE
 * Add this code back to server.js when Yahoo support is needed
 *
 * Requirements:
 * - YAHOO_CLIENT_ID environment variable
 * - YAHOO_CLIENT_SECRET environment variable
 * - YAHOO_REDIRECT_URI environment variable (default: http://localhost:3001/auth/yahoo/callback)
 */

// ============ YAHOO CONFIG (add to top of server.js) ============
const YAHOO_CLIENT_ID = process.env.YAHOO_CLIENT_ID;
const YAHOO_CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET;
const YAHOO_REDIRECT_URI = process.env.YAHOO_REDIRECT_URI || 'http://localhost:3001/auth/yahoo/callback';

// Add this map to track providers (add after userTokens map)
const userProviders = new Map(); // Track which provider each user used


// ============ YAHOO AUTH ROUTES ============

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


// ============ YAHOO HELPER FUNCTIONS ============

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


// ============ YAHOO SCAN FUNCTION ============

// Scan Yahoo (call this from /api/scan when provider === 'yahoo')
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


// ============ UI CHANGES (for index.html) ============
/*
Add Yahoo login button next to Google button:

<a href="/auth/yahoo/login" class="btn btn-yahoo" style="background: #6001d2; color: #fff;">
    Sign in with Yahoo Mail
</a>

Add provider tracking in JavaScript:
- Track currentProvider variable
- Show provider indicator: (Gmail) or (Yahoo)
- For Yahoo users, show manual forward message since Yahoo API doesn't support sending
*/


// ============ NOTES ============
/*
IMPORTANT: Yahoo Mail API Limitations:
- Can READ emails (mail-r scope)
- CANNOT SEND emails via API
- Users must manually forward emails

To enable Yahoo:
1. Create Yahoo Developer App at https://developer.yahoo.com/
2. Get Client ID and Client Secret
3. Add to environment variables:
   - YAHOO_CLIENT_ID
   - YAHOO_CLIENT_SECRET
   - YAHOO_REDIRECT_URI (for production)
*/
