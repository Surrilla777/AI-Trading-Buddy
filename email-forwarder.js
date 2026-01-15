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

// Config
const FORWARD_TO = 'spamclaims@pacifictrialattorneys.com';
const BATCH_SIZE = 20; // Send only 20 per run to avoid spam filters
const AUTO_DELETE_SENT = true; // Toggle: true = delete from Sent folder after sending, false = keep in Sent
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

// ============ FORWARD FUNCTION ============

async function forwardEmail(gmail, email) {
    const message = await gmail.users.messages.get({
        userId: 'me',
        id: email.id,
        format: 'raw'
    });

    const rawEmail = Buffer.from(message.data.raw, 'base64').toString('utf8');

    const forwardBody = [
        `---------- Forwarded Spam Email ----------`,
        `From: ${email.from}`,
        `Date: ${email.date}`,
        `Subject: ${email.subject}`,
        `Flags: ${email.flags.join(', ')}`,
        ``,
        `--- Original Email Content ---`,
        rawEmail.substring(0, 50000)
    ].join('\n');

    const emailContent = [
        `To: ${FORWARD_TO}`,
        `Subject: FWD: ${email.subject}`,
        `Content-Type: text/plain; charset=utf-8`,
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

            process.stdout.write(`[${i + 1}/${emailsToSend.length}] ${email.subject.substring(0, 45).padEnd(45)}...`);

            try {
                await forwardEmail(gmail, email);
                console.log(' ✓ SENT');

                markAsSent(tracker, email.id);
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
