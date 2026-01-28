// Backtest the Next Day Prediction v3 algorithm
// - Gap-fill focus with size bucketing
// - v3 thresholds: SPY 65%/30, QQQ/IWM 70%/50
// - Fill rates by gap size and weekday
// - Fade win rate tracking
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

// v3 Thresholds
const thresholds = {
    SPY: { minMatches: 30, minConfidence: 65 },
    QQQ: { minMatches: 50, minConfidence: 70 },
    IWM: { minMatches: 50, minConfidence: 70 }
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

    // Historical pattern matching with gap buckets
    let gapUpCount = 0, gapDownCount = 0, gapFilledCount = 0, fadeWinCount = 0, matchCount = 0;
    const gapBuckets = { small: {total:0,filled:0,fade:0}, medium: {total:0,filled:0,fade:0}, large: {total:0,filled:0,fade:0} };
    const weekdayFills = { Mon: {total:0,filled:0}, Tue: {total:0,filled:0}, Wed: {total:0,filled:0}, Thu: {total:0,filled:0}, Fri: {total:0,filled:0} };
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
            const nextClose = closes[i + 1];
            const thisClose = closes[i];

            const gappedUp = nextOpen > thisClose;
            const gapPct = Math.abs((nextOpen - thisClose) / thisClose) * 100;
            const gapFilled = gappedUp ? (nextLow <= thisClose) : (nextHigh >= thisClose);

            // Fade = gap reversed (close opposite of gap direction)
            const faded = gappedUp ? (nextClose < nextOpen) : (nextClose > nextOpen);

            if (gappedUp) gapUpCount++;
            else gapDownCount++;
            if (gapFilled) gapFilledCount++;
            if (faded) fadeWinCount++;

            // Bucket by gap size
            const bucket = gapPct < 0.3 ? 'small' : gapPct < 0.7 ? 'medium' : 'large';
            gapBuckets[bucket].total++;
            if (gapFilled) gapBuckets[bucket].filled++;
            if (faded) gapBuckets[bucket].fade++;

            // Weekday tracking
            const nextDayName = dayNames[new Date(timestamps[i + 1] * 1000).getDay()];
            if (weekdayFills[nextDayName]) {
                weekdayFills[nextDayName].total++;
                if (gapFilled) weekdayFills[nextDayName].filled++;
            }
        }
    }

    const gapUpProb = matchCount > 0 ? Math.round((gapUpCount / matchCount) * 100) : 50;
    const gapDownProb = 100 - gapUpProb;
    const gapFillProb = matchCount > 0 ? Math.round((gapFilledCount / matchCount) * 100) : 50;
    const fadeWinRate = matchCount > 0 ? Math.round((fadeWinCount / matchCount) * 100) : 50;

    const thresh = thresholds[ticker] || thresholds.SPY;
    const highConf = Math.max(gapUpProb, gapDownProb);
    const meetsThreshold = matchCount >= thresh.minMatches && highConf >= thresh.minConfidence;

    let prediction = 'UNCERTAIN';
    if (meetsThreshold) {
        prediction = gapUpProb > gapDownProb ? 'GAP_UP' : 'GAP_DOWN';
    }

    const nextDayOfWeek = dayNames[new Date(timestamps[targetIdx + 1] * 1000).getDay()];
    const gapFillConviction = gapFillProb >= 75 ? 'HIGH' : gapFillProb >= 65 ? 'MEDIUM' : 'LOW';

    // Calculate bucket fill rates
    const bucketFillRates = {};
    for (const [bucket, stats] of Object.entries(gapBuckets)) {
        bucketFillRates[bucket] = stats.total > 0 ? Math.round((stats.filled / stats.total) * 100) : 0;
    }

    return {
        date: new Date(timestamps[targetIdx] * 1000).toLocaleDateString(),
        nextDayWeekday: nextDayOfWeek,
        matchCount,
        gapUpProb,
        gapDownProb,
        gapFillProb,
        fadeWinRate,
        gapFillConviction,
        prediction,
        meetsThreshold,
        bucketFillRates,
        weekdayFills
    };
}

