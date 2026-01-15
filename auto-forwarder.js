/**
 * Auto Email Forwarder
 * Sends 20 emails every 3 hours during active hours (100/day max)
 *
 * Usage: node auto-forwarder.js
 * Leave it running in a terminal - it'll do everything automatically
 */

const { execSync } = require('child_process');
const path = require('path');

// Config
const HOURS_BETWEEN_BATCHES = 3;
const START_HOUR = 8;   // Start at 8 AM
const END_HOUR = 23;    // Stop at 11 PM (15 hour window = 5 batches = 100 emails/day)
const MS_BETWEEN_BATCHES = HOURS_BETWEEN_BATCHES * 60 * 60 * 1000;
const CHECK_INTERVAL = 10 * 60 * 1000; // Check every 10 minutes

let lastBatchTime = null;
let batchesToday = 0;
let currentDate = new Date().toDateString();

function log(msg) {
    const now = new Date().toLocaleString();
    console.log(`[${now}] ${msg}`);
}

function isActiveHours() {
    const hour = new Date().getHours();
    return hour >= START_HOUR && hour < END_HOUR;
}

function resetDailyCount() {
    const today = new Date().toDateString();
    if (today !== currentDate) {
        currentDate = today;
        batchesToday = 0;
        log('New day - reset batch counter');
    }
}

function canRunBatch() {
    resetDailyCount();

    // Max 5 batches per day (100 emails)
    if (batchesToday >= 5) {
        return { can: false, reason: 'Daily limit reached (5 batches = 100 emails)' };
    }

    // Check active hours
    if (!isActiveHours()) {
        return { can: false, reason: `Outside active hours (${START_HOUR}:00 - ${END_HOUR}:00)` };
    }

    // Check if enough time passed since last batch
    if (lastBatchTime) {
        const elapsed = Date.now() - lastBatchTime;
        if (elapsed < MS_BETWEEN_BATCHES) {
            const remaining = Math.ceil((MS_BETWEEN_BATCHES - elapsed) / (60 * 1000));
            return { can: false, reason: `Wait ${remaining} more minutes until next batch` };
        }
    }

    return { can: true };
}

async function runBatch() {
    log('Starting batch...');

    try {
        const result = execSync('node email-forwarder.js --confirm', {
            cwd: __dirname,
            encoding: 'utf8',
            timeout: 300000
        });
        console.log(result);

        lastBatchTime = Date.now();
        batchesToday++;

        log(`Batches today: ${batchesToday}/5`);

        if (result.includes('ALL DONE') || result.includes('All emails have been forwarded')) {
            log('ALL EMAILS SENT! Stopping auto-forwarder.');
            process.exit(0);
        }

        if (result.includes('Nothing to forward')) {
            log('No more emails to forward. Stopping.');
            process.exit(0);
        }

    } catch (err) {
        log('Error running batch: ' + err.message);
        if (err.stdout) console.log(err.stdout);
        if (err.stderr) console.log(err.stderr);
    }
}

async function main() {
    console.log('');
    console.log('========================================');
    console.log('   AUTO EMAIL FORWARDER');
    console.log('========================================');
    console.log(`Sending 20 emails every ${HOURS_BETWEEN_BATCHES} hours`);
    console.log(`Active hours: ${START_HOUR}:00 - ${END_HOUR}:00`);
    console.log(`Max per day: 5 batches = 100 emails`);
    console.log('');
    console.log('Leave this running - it works automatically!');
    console.log('Press Ctrl+C to stop');
    console.log('========================================');
    console.log('');

    // Check immediately
    const check = canRunBatch();
    if (check.can) {
        await runBatch();
    } else {
        log(check.reason);
    }

    // Then check periodically
    setInterval(async () => {
        const check = canRunBatch();
        if (check.can) {
            log('\n--- Starting scheduled batch ---\n');
            await runBatch();
        }
    }, CHECK_INTERVAL);

    // Status update every 30 min
    setInterval(() => {
        resetDailyCount();
        const hour = new Date().getHours();
        log(`Status: ${batchesToday}/5 batches today | Active hours: ${isActiveHours() ? 'YES' : 'NO'} (${hour}:00)`);
    }, 30 * 60 * 1000);
}

main();
