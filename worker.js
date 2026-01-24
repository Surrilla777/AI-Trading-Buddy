// Cloudflare Worker - Finviz Proxy (No Caching)
// Deploy this to Cloudflare Workers (free tier)

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    const pattern = url.searchParams.get('pattern');

    if (!pattern) {
      return new Response(JSON.stringify({ error: 'Missing pattern parameter' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }

    // Build Finviz URL
    const finvizUrl = `https://finviz.com/screener.ashx?v=111&f=${pattern},cap_smallover,sh_avgvol_o200,sh_price_o5&o=-marketcap`;

    try {
      const response = await fetch(finvizUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        cf: {
          // Disable Cloudflare caching
          cacheTtl: 0,
          cacheEverything: false,
        },
      });

      const html = await response.text();

      // Parse the HTML and extract stock data
      const stocks = parseFinvizHtml(html);

      return new Response(JSON.stringify({
        pattern,
        stocks,
        timestamp: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }
  },
};

function parseFinvizHtml(html) {
  const stocks = [];

  // Match table rows with stock data
  // Finviz structure: ticker links go to quote.ashx?t=TICKER
  const tickerRegex = /<a href="quote\.ashx\?t=([A-Z]{1,5})"[^>]*class="screener-link-primary"[^>]*>\1<\/a>/g;
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;

  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    if (stocks.length >= 25) break;

    // Find ticker in this row
    const tickerMatch = row.match(/<a href="quote\.ashx\?t=([A-Z]{1,5})"[^>]*>([A-Z]{1,5})<\/a>/);
    if (!tickerMatch) continue;

    const ticker = tickerMatch[1];
    if (stocks.find(s => s.ticker === ticker)) continue;

    // Extract company name - usually in the cell after ticker
    const companyMatch = row.match(/<td[^>]*><a[^>]*class="screener-link-primary"[^>]*>[A-Z]{1,5}<\/a><\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a>/);
    const company = companyMatch ? companyMatch[1].substring(0, 35) : '';

    // Extract other data using patterns
    const marketCapMatch = row.match(/>(\d+\.?\d*[BMK])</);
    const priceMatch = row.match(/>(\d+\.\d{2})</);
    const changeMatch = row.match(/>(-?\d+\.?\d*%)</);

    stocks.push({
      ticker,
      company,
      marketCap: marketCapMatch ? marketCapMatch[1] : '',
      price: priceMatch ? '$' + priceMatch[1] : '',
      change: changeMatch ? changeMatch[1] : '',
      changeNum: changeMatch ? parseFloat(changeMatch[1]) : 0,
    });
  }

  return stocks;
}