async function backtest(ticker = 'SPY', daysBack = 252) { // 1 year = ~252 trading days
    console.log(`\n${'='.repeat(70)}`);
    console.log(`BACKTESTING v3: ${ticker} - Last ${daysBack} trading days (~1 year)`);
    console.log(`Thresholds: ${thresholds[ticker].minMatches} matches, ${thresholds[ticker].minConfidence}% confidence`);
    console.log(`${'='.repeat(70)}\n`);

    const data = await fetchYahooChart(ticker, '2y', '1d');

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

    // Direction accuracy
    let dirCorrect = 0, dirWrong = 0, uncertain = 0;
    // Fill accuracy (did we correctly predict high fill prob AND it filled)
    let fillCorrect = 0, fillWrong = 0, fillTotal = 0;
    // Fade win rate tracking
    let fadeAttempts = 0, fadeWins = 0;

    const weekdayResults = {
        Mon: { dirCorrect: 0, dirTotal: 0, fillCorrect: 0, fillTotal: 0 },
        Tue: { dirCorrect: 0, dirTotal: 0, fillCorrect: 0, fillTotal: 0 },
        Wed: { dirCorrect: 0, dirTotal: 0, fillCorrect: 0, fillTotal: 0 },
        Thu: { dirCorrect: 0, dirTotal: 0, fillCorrect: 0, fillTotal: 0 },
        Fri: { dirCorrect: 0, dirTotal: 0, fillCorrect: 0, fillTotal: 0 }
    };
    const last30 = { dirCorrect: 0, dirWrong: 0, uncertain: 0, fillCorrect: 0, fillTotal: 0 };

    const results = [];

    for (let i = lastIdx - daysBack; i < lastIdx; i++) {
        const prediction = predictDay(closes, opens, highs, lows, volumes, timestamps, i, ticker);
        if (!prediction) continue;

        const nextOpen = opens[i + 1];
        const nextHigh = highs[i + 1];
        const nextLow = lows[i + 1];
        const nextClose = closes[i + 1];
        const thisClose = closes[i];

        const actualGap = nextOpen > thisClose ? 'GAP_UP' : 'GAP_DOWN';
        const gapPct = Math.abs((nextOpen - thisClose) / thisClose) * 100;
        const actualFilled = actualGap === 'GAP_UP' ? (nextLow <= thisClose) : (nextHigh >= thisClose);
        const actualFaded = actualGap === 'GAP_UP' ? (nextClose < nextOpen) : (nextClose > nextOpen);

        const isLast30 = (lastIdx - i) <= 30;

        // Direction scoring
        let dirResult = 'N/A';
        if (prediction.prediction === 'UNCERTAIN') {
            uncertain++;
            if (isLast30) last30.uncertain++;
            dirResult = '🟡 UNCERTAIN';
        } else if (prediction.prediction === actualGap) {
            dirCorrect++;
            if (weekdayResults[prediction.nextDayWeekday]) {
                weekdayResults[prediction.nextDayWeekday].dirCorrect++;
                weekdayResults[prediction.nextDayWeekday].dirTotal++;
            }
            if (isLast30) last30.dirCorrect++;
            dirResult = '✅ DIR OK';
        } else {
            dirWrong++;
            if (weekdayResults[prediction.nextDayWeekday]) {
                weekdayResults[prediction.nextDayWeekday].dirTotal++;
            }
            if (isLast30) last30.dirWrong++;
            dirResult = '❌ DIR WRONG';
        }

        // Fill scoring (only when prediction was HIGH conviction for fill)
        let fillResult = '-';
        if (prediction.gapFillConviction === 'HIGH') {
            fillTotal++;
            if (weekdayResults[prediction.nextDayWeekday]) {
                weekdayResults[prediction.nextDayWeekday].fillTotal++;
            }
            if (isLast30) last30.fillTotal++;

            if (actualFilled) {
                fillCorrect++;
                if (weekdayResults[prediction.nextDayWeekday]) {
                    weekdayResults[prediction.nextDayWeekday].fillCorrect++;
                }
                if (isLast30) last30.fillCorrect++;
                fillResult = '✅ FILLED';
            } else {
                fillWrong++;
                fillResult = '❌ NO FILL';
            }
        }

        // Fade tracking (when we predict high fill prob)
        if (prediction.gapFillProb >= 65) {
            fadeAttempts++;
            if (actualFaded) fadeWins++;
        }

        // Store last 25 results
        if ((lastIdx - i) <= 25) {
            results.push({
                date: prediction.date,
                weekday: prediction.nextDayWeekday,
                matches: prediction.matchCount,
                pred: prediction.prediction,
                actual: actualGap,
                dirResult,
                fillProb: prediction.gapFillProb,
                fillConv: prediction.gapFillConviction,
                filled: actualFilled ? 'YES' : 'NO',
                fillResult,
                fadeWin: prediction.fadeWinRate,
                gapSize: gapPct.toFixed(2) + '%'
            });
        }
    }

    // Print last 25 results
    console.log('LAST 25 PREDICTIONS:');
    console.log('-'.repeat(120));
    console.log('DATE        | DAY | MATCH | PRED       | ACTUAL    | DIR      | FILL% | CONV  | ACTUAL | FILL RES   | GAP');
    console.log('-'.repeat(120));

    for (const r of results.slice(-25)) {
        console.log(
            `${r.date.padEnd(11)} | ${r.weekday} | ${String(r.matches).padEnd(5)} | ${r.pred.padEnd(10)} | ${r.actual.padEnd(9)} | ${r.dirResult.padEnd(8)} | ${String(r.fillProb).padEnd(5)} | ${r.fillConv.padEnd(5)} | ${r.filled.padEnd(6)} | ${r.fillResult.padEnd(10)} | ${r.gapSize}`
        );
    }

    // Summary
    console.log(`\n${'='.repeat(70)}`);
    console.log('OVERALL SUMMARY (1 YEAR)');
    console.log(`${'='.repeat(70)}`);

    const dirTotal = dirCorrect + dirWrong;
    console.log(`\n📊 DIRECTION PREDICTIONS (when call was made):`);
    console.log(`  Total Calls: ${dirTotal} out of ${daysBack} days`);
    console.log(`  ✅ Correct: ${dirCorrect} (${dirTotal > 0 ? ((dirCorrect/dirTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  ❌ Wrong: ${dirWrong}`);
    console.log(`  🟡 No Call: ${uncertain}`);

    console.log(`\n🎯 GAP FILL PREDICTIONS (when HIGH conviction):`);
    console.log(`  Total HIGH Fill Predictions: ${fillTotal}`);
    console.log(`  ✅ Actually Filled: ${fillCorrect} (${fillTotal > 0 ? ((fillCorrect/fillTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  ❌ Did Not Fill: ${fillWrong}`);

    console.log(`\n📈 FADE STRATEGY (when fill prob >= 65%):`);
    console.log(`  Fade Attempts: ${fadeAttempts}`);
    console.log(`  Fade Wins: ${fadeWins} (${fadeAttempts > 0 ? ((fadeWins/fadeAttempts)*100).toFixed(1) : 0}%)`);

    // Last 30 days
    const last30DirTotal = last30.dirCorrect + last30.dirWrong;
    console.log(`\n--- LAST 30 TRADING DAYS ---`);
    console.log(`  Direction: ${last30.dirCorrect}/${last30DirTotal} (${last30DirTotal > 0 ? ((last30.dirCorrect/last30DirTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  HIGH Fill Accuracy: ${last30.fillCorrect}/${last30.fillTotal} (${last30.fillTotal > 0 ? ((last30.fillCorrect/last30.fillTotal)*100).toFixed(1) : 0}%)`);
    console.log(`  No Call: ${last30.uncertain}`);

    // Weekday breakdown
    console.log(`\n--- BY WEEKDAY ---`);
    for (const [day, stats] of Object.entries(weekdayResults)) {
        const dirPct = stats.dirTotal > 0 ? ((stats.dirCorrect/stats.dirTotal)*100).toFixed(0) : '-';
        const fillPct = stats.fillTotal > 0 ? ((stats.fillCorrect/stats.fillTotal)*100).toFixed(0) : '-';
        console.log(`  ${day}: Dir ${stats.dirCorrect}/${stats.dirTotal} (${dirPct}%) | HIGH Fill ${stats.fillCorrect}/${stats.fillTotal} (${fillPct}%)`);
    }

    console.log('\n');
    return {
        ticker,
        dirCorrect, dirWrong, dirTotal, uncertain,
        fillCorrect, fillWrong, fillTotal,
        fadeWins, fadeAttempts,
        dirAccuracy: dirTotal > 0 ? (dirCorrect/dirTotal)*100 : 0,
        fillAccuracy: fillTotal > 0 ? (fillCorrect/fillTotal)*100 : 0,
        fadeWinRate: fadeAttempts > 0 ? (fadeWins/fadeAttempts)*100 : 0
    };
}

