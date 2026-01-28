# Spam Scanner - SOLUTIONS (Try in Order)

## SOLUTION 1: Clear SSL State (2 minutes)
**Windows:**
1. Press `Win + R`
2. Type `inetcpl.cpl` and press Enter
3. Click **Content** tab
4. Click **Clear SSL State** button
5. Click OK
6. Restart browser
7. Try: https://ai-trading-buddy-uc3w.onrender.com

---

## SOLUTION 2: Check for iCloud for Windows (1 minute)
**If you have iCloud installed on your PC, this may be the cause!**

1. Press `Win + R`
2. Type `appwiz.cpl` and press Enter
3. Look for "iCloud" in the list
4. If found: This could be syncing bad certificate data from your iPhone

**Fix:**
1. Open iCloud for Windows
2. Sign out completely
3. On your iPhone: Settings > [Your Name] > Sign Out of iCloud
4. Wait 5 minutes
5. Sign back in on both devices
6. Try the website again

---

## SOLUTION 3: Try Different DNS (3 minutes)
Your ISP's DNS might be blocking certificate servers.

**Windows:**
1. Press `Win + R`
2. Type `ncpa.cpl` and press Enter
3. Right-click your network connection > Properties
4. Double-click "Internet Protocol Version 4 (TCP/IPv4)"
5. Select "Use the following DNS server addresses"
6. Enter:
   - Preferred: `8.8.8.8` (Google)
   - Alternate: `1.1.1.1` (Cloudflare)
7. Click OK, OK
8. Restart browser
9. Try the website again

---

## SOLUTION 4: Run Locally (5 minutes, GUARANTEED TO WORK)
No internet = no SSL problems.

**One-time setup:**
1. Go to: https://console.cloud.google.com/
2. Open your project "still-catalyst-484421-a8"
3. Go to APIs & Services > Credentials
4. Edit your OAuth client
5. Add redirect URI: `http://localhost:3001/auth/callback`
6. Save

**Every time you want to scan:**
1. Open File Explorer
2. Go to: `C:\Users\surri\ai-trading-buddy\web-app`
3. Double-click `START_SPAM_SCANNER.bat`
4. Browser opens automatically
5. Done!

---

## SOLUTION 5: Use a VPN (5 minutes)
Routes around any ISP blocking.

1. Download ProtonVPN (free): https://protonvpn.com/
2. Install and create account
3. Connect to any server
4. Try: https://ai-trading-buddy-uc3w.onrender.com

---

## SOLUTION 6: Test from Friend's Device (1 minute)
Have a friend try: https://ai-trading-buddy-uc3w.onrender.com

If it works for them, we know:
- The website is fine
- The problem is specific to your devices
- Focus on fixing your devices (Solutions 1-3)

---

## REMEMBER
The **GitHub Actions automation is WORKING**.
20 spam emails are forwarded every 3 hours automatically.
You don't actually NEED the web app - it's just for manual scanning.
