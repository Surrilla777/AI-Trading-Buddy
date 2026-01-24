/**
 * Gmail Spam Forwarder with Full Tracking
 * Tracks ALL emails: sent, pending, failed
 * Automatically resumes from where it left off
 *
 * Usage:
 *   node email-forwarder.js          - Forward remaining emails
 *   node email-forwarder.js --status - Show current status
 *   node email-forwarder.js --reset  - Reset tracking (start fresh)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

// File paths
const TOKEN_PATH = path.join(__dirname, 'gmail-token-forward.json');
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');
const RESULTS_PATH = path.join(__dirname, 'scan-results.json');
const TRACKER_PATH = path.join(__dirname, 'email-tracker.json');
const SENT_LOG_PATH = path.join(__dirname, 'sent-emails.log');
const PERMANENT_HISTORY_PATH = path.join(__dirname, 'sent-history-permanent.json'); // NEVER gets reset

// ============ PERMANENT HISTORY (prevents duplicates forever) ============

function loadPermanentHistory() {
    if (fs.existsSync(PERMANENT_HISTORY_PATH)) {
        return JSON.parse(fs.readFileSync(PERMANENT_HISTORY_PATH, 'utf8'));
    }
    return { sentIds: [], count: 0 };
}

function savePermanentHistory(history) {
    fs.writeFileSync(PERMANENT_HISTORY_PATH, JSON.stringify(history, null, 2));
}

function isAlreadySentPermanent(emailId) {
    const history = loadPermanentHistory();
    return history.sentIds.includes(emailId);
}

function markSentPermanent(emailId) {
    const history = loadPermanentHistory();
    if (!history.sentIds.includes(emailId)) {
        history.sentIds.push(emailId);
        history.count = history.sentIds.length;
        savePermanentHistory(history);
    }
}

// Config
const FORWARD_TO = 'surrilla777@gmail.com'; // TESTING
const BATCH_SIZE = 1; // TESTING: Set to 1 for single email test
const AUTO_DELETE_SENT = false; // Toggle: true = delete from Sent folder after sending, false = keep in Sent
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify' // Needed for delete
];

// ============ TRACKER FUNCTIONS ============

function loadTracker() {
    if (fs.existsSync(TRACKER_PATH)) {
        return JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8'));
    }
    return {
        lastUpdated: new Date().toISOString(),
        totalEmails: 0,
        sentIds: [],
        pendingIds: [],
        failedIds: [],
        rateLimitedAt: null,
        forwardTo: FORWARD_TO,
        history: []
    };
}

function saveTracker(tracker) {
    tracker.lastUpdated = new Date().toISOString();
    fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
}

function logSentEmail(email, status, error = null) {
    const logEntry = `${new Date().toISOString()} | ${status} | ${email.id} | ${email.subject.substring(0, 60)}${error ? ' | ' + error : ''}\n`;
    fs.appendFileSync(SENT_LOG_PATH, logEntry);
}

function initTracker(results) {
    const tracker = loadTracker();

    // If no tracking data, initialize from results
    if (tracker.totalEmails === 0 || tracker.pendingIds.length === 0) {
        tracker.totalEmails = results.length;
        tracker.pendingIds = results.map(r => r.id);
        tracker.sentIds = [];
        tracker.failedIds = [];
        tracker.history = [];
    }

    // Remove already sent IDs from pending
    tracker.pendingIds = tracker.pendingIds.filter(id => !tracker.sentIds.includes(id));

    saveTracker(tracker);
    return tracker;
}

function markAsSent(tracker, emailId) {
    if (!tracker.sentIds.includes(emailId)) {
        tracker.sentIds.push(emailId);
    }
    tracker.pendingIds = tracker.pendingIds.filter(id => id !== emailId);
    tracker.failedIds = tracker.failedIds.filter(id => id !== emailId);
    saveTracker(tracker);
}

function markAsFailed(tracker, emailId, error) {
    if (!tracker.failedIds.includes(emailId)) {
        tracker.failedIds.push(emailId);
    }
    // Keep in pending for retry unless permanent failure
    if (!error.includes('rate limit')) {
        tracker.pendingIds = tracker.pendingIds.filter(id => id !== emailId);
    }
    saveTracker(tracker);
}

function markRateLimited(tracker) {
    tracker.rateLimitedAt = new Date().toISOString();
    tracker.history.push({
        date: new Date().toISOString(),
        event: 'rate_limited',
        sent: tracker.sentIds.length,
        pending: tracker.pendingIds.length
    });
    saveTracker(tracker);
}

// ============ STATUS DISPLAY ============

function showStatus() {
    console.log('\n========================================');
    console.log('   EMAIL FORWARDING STATUS');
    console.log('========================================\n');

    if (!fs.existsSync(TRACKER_PATH)) {
        console.log('No tracking data found. Run a scan first.\n');
        return;
    }

    const tracker = loadTracker();

    console.log(`Forward To: ${tracker.forwardTo}`);
    console.log(`Last Updated: ${tracker.lastUpdated}`);
    console.log('');
    console.log('┌─────────────────────────────────────┐');
    console.log(`│  SENT:     ${String(tracker.sentIds?.length || 0).padStart(6)}                    │`);
    console.log(`│  PENDING:  ${String(tracker.pendingIds?.length || 0).padStart(6)}                    │`);
    console.log(`│  FAILED:   ${String(tracker.failedIds?.length || 0).padStart(6)}                    │`);
    console.log(`│  ─────────────────                  │`);
    console.log(`│  TOTAL:    ${String(tracker.totalEmails || 0).padStart(6)}                    │`);
    console.log('└─────────────────────────────────────┘');

    if (tracker.rateLimitedAt) {
        const limitTime = new Date(tracker.rateLimitedAt);
        const now = new Date();
        const hoursSince = Math.round((now - limitTime) / (1000 * 60 * 60));
        console.log(`\n⚠️  Rate limited ${hoursSince} hours ago`);
        if (hoursSince >= 24) {
            console.log('✅ Should be safe to resume now!');
        } else {
            console.log(`⏰ Wait ${24 - hoursSince} more hours to be safe`);
        }
    }

    if (tracker.history && tracker.history.length > 0) {
        console.log('\nRecent History:');
        tracker.history.slice(-5).forEach(h => {
            console.log(`  ${h.date.substring(0, 10)} - ${h.event} (sent: ${h.sent})`);
        });
    }

    console.log('\nCommands:');
    console.log('  npm run forward         - Resume forwarding');
    console.log('  npm run forward:status  - Show this status');
    console.log('  npm run forward:reset   - Reset and start fresh');
    console.log('========================================\n');
}

// ============ AUTH FUNCTIONS ============

async function authorize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('ERROR: gmail-credentials.json not found!');
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

function getNewToken(oAuth2Client) {
    return new Promise((resolve, reject) => {
        const authCodeArg = process.argv.find(arg => arg.startsWith('--code='));
        if (authCodeArg) {
            const code = authCodeArg.split('=')[1];
            (async () => {
                try {
                    const { tokens } = await oAuth2Client.getToken(code);
                    oAuth2Client.setCredentials(tokens);
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
                    console.log('Token saved!\n');
                    resolve(oAuth2Client);
                } catch (err) {
                    reject(new Error('Error retrieving access token: ' + err.message));
                }
            })();
            return;
        }

        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });

        console.log('\n========================================');
        console.log('AUTHORIZATION REQUIRED');
        console.log('========================================\n');
        console.log('Open this URL in your browser:\n');
        console.log(authUrl);
        console.log('\nPaste the code from the URL here.\n');

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
                reject(new Error('Error: ' + err.message));
            }
        });
    });
}

// ============ EMAIL PARSING FUNCTIONS ============

/**
 * Strip HTML and return clean plain text
 */