// Run backtests
(async () => {
    const spyResults = await backtest('SPY', 252);
    const qqqResults = await backtest('QQQ', 252);
    const iwmResults = await backtest('IWM', 252);

    console.log('='.repeat(70));
    console.log('FINAL COMPARISON - v3 BACKTEST');
    console.log('='.repeat(70));

    console.log('\n📊 DIRECTION ACCURACY:');
    console.log(`  SPY: ${spyResults.dirCorrect}/${spyResults.dirTotal} = ${spyResults.dirAccuracy.toFixed(1)}% (${spyResults.uncertain} no call)`);
    console.log(`  QQQ: ${qqqResults.dirCorrect}/${qqqResults.dirTotal} = ${qqqResults.dirAccuracy.toFixed(1)}% (${qqqResults.uncertain} no call)`);
    console.log(`  IWM: ${iwmResults.dirCorrect}/${iwmResults.dirTotal} = ${iwmResults.dirAccuracy.toFixed(1)}% (${iwmResults.uncertain} no call)`);

    console.log('\n🎯 HIGH FILL CONVICTION ACCURACY:');
    console.log(`  SPY: ${spyResults.fillCorrect}/${spyResults.fillTotal} = ${spyResults.fillAccuracy.toFixed(1)}%`);
    console.log(`  QQQ: ${qqqResults.fillCorrect}/${qqqResults.fillTotal} = ${qqqResults.fillAccuracy.toFixed(1)}%`);
    console.log(`  IWM: ${iwmResults.fillCorrect}/${iwmResults.fillTotal} = ${iwmResults.fillAccuracy.toFixed(1)}%`);

    console.log('\n📈 FADE WIN RATE (fill prob >= 65%):');
    console.log(`  SPY: ${spyResults.fadeWins}/${spyResults.fadeAttempts} = ${spyResults.fadeWinRate.toFixed(1)}%`);
    console.log(`  QQQ: ${qqqResults.fadeWins}/${qqqResults.fadeAttempts} = ${qqqResults.fadeWinRate.toFixed(1)}%`);
    console.log(`  IWM: ${iwmResults.fadeWins}/${iwmResults.fadeAttempts} = ${iwmResults.fadeWinRate.toFixed(1)}%`);

    console.log('\n');
})();
