// Backtest the Next Day Prediction v2 algorithm
// - Gap-only (no close prediction)
// - Higher thresholds: SPY 75%/25, QQQ/IWM 80%/40
// - 6-month backtest with weekday breakdown
const https = require('https');

const fetchYahooChart = (ticker, range = '1y', interval = '1d') => {
    return new Promise((resolve, reject) => {
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
        https.get(yahooUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Failed to parse chart data')); }
            });
        }).on('error', reject);
    });
};

// Thresholds per ticker (calibrated for 6mo lookback)
const thresholds = {
    SPY: { minMatches: 15, minConfidence: 60 },
    QQQ: { minMatches: 20, minConfidence: 65 },
    IWM: { minMatches: 20, minConfidence: 65 }
};

function predictDay(closes, opens, highs, lows, volumes, timestamps, targetIdx, ticker) {
    if (targetIdx < 60 || targetIdx >= closes.length - 1) return null;

    const today = {
        open: opens[targetIdx],
        close: closes[targetIdx],
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
    let gapUpCount = 0, gapDownCount = 0, gapFilledCount = 0, matchCount = 0;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
            const nextHigh = highs[i + 1];
            const nextLow = lows[i + 1];
            const thisClose = closes[i];

            const gappedUp = nextOpen > thisClose;
            const gapFilled = gappedUp ? (nextLow <= thisClose) : (nextHigh >= thisClose);

            if (gappedUp) gapUpCount++;
            else gapDownCount++;
            if (gapFilled) gapFilledCount++;
        }
    }

    const gapUpProb = matchCount > 0 ? Math.round((gapUpCount / matchCount) * 100) : 50;
    const gapDownProb = 100 - gapUpProb;
    const gapFillProb = matchCount > 0 ? Math.round((gapFilledCount / matchCount) * 100) : 50;

    const thresh = thresholds[ticker] || thresholds.SPY;
    const highConf = Math.max(gapUpProb, gapDownProb);
    const meetsThreshold = matchCount >= thresh.minMatches && highConf >= thresh.minConfidence;

    let prediction = 'UNCERTAIN';
    if (meetsThreshold) {
        prediction = gapUpProb > gapDownProb ? 'GAP_UP' : 'GAP_DOWN';
    }

    const nextDayOfWeek = dayNames[new Date(timestamps[targetIdx + 1] * 1000).getDay()];

    return {
        date: new Date(timestamps[targetIdx] * 1000).toLocaleDateString(),
        nextDayWeekday: nextDayOfWeek,
        matchCount,
        gapUpProb,
        gapDownProb,
        gapFillProb,
        prediction,
        meetsThreshold
    };
}

