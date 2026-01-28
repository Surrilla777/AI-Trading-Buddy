# Deploy Cloudflare Worker - 5 Minute Setup

## Step 1: Create Cloudflare Account (if needed)
1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with email (free tier is fine)

## Step 2: Create the Worker
1. Go to https://dash.cloudflare.com/
2. Click **"Workers & Pages"** in the left sidebar
3. Click **"Create Application"**
4. Click **"Create Worker"**
5. Give it a name like `finviz-proxy`
6. Click **"Deploy"**

## Step 3: Add the Code
1. After deploy, click **"Edit code"**
2. Delete everything in the editor
3. Copy ALL contents from `worker.js` and paste it
4. Click **"Deploy"** (top right)

## Step 4: Get Your Worker URL
Your worker URL will be something like:
```
https://finviz-proxy.YOUR_SUBDOMAIN.workers.dev
```

## Step 5: Update the App
Tell me your worker URL and I'll update the app to use it!

---

## Testing the Worker
After deploying, test it by visiting:
```
https://YOUR_WORKER_URL/?pattern=ta_candlestick_ew
```

You should see JSON data with stocks.
