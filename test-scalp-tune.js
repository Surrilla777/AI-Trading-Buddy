/**
 * Test script to tune scalp signal detection to match IMG_2066
 * Expected signals:
 * - 4 SHORTS at double-top ~$698-700
 * - 3-4 LONGS at lows ~$686-692 (user drew green circles)
 */

const fs = require('fs');

// Fetch data - configurable interval and range
async function fetchData(ticker = 'SPY', range = '5d', interval = '5m') {
    const response = await fetch(`http://localhost:3000/api/yahoo?ticker=${ticker}&type=chart&interval=${interval}&range=${range}`);
    const data = await response.json();
    return data;
}

function analyzeData(data, dateFilter = null) {
    if (!data.chart?.result?.[0]) {
        console.log('No data');
        return;
    }

    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];

    let candles = timestamps.map((t, i) => ({
        time: t,
        open: quotes.open[i],
        high: quotes.high[i],
        low: quotes.low[i],
        close: quotes.close[i],
        volume: quotes.volume[i]
    })).filter(c => c.open && c.high && c.low && c.close);

    // Filter by date if specified
    if (dateFilter) {
        candles = candles.filter(c => {
            const date = new Date(c.time * 1000);
            const dateStr = date.toISOString().split('T')[0];
            return dateStr === dateFilter;
        });
        console.log(`Filtered to ${dateFilter}: ${candles.length} candles`);
    } else {
        console.log(`Total candles: ${candles.length}`);
    }

    // Calculate key levels (PDH, PDL, PMH, PML)
    const days = {};
    candles.forEach(c => {
        const date = new Date(c.time * 1000);
        const dayKey = date.toISOString().split('T')[0];
        const hour = date.getHours();
        const min = date.getMinutes();
        const isPremarket = hour < 9 || (hour === 9 && min < 30);
        const isRegular = (hour === 9 && min >= 30) || (hour >= 10 && hour < 16);

        if (!days[dayKey]) days[dayKey] = { premarket: [], regular: [] };
        if (isPremarket) days[dayKey].premarket.push(c);
        else if (isRegular) days[dayKey].regular.push(c);
    });

    const dayKeys = Object.keys(days).sort();
    console.log('Days:', dayKeys);

    // Get yesterday's levels
    const today = dayKeys[dayKeys.length - 1];
    const yesterday = dayKeys[dayKeys.length - 2];

    const levels = {
        PDH: days[yesterday]?.regular.length ? Math.max(...days[yesterday].regular.map(c => c.high)) : null,
        PDL: days[yesterday]?.regular.length ? Math.min(...days[yesterday].regular.map(c => c.low)) : null,
        PMH: days[today]?.premarket.length ? Math.max(...days[today].premarket.map(c => c.high)) : null,
        PML: days[today]?.premarket.length ? Math.min(...days[today].premarket.map(c => c.low)) : null
    };

    console.log('Key levels:', levels);

    // Find price extremes in the data
    const allHighs = candles.map(c => c.high);
    const allLows = candles.map(c => c.low);
    console.log(`Price range: $${Math.min(...allLows).toFixed(2)} - $${Math.max(...allHighs).toFixed(2)}`);

    // Analyze where the swing highs/lows are
    console.log('\n=== SWING ANALYSIS ===');

    // Find all local maxima (swing highs) - peaks where price > neighbors
    const swingHighs = [];
    const swingLows = [];

    for (let i = 10; i < candles.length - 10; i++) {
        const leftMax = Math.max(...candles.slice(i - 10, i).map(c => c.high));
        const rightMax = Math.max(...candles.slice(i + 1, i + 11).map(c => c.high));
        const leftMin = Math.min(...candles.slice(i - 10, i).map(c => c.low));
        const rightMin = Math.min(...candles.slice(i + 1, i + 11).map(c => c.low));

        // Swing high: current high is highest in 20-bar window
        if (candles[i].high >= leftMax && candles[i].high >= rightMax) {
            swingHighs.push({
                idx: i,
                time: new Date(candles[i].time * 1000).toLocaleString(),
                high: candles[i].high,
                close: candles[i].close,
                isRed: candles[i].close < candles[i].open
            });
        }

        // Swing low: current low is lowest in 20-bar window
        if (candles[i].low <= leftMin && candles[i].low <= rightMin) {
            swingLows.push({
                idx: i,
                time: new Date(candles[i].time * 1000).toLocaleString(),
                low: candles[i].low,
                close: candles[i].close,
                isGreen: candles[i].close > candles[i].open
            });
        }
    }

    console.log('\nSWING HIGHS (potential shorts):');
    swingHighs.slice(-15).forEach(sh => {
        console.log(`  ${sh.time}: High $${sh.high.toFixed(2)}, Close $${sh.close.toFixed(2)}, ${sh.isRed ? 'RED' : 'GREEN'}`);
    });

    console.log('\nSWING LOWS (potential longs):');
    swingLows.slice(-15).forEach(sl => {
        console.log(`  ${sl.time}: Low $${sl.low.toFixed(2)}, Close $${sl.close.toFixed(2)}, ${sl.isGreen ? 'GREEN' : 'RED'}`);
    });

    // Now test the IMPROVED detection algorithm (matches index.html)
    console.log('\n=== TESTING NEW DETECTION ===');

    const signals = [];
    const avgVolumes = [];

    // Pre-calculate 20-bar average volumes
    for (let i = 0; i < candles.length; i++) {
        if (i < 20) {
            avgVolumes.push(candles.slice(0, i + 1).reduce((s, c) => s + c.volume, 0) / (i + 1));
        } else {
            avgVolumes.push(candles.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20);
        }
    }

    // Helper: near level check
    const nearLevel = (price, level, tolerance = 0.003) => {
        if (!level) return false;
        return Math.abs(price - level) / level < tolerance;
    };

    // Track last signal indices and prices
    let lastLongIdx = -20;
    let lastShortIdx = -20;
    let lastShortHigh = 0; // Track highest short level

    // 12-bar lookahead for major swings
    for (let i = 20; i < candles.length - 12; i++) {
        const c = candles[i];
        const prev = candles[i - 1];

        // Check 24-bar window for TRUE swing points (12 before, 12 after)
        const left12 = candles.slice(i - 12, i);
        const right12 = candles.slice(i + 1, i + 13);

        const leftMaxHigh = Math.max(...left12.map(x => x.high));
        const rightMaxHigh = Math.max(...right12.map(x => x.high));
        const leftMinLow = Math.min(...left12.map(x => x.low));
        const rightMinLow = Math.min(...right12.map(x => x.low));

        const isSwingHigh = c.high >= leftMaxHigh && c.high >= rightMaxHigh;
        const isSwingLow = c.low <= leftMinLow && c.low <= rightMinLow;

        // Calculate overall chart range to filter consolidation signals
        const overallHigh = Math.max(...candles.map(x => x.high));
        const overallLow = Math.min(...candles.map(x => x.low));
        const overallRange = overallHigh - overallLow;

        // Zone filters - relaxed for volatile stocks
        const pricePosition = (c.close - overallLow) / overallRange;
        const atTopZone = pricePosition > 0.55; // Top 45%
        const atBottomZone = pricePosition < 0.45; // Bottom 45%

        // Candle patterns
        const isGreen = c.close > c.open;
        const isRed = c.close < c.open;

        // Wick patterns
        const body = Math.abs(c.close - c.open);
        const topWick = c.high - Math.max(c.open, c.close);
        const bottomWick = Math.min(c.open, c.close) - c.low;
        const hasTopWick = topWick > body * 0.4;
        const hasBottomWick = bottomWick > body * 0.4;

        // Volume
        const hasVolume = c.volume > avgVolumes[i] * 1.3;

        // Key level checks (for adding context)
        const atPDL = nearLevel(c.low, levels.PDL);
        const atPMH = nearLevel(c.high, levels.PMH);

        // ==========================================
        // LONG SIGNAL: At TRUE swing lows in BOTTOM ZONE with reversal confirmation
        // ==========================================
        const longCooldownOk = (i - lastLongIdx) >= 12; // 60 min cooldown

        // Check next candle for confirmation (if available)
        const nextCandle = candles[i + 1];
        const nextIsGreen = nextCandle && nextCandle.close > nextCandle.open;

        // Accept: green candle, OR red with next green confirmation, OR strong hammer wick
        const strongHammer = hasBottomWick && (c.low <= leftMinLow * 1.001);
        const longPattern = isGreen || nextIsGreen || strongHammer;

        // TRUE swing lows need EITHER: significant depth OR at key support level
        // Calculate swing depth (how far price dropped from recent high)
        const recentHigh = Math.max(...candles.slice(Math.max(0, i - 20), i).map(x => x.high));
        const swingDepth = (recentHigh - c.low) / recentHigh;
        const isSignificantDepth = swingDepth > 0.008; // At least 0.8% drop = major reversal

        // Check if at key SUPPORT level (PDL, PDH, or PML as support) - tight tolerance
        const atSupportLevel = nearLevel(c.low, levels.PDL, 0.0015) ||
                               nearLevel(c.low, levels.PDH, 0.0015) ||
                               nearLevel(c.low, levels.PML, 0.0015);

        // Swing low with reversal pattern AND (significant depth OR at support) = long signal
        if (isSwingLow && longPattern && longCooldownOk && (isSignificantDepth || atSupportLevel)) {
            const reasons = ['SwingLow'];
            if (atPDL) reasons.push('PDL');
            if (hasBottomWick) reasons.push('Wick');
            if (hasVolume) reasons.push('Vol');
            if (nextIsGreen && !isGreen) reasons.push('NextGreen');

            signals.push({
                type: 'LONG',
                idx: i,
                time: new Date(c.time * 1000).toLocaleString(),
                price: c.close,
                low: c.low,
                reason: reasons.join('+')
            });
            lastLongIdx = i;
        }

        // ==========================================
        // SHORT SIGNAL: At TRUE swing highs with rejection (TOP ZONE + NEW HIGH ONLY)
        // ==========================================
        const shortCooldownOk = (i - lastShortIdx) >= 20; // 100 min cooldown (stricter)

        // Accept red candle OR green candle with significant top wick (rejection)
        const hasRejectionWick = hasTopWick;
        const shortPattern = isRed || hasRejectionWick;

        // Require swing high in TOP ZONE (>90%) to avoid consolidation shorts
        const inTopZone = pricePosition > 0.90;

        // Only short at NEW highs (equal or higher than last short) to avoid consolidation
        const isNewHigh = c.high >= lastShortHigh * 0.998; // Allow 0.2% tolerance

        // Swing high with rejection pattern in top zone at new high = short signal
        if (isSwingHigh && shortPattern && shortCooldownOk && inTopZone && isNewHigh) {
            const reasons = ['SwingHigh'];
            if (atPMH) reasons.push('PMH');
            if (hasTopWick) reasons.push('Wick');
            if (hasVolume) reasons.push('Vol');

            signals.push({
                type: 'SHORT',
                idx: i,
                time: new Date(c.time * 1000).toLocaleString(),
                price: c.close,
                high: c.high,
                reason: reasons.join('+')
            });
            lastShortIdx = i;
            lastShortHigh = c.high; // Track this high for next comparison
        }
    }

    console.log(`\nDetected ${signals.length} signals:`);
    signals.forEach((s, i) => {
        if (s.type === 'SHORT') {
            console.log(`${i + 1}. ${s.type} @ $${s.price.toFixed(2)} (High: $${s.high.toFixed(2)}) - ${s.time}`);
        } else {
            console.log(`${i + 1}. ${s.type} @ $${s.price.toFixed(2)} (Low: $${s.low.toFixed(2)}) - ${s.time}`);
        }
        console.log(`   Reason: ${s.reason}`);
    });

    // Summary
    const shortSignals = signals.filter(s => s.type === 'SHORT');
    const longSignals = signals.filter(s => s.type === 'LONG');
    console.log(`\n=== SIGNAL SUMMARY ===`);
    console.log(`Total: ${signals.length} (${shortSignals.length} shorts, ${longSignals.length} longs)`);

    // Backtest: Check returns after 5, 10, 20 candles
    console.log('\n=== BACKTEST RESULTS ===');
    const backtestResults = signals.map(sig => {
        const entryIdx = sig.idx;
        const exit5 = candles[entryIdx + 5];
        const exit10 = candles[entryIdx + 10];
        const exit20 = candles[entryIdx + 20];

        const calc = (exit) => exit ? ((exit.close - sig.price) / sig.price) * 100 : null;
        const r5 = calc(exit5);
        const r10 = calc(exit10);
        const r20 = calc(exit20);

        // For longs: positive = win. For shorts: negative = win.
        const isWin = (ret, type) => type === 'LONG' ? ret > 0 : ret < 0;

        return {
            ...sig,
            r5, r10, r20,
            win5: r5 !== null ? isWin(r5, sig.type) : null,
            win10: r10 !== null ? isWin(r10, sig.type) : null,
            win20: r20 !== null ? isWin(r20, sig.type) : null
        };
    });

    // Calculate win rates
    const calcWinRate = (results, winKey) => {
        const valid = results.filter(r => r[winKey] !== null);
        if (valid.length === 0) return { winRate: 0, count: 0 };
        const wins = valid.filter(r => r[winKey]).length;
        return { winRate: ((wins / valid.length) * 100).toFixed(1), count: valid.length };
    };

    const longResults = backtestResults.filter(r => r.type === 'LONG');
    const shortResults = backtestResults.filter(r => r.type === 'SHORT');

    console.log('LONGS:');
    console.log(`  25min (5 bars): ${calcWinRate(longResults, 'win5').winRate}% win rate (n=${calcWinRate(longResults, 'win5').count})`);
    console.log(`  50min (10 bars): ${calcWinRate(longResults, 'win10').winRate}% win rate (n=${calcWinRate(longResults, 'win10').count})`);
    console.log(`  100min (20 bars): ${calcWinRate(longResults, 'win20').winRate}% win rate (n=${calcWinRate(longResults, 'win20').count})`);

    console.log('SHORTS:');
    console.log(`  25min (5 bars): ${calcWinRate(shortResults, 'win5').winRate}% win rate (n=${calcWinRate(shortResults, 'win5').count})`);
    console.log(`  50min (10 bars): ${calcWinRate(shortResults, 'win10').winRate}% win rate (n=${calcWinRate(shortResults, 'win10').count})`);
    console.log(`  100min (20 bars): ${calcWinRate(shortResults, 'win20').winRate}% win rate (n=${calcWinRate(shortResults, 'win20').count})`);

    // Show individual signal results
    console.log('\n=== INDIVIDUAL RESULTS (last 10) ===');
    backtestResults.slice(-10).forEach(r => {
        const win5 = r.win5 !== null ? (r.win5 ? 'WIN' : 'LOSS') : 'N/A';
        const ret5 = r.r5 !== null ? (r.r5 > 0 ? '+' : '') + r.r5.toFixed(2) + '%' : 'N/A';
        console.log(`${r.type} @ $${r.price.toFixed(2)}: 25min ${ret5} (${win5})`);
    });

    return { signals, backtestResults };
}

async function main() {
    // Get ticker, date filter, range, and interval from command line args
    const ticker = process.argv[2] || 'SPY';
    const dateFilter = process.argv[3] || null; // e.g., '2025-12-31'
    const range = process.argv[4] || '1mo'; // '5d' for app-like view, '1mo' for backtest
    const interval = process.argv[5] || '5m'; // '5m', '15m', or '1m'

    console.log(`Fetching ${ticker} ${interval} data (${range})...\n`);
    if (dateFilter) console.log(`Filtering for date: ${dateFilter}\n`);

    const data = await fetchData(ticker, range, interval);
    analyzeData(data, dateFilter);
}

main().catch(console.error);