async function backtest(ticker = 'SPY', daysBack = 126) { // 6 months = ~126 trading days
    console.log(`\n${'='.repeat(60)}`);
    console.log(`BACKTESTING: ${ticker} - Last ${daysBack} trading days (~6 months)`);
    console.log(`Thresholds: ${thresholds[ticker].minMatches} matches, ${thresholds[ticker].minConfidence}% confidence`);
    console.log(`${'='.repeat(60)}\n`);

    const data = await fetchYahooChart(ticker, '2y', '1d'); // Need 2y for 6mo backtest with 1y lookback

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

    let correct = 0, wrong = 0, uncertain = 0;
    const weekdayResults = {
        Mon: { correct: 0, wrong: 0, uncertain: 0 },
        Tue: { correct: 0, wrong: 0, uncertain: 0 },
        Wed: { correct: 0, wrong: 0, uncertain: 0 },
        Thu: { correct: 0, wrong: 0, uncertain: 0 },
        Fri: { correct: 0, wrong: 0, uncertain: 0 }
    };
    const last30 = { correct: 0, wrong: 0, uncertain: 0 };

    const results = [];

    for (let i = lastIdx - daysBack; i < lastIdx; i++) {
        const prediction = predictDay(closes, opens, highs, lows, volumes, timestamps, i, ticker);
        if (!prediction) continue;

        const nextOpen = opens[i + 1];
        const thisClose = closes[i];
        const actualGap = nextOpen > thisClose ? 'GAP_UP' : 'GAP_DOWN';

        let resultStr = 'N/A';
        const isLast30 = (lastIdx - i) <= 30;

        if (prediction.prediction === 'UNCERTAIN') {
            uncertain++;
            if (weekdayResults[prediction.nextDayWeekday]) weekdayResults[prediction.nextDayWeekday].uncertain++;
            if (isLast30) last30.uncertain++;
            resultStr = '🟡 UNCERTAIN';
        } else if (prediction.prediction === actualGap) {
            correct++;
            if (weekdayResults[prediction.nextDayWeekday]) weekdayResults[prediction.nextDayWeekday].correct++;
            if (isLast30) last30.correct++;
            resultStr = '✅ CORRECT';
        } else {
            wrong++;
            if (weekdayResults[prediction.nextDayWeekday]) weekdayResults[prediction.nextDayWeekday].wrong++;
            if (isLast30) last30.wrong++;
            resultStr = '❌ WRONG';
        }

        // Only show last 20 results in detail
        if (results.length < 20 || (lastIdx - i) <= 20) {
            results.push({
                date: prediction.date,
                weekday: prediction.nextDayWeekday,
                matches: prediction.matchCount,
                pred: prediction.prediction,
                actual: actualGap,
                result: resultStr,
                probs: `${prediction.gapUpProb}/${prediction.gapDownProb}`,
                fill: `${prediction.gapFillProb}%`
            });
        }
    }

    // Print last 20 results
    console.log('LAST 20 PREDICTIONS:');
    console.log('-'.repeat(100));
    console.log('DATE        | DAY | MATCHES | PREDICTION  | ACTUAL    | RESULT       | PROBS    | GAP FILL');
    console.log('-'.repeat(100));

    for (const r of results.slice(-20)) {
        console.log(
            `${r.date.padEnd(11)} | ${r.weekday} | ${String(r.matches).padEnd(7)} | ${r.pred.padEnd(11)} | ${r.actual.padEnd(9)} | ${r.result.padEnd(12)} | ${r.probs.padEnd(8)} | ${r.fill}`
        );
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('OVERALL SUMMARY (6 MONTHS)');
    console.log(`${'='.repeat(60)}`);

    const total = correct + wrong;
    console.log(`\nTotal Calls Made: ${total} out of ${daysBack} days`);
    console.log(`  ✅ Correct: ${correct} (${total > 0 ? ((correct/total)*100).toFixed(1) : 0}%)`);
    console.log(`  ❌ Wrong: ${wrong} (${total > 0 ? ((wrong/total)*100).toFixed(1) : 0}%)`);
    console.log(`  🟡 Uncertain (no call): ${uncertain}`);

    // Last 30 days
    const last30Total = last30.correct + last30.wrong;
    console.log(`\n--- LAST 30 TRADING DAYS ---`);
    console.log(`  Calls Made: ${last30Total}`);
    console.log(`  ✅ Correct: ${last30.correct} (${last30Total > 0 ? ((last30.correct/last30Total)*100).toFixed(1) : 0}%)`);
    console.log(`  ❌ Wrong: ${last30.wrong}`);
    console.log(`  🟡 Uncertain: ${last30.uncertain}`);

    // Weekday breakdown
    console.log(`\n--- BY WEEKDAY ---`);
    for (const [day, stats] of Object.entries(weekdayResults)) {
        const dayTotal = stats.correct + stats.wrong;
        const pct = dayTotal > 0 ? ((stats.correct/dayTotal)*100).toFixed(0) : '-';
        console.log(`  ${day}: ${stats.correct}/${dayTotal} correct (${pct}%) | ${stats.uncertain} uncertain`);
    }

    console.log('\n');
    return { ticker, correct, wrong, uncertain, total, accuracy: total > 0 ? (correct/total)*100 : 0 };
}

// Run backtests
(async () => {
    const spyResults = await backtest('SPY', 126);
    const qqqResults = await backtest('QQQ', 126);
    const iwmResults = await backtest('IWM', 126);

    console.log('='.repeat(60));
    console.log('FINAL COMPARISON');
    console.log('='.repeat(60));
    console.log(`\nSPY: ${spyResults.correct}/${spyResults.total} = ${spyResults.accuracy.toFixed(1)}% (${spyResults.uncertain} uncertain)`);
    console.log(`QQQ: ${qqqResults.correct}/${qqqResults.total} = ${qqqResults.accuracy.toFixed(1)}% (${qqqResults.uncertain} uncertain)`);
    console.log(`IWM: ${iwmResults.correct}/${iwmResults.total} = ${iwmResults.accuracy.toFixed(1)}% (${iwmResults.uncertain} uncertain)`);
    console.log('\n');
})();
