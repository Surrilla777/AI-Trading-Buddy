// Backtest the Next Day Prediction algorithm
const https = require('https');

const fetchYahooChart = (ticker, range = '3mo', interval = '1d') => {
    return new Promise((resolve, reject) => {
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
        https.get(yahooUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse chart data'));
                }
            });
        }).on('error', reject);
    });
};

// The prediction algorithm (same as server.js)
function predictDay(closes, opens, highs, lows, volumes, timestamps, targetIdx) {
    if (targetIdx < 60 || targetIdx >= closes.length - 1) return null;

    const today = {
        open: opens[targetIdx],
        high: highs[targetIdx],
        low: lows[targetIdx],
        close: closes[targetIdx],
        volume: volumes[targetIdx],
        prevClose: closes[targetIdx - 1]
    };

    const dayChange = ((today.close - today.prevClose) / today.prevClose) * 100;
    const todayRed = today.close < today.open;
    const todayGreen = today.close > today.open;

    // RSI
    let gains = 0, losses = 0;
    for (let i = targetIdx - 13; i <= targetIdx; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
    const rsi = 100 - (100 / (1 + rs));

    // Consecutive days
    let consecutiveRed = 0, consecutiveGreen = 0;
    for (let i = targetIdx; i >= targetIdx - 5 && i >= 0; i--) {
        if (closes[i] < opens[i]) {
            if (consecutiveGreen > 0) break;
            consecutiveRed++;
        } else if (closes[i] > opens[i]) {
            if (consecutiveRed > 0) break;
            consecutiveGreen++;
        } else break;
    }

    // Historical pattern matching
    let gapUpCount = 0, gapDownCount = 0;
    let greenCloseCount = 0, redCloseCount = 0;
    let matchCount = 0;

    for (let i = 60; i < targetIdx - 1; i++) {
        const histRsi = (() => {
            let g = 0, l = 0;
            for (let j = i - 13; j <= i; j++) {
                const c = closes[j] - closes[j - 1];
                if (c > 0) g += c; else l -= c;
            }
            const r = l === 0 ? 100 : (g / 14) / (l / 14);
            return 100 - (100 / (1 + r));
        })();

        const histDayChange = ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100;
        const histRed = closes[i] < opens[i];
        const histGreen = closes[i] > opens[i];

        let histConsecRed = 0, histConsecGreen = 0;
        for (let j = i; j >= i - 5 && j >= 0; j--) {
            if (closes[j] < opens[j]) {
                if (histConsecGreen > 0) break;
                histConsecRed++;
            } else if (closes[j] > opens[j]) {
                if (histConsecRed > 0) break;
                histConsecGreen++;
            } else break;
        }

        const rsiMatch = Math.abs(histRsi - rsi) < 15;
        const trendMatch = (histRed === todayRed) || (histGreen === todayGreen);
        const consecMatch = (consecutiveRed > 0 && histConsecRed > 0) || (consecutiveGreen > 0 && histConsecGreen > 0);
        const moveMatch = Math.abs(histDayChange - dayChange) < 1.5;

        const matchScore = (rsiMatch ? 1 : 0) + (trendMatch ? 1 : 0) + (consecMatch ? 1 : 0) + (moveMatch ? 1 : 0);

        if (matchScore >= 3) {
            matchCount++;
            const nextOpen = opens[i + 1];
            const nextClose = closes[i + 1];
            const thisClose = closes[i];

            if (nextOpen > thisClose) gapUpCount++;
            else gapDownCount++;

            if (nextClose > nextOpen) greenCloseCount++;
            else redCloseCount++;
        }
    }

    const gapUpProb = matchCount > 0 ? Math.round((gapUpCount / matchCount) * 100) : 50;
    const greenProb = matchCount > 0 ? Math.round((greenCloseCount / matchCount) * 100) : 50;

    return {
        date: new Date(timestamps[targetIdx] * 1000).toLocaleDateString(),
        matchCount,
        gapUpProb,
        gapDownProb: 100 - gapUpProb,
        greenProb,
        redProb: 100 - greenProb,
        openPrediction: gapUpProb > 55 ? 'GAP_UP' : (100 - gapUpProb) > 55 ? 'GAP_DOWN' : 'UNCERTAIN',
        closePrediction: greenProb > 55 ? 'GREEN' : (100 - greenProb) > 55 ? 'RED' : 'UNCERTAIN'
    };
}

async function backtest(ticker = 'SPY', daysBack = 14) {
    console.log(`\n========================================`);
    console.log(`BACKTESTING: ${ticker} - Last ${daysBack} trading days`);
    console.log(`========================================\n`);

    const data = await fetchYahooChart(ticker, '6mo', '1d');

    if (!data?.chart?.result?.[0]) {
        console.log('No data available');
        return;
    }

    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];

    const lastIdx = closes.length - 1;

    let openCorrect = 0, openWrong = 0, openUncertain = 0;
    let closeCorrect = 0, closeWrong = 0, closeUncertain = 0;

    const results = [];

    // Test predictions for the last N days
    for (let i = lastIdx - daysBack; i < lastIdx; i++) {
        const prediction = predictDay(closes, opens, highs, lows, volumes, timestamps, i);
        if (!prediction) continue;

        // What actually happened the next day
        const nextOpen = opens[i + 1];
        const nextClose = closes[i + 1];
        const thisClose = closes[i];

        const actualGap = nextOpen > thisClose ? 'GAP_UP' : 'GAP_DOWN';
        const actualClose = nextClose > nextOpen ? 'GREEN' : 'RED';

        // Score the prediction
        let openResult = 'N/A';
        if (prediction.openPrediction === 'UNCERTAIN') {
            openUncertain++;
            openResult = '🟡 UNCERTAIN';
        } else if (prediction.openPrediction === actualGap) {
            openCorrect++;
            openResult = '✅ CORRECT';
        } else {
            openWrong++;
            openResult = '❌ WRONG';
        }

        let closeResult = 'N/A';
        if (prediction.closePrediction === 'UNCERTAIN') {
            closeUncertain++;
            closeResult = '🟡 UNCERTAIN';
        } else if (prediction.closePrediction === actualClose) {
            closeCorrect++;
            closeResult = '✅ CORRECT';
        } else {
            closeWrong++;
            closeResult = '❌ WRONG';
        }

        results.push({
            date: prediction.date,
            matches: prediction.matchCount,
            openPred: prediction.openPrediction,
            openActual: actualGap,
            openResult,
            closePred: prediction.closePrediction,
            closeActual: actualClose,
            closeResult
        });
    }

    // Print results
    console.log('DATE        | MATCHES | OPEN PRED   | ACTUAL    | RESULT     | CLOSE PRED | ACTUAL | RESULT');
    console.log('-'.repeat(100));

    for (const r of results) {
        console.log(
            `${r.date.padEnd(11)} | ${String(r.matches).padEnd(7)} | ${r.openPred.padEnd(11)} | ${r.openActual.padEnd(9)} | ${r.openResult.padEnd(12)} | ${r.closePred.padEnd(10)} | ${r.closeActual.padEnd(6)} | ${r.closeResult}`
        );
    }

    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');

    const openTotal = openCorrect + openWrong;
    const closeTotal = closeCorrect + closeWrong;

    console.log(`\nOPEN (Gap) Predictions:`);
    console.log(`  Correct: ${openCorrect}/${openTotal} (${openTotal > 0 ? ((openCorrect/openTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  Wrong: ${openWrong}/${openTotal}`);
    console.log(`  Uncertain (no call): ${openUncertain}`);

    console.log(`\nCLOSE (Green/Red) Predictions:`);
    console.log(`  Correct: ${closeCorrect}/${closeTotal} (${closeTotal > 0 ? ((closeCorrect/closeTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  Wrong: ${closeWrong}/${closeTotal}`);
    console.log(`  Uncertain (no call): ${closeUncertain}`);

    console.log('\n');
}

// Run backtest
(async () => {
    await backtest('SPY', 14);
    await backtest('QQQ', 14);
    await backtest('IWM', 14);
})();
