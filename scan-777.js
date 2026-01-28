/**
 * Scan surrilla777@gmail.com for spam - last 6 months
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'account-surrilla777', 'gmail-token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');

// Check if sender address looks like random gibberish
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

    if (/^[a-z]{2,4}\d+[a-z]{2,4}\d*$/i.test(localPart)) return true;

    return false;
}

// Check if subject has spam patterns
function hasSpammySubject(subject) {
    if (!subject) return { match: false };

    // Dollar discount offers
    const dollarDiscountMatch = subject.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) {
        return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };
    }

    // Percentage discount offers
    const percentDiscountMatch = subject.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) {
        return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };
    }

    // Free offers
    const freeOfferMatch = subject.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download|ebook|guide|consultation)|get\s+\w+\s+free\b|buy\s+\w+\s+get\s+\w+\s+free\b|\bfree\b[^a-z].*\boffer\b/i);
    if (freeOfferMatch) {
        return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };
    }

    // Promo language
    const promoWords = /(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i;
    const promoMatch = subject.match(promoWords);
    if (promoMatch) {
        return { match: true, reason: `Promo language: ${promoMatch[0]}` };
    }

    return { match: false };
}

// Check body for spam
function hasSpammyBody(snippet) {
    if (!snippet) return { match: false };

    const dollarDiscountMatch = snippet.match(/(\$\d+\s*(off|discount|savings?))|((save|get)\s*\$\d+)/i);
    if (dollarDiscountMatch) {
        return { match: true, reason: `Dollar discount: ${dollarDiscountMatch[0]}` };
    }

    const percentDiscountMatch = snippet.match(/\d+\s*%\s*(off|discount|savings?)|(save\s*\d+\s*%)/i);
    if (percentDiscountMatch) {
        return { match: true, reason: `Percent discount: ${percentDiscountMatch[0]}` };
    }

    const freeOfferMatch = snippet.match(/\bfree\s+(shipping|gift|trial|sample|delivery|bonus|access|download)|get\s+\w+\s+free|\bfree\b.*\boffer\b/i);
    if (freeOfferMatch) {
        return { match: true, reason: `Free offer: ${freeOfferMatch[0]}` };
    }

    const promoWords = /(clearance|marked\s*down|on\s+sale|limited\s+time|act\s+now|hurry|expires?\s+(soon|today|tonight)|last\s+chance|don'?t\s+miss|exclusive\s+(deal|offer)|flash\s+sale|doorbuster|blowout|promo\s*code|discount\s*code|coupon\s*code|use\s+code)/i;
    const promoMatch = snippet.match(promoWords);
    if (promoMatch) {
        return { match: true, reason: `Promo language: ${promoMatch[0]}` };
    }

    return { match: false };
}

async function main() {
    console.log('\n========================================');
    console.log('   SCANNING surrilla777@gmail.com');
    console.log('   Last 6 months of spam');
    console.log('========================================\n');

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (!fs.existsSync(TOKEN_PATH)) {
        console.error('No token for surrilla777. Need to authorize first.');
        process.exit(1);
    }

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const results = [];
    const seen = new Set();

    // 6 months ago
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const afterDate = sixMonthsAgo.toISOString().split('T')[0].replace(/-/g, '/');

    console.log(`Scanning emails after ${afterDate}...\n`);

    const searchQueries = [
        `"% off" after:${afterDate}`,
        `"$ off" after:${afterDate}`,
        `"percent off" after:${afterDate}`,
        `"discount" after:${afterDate}`,
        `"save $" after:${afterDate}`,
        `"free shipping" after:${afterDate}`,
        `"free gift" after:${afterDate}`,
        `"free trial" after:${afterDate}`,
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

    for (const query of searchQueries) {
        try {
            process.stdout.write(`Searching: ${query.substring(0, 40).padEnd(40)}...`);

            const response = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 200
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

                // Skip self-sent emails
                if (from.toLowerCase().includes('surrilla777')) continue;

                const flags = [];

                if (isSuspiciousSender(from)) {
                    flags.push('FORGED SENDER');
                }

                const subjectCheck = hasSpammySubject(subject);
                if (subjectCheck.match) {
                    flags.push(`SPAMMY SUBJECT - ${subjectCheck.reason}`);
                }

                const bodyCheck = hasSpammyBody(snippet);
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
            }
        } catch (err) {
            console.error(` error: ${err.message}`);
        }
    }

    // Sort by date
    results.sort((a, b) => new Date(b.date) - new Date(a.date));

    console.log('\n========================================');
    console.log(`SCAN COMPLETE - Found ${results.length} suspicious emails`);
    console.log('========================================\n');

    if (results.length > 0) {
        // Show top 20
        console.log('Top 20 results:\n');
        results.slice(0, 20).forEach((email, i) => {
            console.log(`${i + 1}. ${email.subject.substring(0, 60)}`);
            console.log(`   From: ${email.from.substring(0, 50)}`);
            console.log(`   Flags: ${email.flags[0]}`);
            console.log('');
        });

        // Save results
        fs.writeFileSync('scan-results-777.json', JSON.stringify(results, null, 2));
        console.log(`Full results saved to: scan-results-777.json`);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