function stripHtml(html) {
    return html
        // Remove style tags and content
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove script tags and content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        // Remove HTML comments including IE conditionals
        .replace(/<!--[\s\S]*?-->/g, '')
        // Replace br and p tags with newlines
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        // Remove all other HTML tags
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&rsquo;/g, "'")
        .replace(/&lsquo;/g, "'")
        .replace(/&rdquo;/g, '"')
        .replace(/&ldquo;/g, '"')
        .replace(/&ndash;/g, '-')
        .replace(/&mdash;/g, '-')
        // Remove zero-width and invisible characters
        .replace(/&zwnj;/g, '')
        .replace(/&zwj;/g, '')
        .replace(/&#8199;/g, '')
        .replace(/&#8203;/g, '')
        .replace(/&#65279;/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Remove all remaining HTML entities
        .replace(/&#?\w+;/g, '')
        // Remove standalone URLs on their own lines
        .replace(/^\s*https?:\/\/[^\s]+\s*$/gm, '')
        // Clean up whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/gm, '')
        .trim();
}

/**
 * Check if content is actually HTML (regardless of MIME type)
 */
function isHtml(content) {
    const trimmed = content.trim().toLowerCase();
    return trimmed.startsWith('<!doctype') ||
           trimmed.startsWith('<html') ||
           trimmed.startsWith('<head') ||
           trimmed.startsWith('<body') ||
           (content.includes('<div') && content.includes('</div>')) ||
           (content.includes('<table') && content.includes('</table>'));
}

/**
 * Recursively find all body data in email parts
 */
function findAllBodies(part, results = { plain: [], html: [] }) {
    if (!part) return results;

    // Check this part's body
    if (part.body && part.body.data) {
        const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');

        // Check ACTUAL content, not just MIME type (some senders lie!)
        if (isHtml(decoded)) {
            results.html.push(decoded);
        } else if (part.mimeType === 'text/plain') {
            results.plain.push(decoded);
        } else if (part.mimeType === 'text/html') {
            results.html.push(decoded);
        } else {
            // Unknown type - check if it looks like HTML
            if (decoded.includes('<') && decoded.includes('>')) {
                results.html.push(decoded);
            } else {
                results.plain.push(decoded);
            }
        }
    }

    // Recurse into nested parts
    if (part.parts && Array.isArray(part.parts)) {
        for (const subpart of part.parts) {
            findAllBodies(subpart, results);
        }
    }

    return results;
}

/**
 * Clean any text content (remove junk even from "plain text")
 */
function cleanText(text) {
    return text
        // Remove HTML entities that snuck into plain text
        .replace(/&zwnj;/gi, '')
        .replace(/&zwj;/gi, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#8199;/g, '')
        .replace(/&#8203;/g, '')
        .replace(/&#65279;/g, '')
        .replace(/&#\d+;/g, '')
        .replace(/&\w+;/g, '')
        // Remove zero-width characters
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
        // Remove standalone URLs on their own lines
        .replace(/^\s*https?:\/\/[^\s]+\s*$/gm, '')
        // Clean up excessive whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/gm, '')
        .trim();
}

/**
 * Get readable email body from a Gmail message
 */
function getReadableBody(payload) {
    // Find all plain text and HTML bodies
    const bodies = findAllBodies(payload);

    // Prefer actual plain text (not mislabeled HTML) - but still clean it
    if (bodies.plain.length > 0) {
        return cleanText(bodies.plain.join('\n'));
    }

    // Strip HTML from all HTML content
    if (bodies.html.length > 0) {
        return stripHtml(bodies.html.join('\n'));
    }

    // Last resort: check if body is directly on payload
    if (payload.body && payload.body.data) {
        const decoded = Buffer.from(payload.body.data, 'base64').toString('utf8');
        if (isHtml(decoded)) {
            return stripHtml(decoded);
        }
        return cleanText(decoded);
    }

    return '(Could not extract email body)';
}

/**
 * Encode subject line for email headers (handles emojis/unicode)
 */
function encodeSubject(subject) {
    // Check if subject has non-ASCII characters
    if (/[^\x00-\x7F]/.test(subject)) {
        // Use MIME encoded-word format (RFC 2047)
        const encoded = Buffer.from(subject, 'utf8').toString('base64');
        return `=?UTF-8?B?${encoded}?=`;
    }
    return subject;
}

/**
 * Get HTML body from email (for forwarding with images)
 */
function getHtmlBody(payload) {
    // Find HTML part
    function findHtml(part) {
        if (!part) return null;
        if (part.mimeType === 'text/html' && part.body && part.body.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
        if (part.parts) {
            for (const p of part.parts) {
                const html = findHtml(p);
                if (html) return html;
            }
        }
        return null;
    }
    return findHtml(payload);
}

// ============ FORWARD FUNCTION ============

async function forwardEmail(gmail, email) {
    // Get email in FULL format to properly parse content
    const message = await gmail.users.messages.get({
        userId: 'me',
        id: email.id,
        format: 'full'
    });

    // Try to get HTML body (preserves images)
    const htmlBody = getHtmlBody(message.data.payload);

    // Build forwarded email
    let forwardBody, contentType;

    if (htmlBody) {
        // Send as HTML to preserve images
        contentType = 'text/html; charset=utf-8';
        forwardBody = `
<div style="font-family: Arial, sans-serif; padding: 20px; border-bottom: 2px solid #ccc; margin-bottom: 20px; background: #f9f9f9;">
    <h3 style="color: #d9534f; margin: 0 0 10px 0;">---------- Forwarded Spam Email ----------</h3>
    <p style="margin: 5px 0;"><strong>From:</strong> ${email.from.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    <p style="margin: 5px 0;"><strong>Date:</strong> ${email.date}</p>
    <p style="margin: 5px 0;"><strong>Subject:</strong> ${email.subject.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    <p style="margin: 5px 0;"><strong>Flags:</strong> <span style="color: #d9534f;">${email.flags.join(', ')}</span></p>
    <hr style="margin: 15px 0;">
    <p style="margin: 0;"><strong>--- Original Email Content Below ---</strong></p>
</div>
${htmlBody}
`;
    } else {
        // Fallback to plain text
        contentType = 'text/plain; charset=utf-8';
        const readableBody = getReadableBody(message.data.payload);
        forwardBody = [
            `---------- Forwarded Spam Email ----------`,
            `From: ${email.from}`,
            `Date: ${email.date}`,
            `Subject: ${email.subject}`,
            `Flags: ${email.flags.join(', ')}`,
            ``,
            `--- Original Email Content ---`,
            readableBody.substring(0, 50000)
        ].join('\n');
    }

    const emailContent = [
        `To: ${FORWARD_TO}`,
        `Subject: ${encodeSubject('FWD: ' + email.subject)}`,
        `Content-Type: ${contentType}`,
        ``,
        forwardBody
    ].join('\r\n');

    const encodedEmail = Buffer.from(emailContent).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const sentMessage = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedEmail }
    });

    // Auto-delete from Sent folder if enabled
    if (AUTO_DELETE_SENT && sentMessage.data && sentMessage.data.id) {
        try {
            await gmail.users.messages.delete({
                userId: 'me',
                id: sentMessage.data.id
            });
        } catch (delErr) {
            // Silently ignore delete errors - email was still sent
        }
    }
}

// ============ MAIN ============

async function main() {
    // Check for flags
    if (process.argv.includes('--status')) {
        showStatus();
        return;
    }

    if (process.argv.includes('--reset')) {
        if (fs.existsSync(TRACKER_PATH)) fs.unlinkSync(TRACKER_PATH);
        if (fs.existsSync(SENT_LOG_PATH)) fs.unlinkSync(SENT_LOG_PATH);
        console.log('Tracking reset. Run scan again to start fresh.\n');
        return;
    }

    console.log('\n========================================');
    console.log('   GMAIL SPAM FORWARDER');
    console.log('========================================');
    console.log(`Forwarding to: ${FORWARD_TO}`);
    console.log(`Batch size: ${BATCH_SIZE} emails per run`);
    console.log(`Auto-delete from Sent: ${AUTO_DELETE_SENT ? 'ON' : 'OFF'}\n`);

    // Load scan results
    if (!fs.existsSync(RESULTS_PATH)) {
        console.error('ERROR: No scan results found!');
        console.error('Run "npm run scan" first.\n');
        process.exit(1);
    }

    const allResults = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    const tracker = initTracker(allResults);

    // Show current status
    console.log(`Total scanned: ${tracker.totalEmails}`);
    console.log(`Already sent:  ${tracker.sentIds.length}`);
    console.log(`Pending:       ${tracker.pendingIds.length}`);
    console.log(`Failed:        ${tracker.failedIds.length}`);
    console.log('');

    if (tracker.pendingIds.length === 0) {
        console.log('🎉 All emails have been forwarded!\n');
        return;
    }

    // Get pending emails
    const pendingEmails = allResults.filter(r => tracker.pendingIds.includes(r.id));

    // Confirm
    const autoConfirm = process.argv.includes('--confirm');
    if (!autoConfirm) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const answer = await new Promise(resolve => {
            rl.question(`Forward ${pendingEmails.length} pending emails? (yes/no): `, resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
            console.log('Cancelled.\n');
            return;
        }
    }

    try {
        const auth = await authorize();
        const gmail = google.gmail({ version: 'v1', auth });

        let sentThisSession = 0;
        let failedThisSession = 0;

        console.log('\nStarting...\n');

        const emailsToSend = pendingEmails.slice(0, BATCH_SIZE);
        console.log(`Sending ${emailsToSend.length} emails this batch (limit: ${BATCH_SIZE})\n`);

        for (let i = 0; i < emailsToSend.length; i++) {
            const email = emailsToSend[i];

            // CHECK PERMANENT HISTORY - never send same email twice!
            if (isAlreadySentPermanent(email.id)) {
                console.log(`[${i + 1}/${emailsToSend.length}] ${email.subject.substring(0, 45).padEnd(45)}... ⏭️ SKIPPED (already sent before)`);
                markAsSent(tracker, email.id); // Mark in session tracker too
                continue;
            }

            process.stdout.write(`[${i + 1}/${emailsToSend.length}] ${email.subject.substring(0, 45).padEnd(45)}...`);

            try {
                await forwardEmail(gmail, email);
                console.log(' ✓ SENT');

                markAsSent(tracker, email.id);
                markSentPermanent(email.id); // Add to PERMANENT history
                logSentEmail(email, 'SENT');
                sentThisSession++;

            } catch (err) {
                const errorMsg = err.message || 'Unknown error';

                if (errorMsg.toLowerCase().includes('rate limit')) {
                    console.log(' ⚠️ RATE LIMITED');
                    markRateLimited(tracker);
                    logSentEmail(email, 'RATE_LIMITED', errorMsg);

                    console.log('\n========================================');
                    console.log('⚠️  GMAIL RATE LIMIT HIT');
                    console.log('========================================');
                    console.log(`Sent this session: ${sentThisSession}`);
                    console.log(`Total sent: ${tracker.sentIds.length}`);
                    console.log(`Still pending: ${tracker.pendingIds.length}`);
                    console.log('\nTry again in a few hours or tomorrow.');
                    console.log('Run: npm run forward');
                    console.log('========================================\n');

                    // Add to history
                    tracker.history.push({
                        date: new Date().toISOString(),
                        event: 'session_ended',
                        sent: sentThisSession,
                        reason: 'rate_limit'
                    });
                    saveTracker(tracker);
                    return;
                }

                console.log(' ✗ FAILED');
                markAsFailed(tracker, email.id, errorMsg);
                logSentEmail(email, 'FAILED', errorMsg);
                failedThisSession++;
            }

            // Delay between emails (800ms to be safe)
            await new Promise(r => setTimeout(r, 800));
        }

        // Session complete
        tracker.history.push({
            date: new Date().toISOString(),
            event: 'session_complete',
            sent: sentThisSession,
            failed: failedThisSession
        });
        saveTracker(tracker);

        console.log('\n========================================');
        console.log('✅ BATCH COMPLETE');
        console.log('========================================');
        console.log(`Sent this batch: ${sentThisSession}`);
        console.log(`Failed this batch: ${failedThisSession}`);
        console.log(`Total sent (all time): ${tracker.sentIds.length}`);
        console.log(`Still pending: ${tracker.pendingIds.length}`);
        if (tracker.pendingIds.length > 0) {
            console.log(`\n⏰ Run again in 3-4 hours to send next batch`);
            console.log(`   Remaining batches: ~${Math.ceil(tracker.pendingIds.length / BATCH_SIZE)}`);
        } else {
            console.log(`\n🎉 ALL DONE! All emails have been forwarded.`);
        }
        console.log('========================================\n');

    } catch (err) {
        console.error('\nError:', err.message);
        process.exit(1);
    }
}

main();
