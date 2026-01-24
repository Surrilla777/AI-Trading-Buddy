/**
 * Spam Scanner Web App
 * A simple web interface for scanning Gmail and forwarding spam
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// OAuth2 config - set in .env file (local) or Render dashboard (hosted)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/auth/callback';

// Scopes needed
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email'
];

// Store tokens in memory (in production, use a database)
const userTokens = new Map();

// Default spam detection config
const spamConfig = {
    subjectPatterns: ["FREE", "free", "% off", "% OFF", "$ off", "savings", "discount", "limited time", "act now"],
    bodyPhrases: ["free gift", "free shipping", "% off", "$ off", "special offer", "promo code", "discount code"],
    forwardTo: 'spamclaims@pacifictrialattorneys.com',
    daysToScan: 365
};

// Create OAuth2 client
function createOAuth2Client() {
    return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

// ============ ROUTES ============

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start OAuth flow
app.get('/auth/login', (req, res) => {
    const oAuth2Client = createOAuth2Client();
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.redirect('/?error=no_code');
    }

    try {
        const oAuth2Client = createOAuth2Client();
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get user email to use as key
        const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;

        // Store tokens
        userTokens.set(userEmail, tokens);

        res.redirect(`/?user=${encodeURIComponent(userEmail)}`);
    } catch (err) {
        console.error('Auth error:', err);
        res.redirect('/?error=auth_failed');
    }
});

// Check if user is logged in
app.get('/api/status', (req, res) => {
    const userEmail = req.query.user;
    if (userEmail && userTokens.has(userEmail)) {
        res.json({ loggedIn: true, email: userEmail });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout
app.get('/auth/logout', (req, res) => {
    const userEmail = req.query.user;
    if (userEmail) {
        userTokens.delete(userEmail);
    }
    res.redirect('/');
});

// Get current config
app.get('/api/config', (req, res) => {
    res.json(spamConfig);
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

// Check if sender address looks suspicious
function isSuspiciousSender(fromHeader) {
    if (!fromHeader) return false;
    const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
    const email = emailMatch[1] || fromHeader;
    const localPart = email.split('@')[0];
    if (!localPart) return false;

    // Check for random-looking patterns
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

// Check subject for PROMOTIONAL SPAM (not just any $ or %)
function hasSpammySubject(subject) {
    if (!subject) return { match: false };

    // DOLLAR DISCOUNT OFFERS like "$50 off", "save $20" - NOT just any $
    const dollarDiscountMatch = subject.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };

    // PERCENTAGE DISCOUNT OFFERS like "50% off" - NOT just any %
    const percentDiscountMatch = subject.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };

    // FREE OFFERS - things being offered for free
    const freeOfferMatch = subject.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download|ebook|guide|consultation)|get\s+\w+\s+free|buy\s+\w+\s+get\s+\w+\s+free|\bfree\b.*\boffer\b/i);
    if (freeOfferMatch) return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };

    // PROMOTIONAL SPAM WORDS
    const promoMatch = subject.match(/(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i);
    if (promoMatch) return { match: true, reason: `Promo language: ${promoMatch[0]}` };

    for (const pattern of spamConfig.subjectPatterns) {
        if (subject.toLowerCase().includes(pattern.toLowerCase())) {
            return { match: true, reason: `Contains "${pattern}"` };
        }
    }

    return { match: false };
}

// Check body for PROMOTIONAL SPAM (not just any $ or %)
function hasSpammyBody(snippet) {
    if (!snippet) return { match: false };

    // DOLLAR DISCOUNT OFFERS - NOT just any dollar amount
    const dollarDiscountMatch = snippet.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };

    // PERCENTAGE DISCOUNT OFFERS
    const percentDiscountMatch = snippet.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };

    // FREE OFFERS
    const freeOfferMatch = snippet.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download)|get\s+\w+\s+free|\bfree\b.*\boffer\b/i);
    if (freeOfferMatch) return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };

    // PROMOTIONAL SPAM WORDS
    const promoMatch = snippet.match(/(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i);
    if (promoMatch) return { match: true, reason: `Promo language: ${promoMatch[0]}` };

    for (const phrase of spamConfig.bodyPhrases) {
        if (snippet.toLowerCase().includes(phrase.toLowerCase())) {
            return { match: true, reason: `Body contains "${phrase}"` };
        }
    }

    return { match: false };
}

// Scan emails
app.post('/api/scan', async (req, res) => {
    const { userEmail } = req.body;

    if (!userEmail || !userTokens.has(userEmail)) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    try {
        const oAuth2Client = createOAuth2Client();
        oAuth2Client.setCredentials(userTokens.get(userEmail));

        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
        const results = [];
        const seen = new Set();

        // Calculate date range
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - spamConfig.daysToScan);
        const afterDate = daysAgo.toISOString().split('T')[0].replace(/-/g, '/');

        // Search queries
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
                        flags
                    });
                }
            }
        }

        // Sort by date
        results.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({
            count: results.length,
            emails: results
        });

    } catch (err) {
        console.error('Scan error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============ EMAIL PARSING FUNCTIONS ============

/**
 * Extract readable text from email parts (handles multipart MIME)
 */
