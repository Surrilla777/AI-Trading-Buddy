const {google} = require('googleapis');
const fs = require('fs');

// Load the same functions from email-forwarder.js
function stripHtml(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<[^>]+>/g, '')
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
        .replace(/&#\d+;/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .replace(/^\s+|\s+$/gm, '')
        .trim();
}

function isHtml(content) {
    const trimmed = content.trim().toLowerCase();
    return trimmed.startsWith('<!doctype') ||
           trimmed.startsWith('<html') ||
           trimmed.startsWith('<head') ||
           trimmed.startsWith('<body') ||
           (content.includes('<div') && content.includes('</div>')) ||
           (content.includes('<table') && content.includes('</table>'));
}

const creds = JSON.parse(fs.readFileSync('gmail-credentials.json'));
const {client_id, client_secret, redirect_uris} = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync('gmail-token-forward.json')));
const gmail = google.gmail({version:'v1', auth});

// Get a CookUnity email (actual spam)
gmail.users.messages.list({userId:'me', q:'from:cookunity "60% off"', maxResults:1}).then(async res => {
    if (!res.data.messages) {
        console.log('No messages found');
        return;
    }
    const id = res.data.messages[0].id;
    const msg = await gmail.users.messages.get({userId:'me', id, format:'full'});

    console.log('=== EMAIL STRUCTURE ===');
    console.log('Top-level mimeType:', msg.data.payload.mimeType);
    console.log('Has parts:', !!msg.data.payload.parts);

    if (msg.data.payload.parts) {
        for (let i = 0; i < msg.data.payload.parts.length; i++) {
            const part = msg.data.payload.parts[i];
            console.log(`Part ${i}: ${part.mimeType}, hasData: ${!!(part.body && part.body.data)}`);

            if (part.body && part.body.data) {
                const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
                console.log(`  First 100 chars: ${decoded.substring(0, 100)}`);
                console.log(`  isHtml result: ${isHtml(decoded)}`);

                if (isHtml(decoded)) {
                    console.log('\n=== STRIPPED RESULT (first 500 chars) ===');
                    console.log(stripHtml(decoded).substring(0, 500));
                }
            }
        }
    }
}).catch(err => console.error('Error:', err.message));
