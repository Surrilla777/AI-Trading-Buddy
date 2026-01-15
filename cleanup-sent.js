/**
 * Cleanup Sent Emails
 * Moves forwarded spam emails from Sent folder to Trash
 * Uses trash() instead of delete() - works with gmail.modify scope
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'gmail-token-forward.json');
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');

async function authorize() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function main() {
    console.log('\n========================================');
    console.log('   CLEANUP SENT EMAILS');
    console.log('========================================\n');

    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    // Find emails sent to spamclaims in the Sent folder
    console.log('Searching for forwarded spam emails in Sent folder...\n');

    let allMessages = [];
    let pageToken = null;

    do {
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:sent to:spamclaims@pacifictrialattorneys.com',
            maxResults: 100,
            pageToken: pageToken
        });

        if (response.data.messages) {
            allMessages = allMessages.concat(response.data.messages);
        }
        pageToken = response.data.nextPageToken;

        process.stdout.write(`\rFound ${allMessages.length} emails...`);
    } while (pageToken);

    console.log(`\n\nTotal found: ${allMessages.length} emails to cleanup\n`);

    if (allMessages.length === 0) {
        console.log('No emails to cleanup!\n');
        return;
    }

    console.log('Moving to Trash...\n');

    let trashed = 0;
    let failed = 0;

    for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i];

        try {
            await gmail.users.messages.trash({
                userId: 'me',
                id: msg.id
            });
            trashed++;
            process.stdout.write(`\r[${trashed}/${allMessages.length}] Trashed...`);
        } catch (err) {
            failed++;
            console.log(`\nFailed to trash ${msg.id}: ${err.message}`);
        }

        // Small delay to avoid rate limits
        if (i % 50 === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log('\n\n========================================');
    console.log('   CLEANUP COMPLETE');
    console.log('========================================');
    console.log(`Trashed: ${trashed}`);
    console.log(`Failed:  ${failed}`);
    console.log('\nEmails moved to Trash (will auto-delete in 30 days)');
    console.log('Or empty Trash manually to delete immediately.');
    console.log('========================================\n');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