function extractTextFromParts(parts) {
    let text = '';
    if (!parts) return text;

    for (const part of parts) {
        if (part.parts) {
            text += extractTextFromParts(part.parts);
        }
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
            text += decoded + '\n';
        } else if (part.mimeType === 'text/html' && part.body && part.body.data && !text) {
            const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
            const stripped = decoded
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim();
            text += stripped + '\n';
        }
    }
    return text;
}

/**
 * Get readable email body from a Gmail message payload
 */
function getReadableBody(payload) {
    if (payload.body && payload.body.data) {
        const decoded = Buffer.from(payload.body.data, 'base64').toString('utf8');
        if (payload.mimeType === 'text/plain') {
            return decoded;
        } else if (payload.mimeType === 'text/html') {
            return decoded
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim();
        }
    }
    if (payload.parts) {
        return extractTextFromParts(payload.parts);
    }
    return '(Could not extract email body)';
}

// Forward emails
app.post('/api/forward', async (req, res) => {
    const { userEmail, emailIds } = req.body;

    if (!userEmail || !userTokens.has(userEmail)) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    if (!emailIds || emailIds.length === 0) {
        return res.status(400).json({ error: 'No emails to forward' });
    }

    try {
        const oAuth2Client = createOAuth2Client();
        oAuth2Client.setCredentials(userTokens.get(userEmail));

        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

        let success = 0;
        let failed = 0;

        for (const emailId of emailIds) {
            try {
                // Get the email in FULL format to properly parse content
                const message = await gmail.users.messages.get({
                    userId: 'me',
                    id: emailId,
                    format: 'full'
                });

                const headers = message.data.payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name === 'From')?.value || '';
                const date = headers.find(h => h.name === 'Date')?.value || '';

                // Extract readable text (NOT raw MIME data)
                const readableBody = getReadableBody(message.data.payload);

                // Create forward message with READABLE content
                const forwardBody = [
                    `---------- Forwarded Spam Email ----------`,
                    `From: ${from}`,
                    `Date: ${date}`,
                    `Subject: ${subject}`,
                    ``,
                    `--- Original Content ---`,
                    readableBody.substring(0, 30000)
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

                // Rate limit delay
                await new Promise(r => setTimeout(r, 500));

            } catch (err) {
                console.error(`Forward error for ${emailId}:`, err.message);
                failed++;

                // If rate limited, stop
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

    } catch (err) {
        console.error('Forward error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`   SPAM SCANNER WEB APP`);
    console.log(`========================================`);
    console.log(`Server running at: http://localhost:${PORT}`);
    console.log(`\nMake sure to set environment variables:`);
    console.log(`  GOOGLE_CLIENT_ID`);
    console.log(`  GOOGLE_CLIENT_SECRET`);
    console.log(`  REDIRECT_URI (for production)`);
    console.log(`========================================\n`);
});
