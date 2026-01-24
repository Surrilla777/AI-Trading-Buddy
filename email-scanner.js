/**
 * Gmail Spam Scanner
 * Detects suspicious emails:
 * - Forged headers (random jumbled sender addresses)
 * - Subject lines with FREE, $ savings, % savings
 * - Body content with discount/free offers
 *
 * Usage: node email-scanner.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

// OAuth2 scopes - read-only access to Gmail
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');
const CONFIG_PATH = path.join(__dirname, 'spam-phrases.json');

// Load config
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error('Error: spam-phrases.json not found!');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Check if sender address looks like random gibberish
function isSuspiciousSender(fromHeader) {
    if (!fromHeader) return false;

    // Extract email address from "Name <email@domain.com>" format
    const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
    const email = emailMatch[1] || fromHeader;

    // Get the local part (before @)
    const localPart = email.split('@')[0];
    if (!localPart) return false;

    // Check for signs of random/forged addresses:

    // 1. Long strings of consonants (no vowels) - looks random
    const consonantRun = localPart.match(/[bcdfghjklmnpqrstvwxyz]{5,}/gi);
    if (consonantRun) return true;

    // 2. Too many numbers mixed with letters randomly
    const numLetterMix = localPart.match(/[a-z]+\d+[a-z]+\d+/gi);
    if (numLetterMix && localPart.length > 10) return true;

    // 3. Very long local part with lots of random chars
    if (localPart.length > 20) {
        // Check entropy - lots of different characters
        const uniqueChars = new Set(localPart.toLowerCase()).size;
        if (uniqueChars > 12) return true;
    }

    // 4. Mostly numbers with few letters
    const numbers = (localPart.match(/\d/g) || []).length;
    const letters = (localPart.match(/[a-z]/gi) || []).length;
    if (numbers > 6 && numbers > letters) return true;

    // 5. Random-looking patterns like "xkcd7fgh3"
    if (/^[a-z]{2,4}\d+[a-z]{2,4}\d*$/i.test(localPart)) return true;

    return false;
}

// Check if subject has DISCOUNT/PROMOTIONAL OFFERS
function hasSpammySubject(subject, patterns) {
    if (!subject) return { match: false };

    const subjectLower = subject.toLowerCase();

    // Check for DOLLAR DISCOUNT OFFERS like "$50 off", "save $20", "$100 discount"
    // NOT just any dollar amount (that catches Robinhood trades)
    const dollarDiscountMatch = subject.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) {
        return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };
    }

    // Check for PERCENTAGE DISCOUNT OFFERS like "50% off", "20% discount", "save 30%"
    // NOT just any percentage
    const percentDiscountMatch = subject.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) {
        return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };
    }

    // Check for FREE OFFERS - things being offered for free (not "freedom", "freelance", etc.)
    const freeOfferMatch = subject.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download|ebook|guide|consultation)|get\s+\w+\s+free\b|buy\s+\w+\s+get\s+\w+\s+free\b|\bfree\b[^a-z].*\boffer\b/i);
    if (freeOfferMatch) {
        return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };
    }

    // Check for PROMOTIONAL SPAM WORDS
    const promoWords = /(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i;
    const promoMatch = subject.match(promoWords);
    if (promoMatch) {
        return { match: true, reason: `Promo language: ${promoMatch[0]}` };
    }

    // Check other patterns from config
    for (const pattern of patterns) {
        if (subjectLower.includes(pattern.toLowerCase())) {
            return { match: true, reason: `Contains "${pattern}"` };
        }
    }

    return { match: false };
}

// Check if body has DISCOUNT/PROMOTIONAL OFFERS (not just any $ or %)
function hasSpammyBody(snippet, bodyPhrases) {
    if (!snippet) return { match: false };

    const snippetLower = snippet.toLowerCase();

    // Check for DOLLAR DISCOUNT OFFERS like "$50 off", "save $20"
    // NOT just any dollar amount
    const dollarDiscountMatch = snippet.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) {
        return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };
    }

    // Check for PERCENTAGE DISCOUNT OFFERS
    const percentDiscountMatch = snippet.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) {
        return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };
    }

    // Check for FREE OFFERS
    const freeOfferMatch = snippet.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download)|get\s+\w+\s+free|\bfree\b.*\boffer\b/i);
    if (freeOfferMatch) {
        return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };
    }

    // Check for PROMOTIONAL SPAM WORDS
    const promoWords = /(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i;
    const promoMatch = snippet.match(promoWords);
    if (promoMatch) {
        return { match: true, reason: `Promo language: ${promoMatch[0]}` };
    }

    // Check phrases from config
    for (const phrase of bodyPhrases) {
        if (snippetLower.includes(phrase.toLowerCase())) {
            return { match: true, reason: `Body contains "${phrase}"` };
        }
    }

    return { match: false };
}

// Authorize with Gmail API
async function authorize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('\n========================================');
        console.error('ERROR: gmail-credentials.json not found!');
        console.error('========================================\n');
        console.error('Follow the setup instructions in GMAIL_SETUP.txt\n');
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
    }

    return getNewToken(oAuth2Client);
}

// Get new OAuth token
function getNewToken(oAuth2Client) {
    return new Promise((resolve, reject) => {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });

        console.log('\n========================================');
        console.log('AUTHORIZATION REQUIRED');
        console.log('========================================\n');
        console.log('Open this URL in your browser:\n');
        console.log(authUrl);
        console.log('\nAfter authorizing, paste the code here.\n');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question('Enter the authorization code: ', async (code) => {
            rl.close();
            try {
                const { tokens } = await oAuth2Client.getToken(code);
                oAuth2Client.setCredentials(tokens);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
                console.log('\nToken saved!\n');
                resolve(oAuth2Client);
            } catch (err) {
                reject(new Error('Error retrieving access token: ' + err.message));
            }
        });
    });
}

// Scan emails
async function scanEmails(auth, config) {
    const gmail = google.gmail({ version: 'v1', auth });
    const results = [];
    const seen = new Set();

    // Calculate date range
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - config.daysToScan);
    const afterDate = daysAgo.toISOString().split('T')[0].replace(/-/g, '/');

    console.log(`\nScanning emails from the last ${config.daysToScan} days...\n`);

    // Build search queries for PROMOTIONAL SPAM (not transactional emails)
    const searchQueries = [
        // DISCOUNT OFFERS
        `"% off" after:${afterDate}`,
        `"$ off" after:${afterDate}`,
        `"percent off" after:${afterDate}`,
        `"discount" after:${afterDate}`,
        `"save $" after:${afterDate}`,
        // FREE OFFERS
        `"free shipping" after:${afterDate}`,
        `"free gift" after:${afterDate}`,
        `"free trial" after:${afterDate}`,
        // PROMO/SALE LANGUAGE
        `"promo code" after:${afterDate}`,
        `"coupon code" after:${afterDate}`,
        `"use code" after:${afterDate}`,
        `"clearance" after:${afterDate}`,
        `"limited time" after:${afterDate}`,
        `"act now" after:${afterDate}`,
        `"flash sale" after:${afterDate}`,
        `"on sale" after:${afterDate}`,
        `"marked down" after:${afterDate}`,
    ];

    let processedCount = 0;

    for (const query of searchQueries) {
        try {
            process.stdout.write(`Searching: ${query.substring(0, 40)}...`);

            const response = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: config.maxResults
            });

            const messages = response.data.messages || [];
            console.log(` found ${messages.length}`);

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

                // Check for suspicious sender
                if (config.checkSuspiciousSenders && isSuspiciousSender(from)) {
                    flags.push('FORGED SENDER - Random/gibberish address');
                }

                // Check subject
                const subjectCheck = hasSpammySubject(subject, config.subjectPatterns || []);
                if (subjectCheck.match) {
                    flags.push(`SPAMMY SUBJECT - ${subjectCheck.reason}`);
                }

                // Check body
                const bodyCheck = hasSpammyBody(snippet, config.bodyPhrases || []);
                if (bodyCheck.match) {
                    flags.push(`SPAMMY BODY - ${bodyCheck.reason}`);
                }

                if (flags.length > 0) {
                    results.push({
                        id: message.id,
                        subject,
                        from,
                        date,
                        snippet: snippet.substring(0, 150),
                        flags
                    });
                }

                processedCount++;
            }
        } catch (err) {
            console.error(` error: ${err.message}`);
        }
    }

    console.log(`\nProcessed ${processedCount} emails total.`);
    return results;
}

// Display results
function displayResults(results) {
    console.log('\n========================================');
    console.log(`SCAN COMPLETE - Found ${results.length} suspicious emails`);
    console.log('========================================\n');

    if (results.length === 0) {
        console.log('No suspicious emails found!\n');
        return;
    }

    // Group by flag type
    const forgedSender = results.filter(r => r.flags.some(f => f.includes('FORGED')));
    const spammySubject = results.filter(r => r.flags.some(f => f.includes('SPAMMY SUBJECT')));
    const spammyBody = results.filter(r => r.flags.some(f => f.includes('SPAMMY BODY')));

    console.log(`Summary:`);
    console.log(`  - Forged/suspicious senders: ${forgedSender.length}`);
    console.log(`  - Spammy subjects (FREE/$/%): ${spammySubject.length}`);
    console.log(`  - Spammy body content: ${spammyBody.length}`);
    console.log('');

    // Sort by date
    results.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Show top 20 in console
    const showCount = Math.min(results.length, 20);
    console.log(`Showing ${showCount} of ${results.length} suspicious emails:\n`);

    results.slice(0, showCount).forEach((email, index) => {
        console.log(`${index + 1}. ${email.subject}`);
        console.log(`   From: ${email.from}`);
        console.log(`   Date: ${email.date}`);
        console.log(`   Flags: ${email.flags.join(' | ')}`);
        console.log(`   Preview: ${email.snippet}...`);
        console.log('');
    });

    // Save full results
    const outputPath = path.join(__dirname, 'scan-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\nFull results saved to: scan-results.json`);

    // Also save a simple CSV for easy viewing
    const csvPath = path.join(__dirname, 'scan-results.csv');
    const csvContent = [
        'Subject,From,Date,Flags',
        ...results.map(r =>
            `"${r.subject.replace(/"/g, '""')}","${r.from.replace(/"/g, '""')}","${r.date}","${r.flags.join('; ')}"`
        )
    ].join('\n');
    fs.writeFileSync(csvPath, csvContent);
    console.log(`CSV results saved to: scan-results.csv`);
}

// Main
async function main() {
    console.log('\n========================================');
    console.log('   GMAIL SPAM SCANNER');
    console.log('========================================');
    console.log('Detecting:');
    console.log('  - Forged headers (random sender addresses)');
    console.log('  - FREE / $ / % in subject lines');
    console.log('  - Discount/free offers in body');

    const config = loadConfig();

    try {
        const auth = await authorize();
        const results = await scanEmails(auth, config);
        displayResults(results);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

main();
