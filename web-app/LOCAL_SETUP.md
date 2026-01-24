# Spam Scanner - Local Setup (NO HOSTING NEEDED)

## The Problem
Render and Vercel both have SSL certificate issues on your devices.

## The Solution
Run the app locally on your computer. No hosting = no SSL problems.

---

## ONE-TIME SETUP (5 minutes)

### Step 1: Add Redirect URI to Google Cloud Console

1. Go to: https://console.cloud.google.com/
2. Sign in with your Google account
3. Click the project dropdown at the top (should say "still-catalyst-484421-a8")
4. Click "APIs & Services" in the left menu
5. Click "Credentials"
6. Find your OAuth 2.0 Client ID and click the pencil icon to edit
7. Under "Authorized redirect URIs", click "ADD URI"
8. Add this EXACTLY: `http://localhost:3001/auth/callback`
9. Click "SAVE"

### Step 2: Done!
The .env file is already created with your credentials.

---

## HOW TO USE (Every Time)

### Option A: Double-Click Method
1. Open File Explorer
2. Go to: `C:\Users\surri\ai-trading-buddy\web-app`
3. Double-click `START_SPAM_SCANNER.bat`
4. Browser opens automatically
5. Sign in with Google and scan!

### Option B: Command Line Method
1. Open Command Prompt
2. Run:
```
cd C:\Users\surri\ai-trading-buddy\web-app
npm start
```
3. Open browser to: http://localhost:3001

---

## TROUBLESHOOTING

### "redirect_uri_mismatch" error
- You didn't complete Step 1 above
- Make sure `http://localhost:3001/auth/callback` is in your Google Cloud Console

### "Cannot find module" error
- Run `npm install` first:
```
cd C:\Users\surri\ai-trading-buddy\web-app
npm install
npm start
```

### App won't start
- Make sure no other app is using port 3001
- Try closing all Command Prompt windows and starting fresh

---

## REMEMBER
- The GitHub Actions automation STILL runs automatically (20 emails every 3 hours)
- This local app is just for MANUAL scanning when you want to check for new spam
- You don't NEED this app - the automation handles everything
