const {google} = require('googleapis');
const fs = require('fs');
const creds = JSON.parse(fs.readFileSync('gmail-credentials.json'));
const {client_id, client_secret, redirect_uris} = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync('gmail-token-forward.json')));
const gmail = google.gmail({version:'v1', auth});

gmail.users.messages.list({userId:'me', q:'from:robinhood subject:option', maxResults:1}).then(async res => {
    const id = res.data.messages[0].id;
    const msg = await gmail.users.messages.get({userId:'me', id, format:'full'});

    console.log('=== EMAIL STRUCTURE ===');

    // Get the plain text part directly
    if (msg.data.payload.parts) {
        const plainPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (plainPart && plainPart.body && plainPart.body.data) {
            const decoded = Buffer.from(plainPart.body.data, 'base64').toString('utf8');
            console.log('=== PLAIN TEXT CONTENT ===');
            console.log(decoded.substring(0, 500));
        }
    }
}).catch(err => console.error('Error:', err.message));
