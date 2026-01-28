const https = require('https');

const ticker = process.argv[2] || 'LPTH';
const timeframe = process.argv[3] || 'daily';  // 'daily' or 'weekly'

const isWeekly = timeframe.toLowerCase() === 'weekly' || timeframe.toLowerCase() === 'w';
const interval = isWeekly ? '1wk' : '1d';
const range = isWeekly ? '1y' : '6mo';
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;

console.log(`\n=== ROCKET SCANNER BACKTEST: ${ticker} (${isWeekly ? 'WEEKLY' : 'DAILY'}) ===\n`);

https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);

            if (json.chart?.error) {
                console.log('API Error:', json.chart.error.description);
                return;
            }

            const result = json.chart?.result?.[0];
            if (!result) {
                console.log('No data returned');
                return;
            }

            const timestamps = result.timestamp;
            const quotes = result.indicators.quote[0];
            const closes = quotes.close;
            const volumes = quotes.volume;
            const highs = quotes.high;
            const lows = quotes.low;

            console.log(`Analyzing ${timestamps.length} ${isWeekly ? 'weeks' : 'days'} of data...`);
            if (isWeekly) {
                console.log(`Thresholds: Vol 2x+, RSI <30/>70, 8%+ moves, 20%+ momentum, 10%+ rejection/reclaim\n`);
            } else {
                console.log(`Thresholds: Vol 3x+, RSI <30/>70, 5%+ moves, 15%+ momentum\n`);
            }

            const signals = [];

            // Dynamic thresholds based on timeframe
            const VOL_THRESHOLD = isWeekly ? 1.5 : 3;
            const VOL_DIR_THRESHOLD = isWeekly ? 3 : 2;
            const BIG_MOVE_THRESHOLD = isWeekly ? 5 : 5;
            const MOMENTUM_THRESHOLD = isWeekly ? 15 : 15;
            const MOMENTUM_LOOKBACK = isWeekly ? 4 : 5;
            const REJECTION_THRESHOLD = 10; // High-to-Close drop % (weekly only)
            const RECLAIM_THRESHOLD = 10;   // Low-to-Close rise % (weekly only)

            // Check each period (start at 20 for weekly since we need less history)
            const startIndex = isWeekly ? 20 : 50;
            const endBuffer = isWeekly ? 1 : 5;  // Less buffer for weekly since we have fewer data points
            for (let i = startIndex; i < closes.length - endBuffer; i++) {
                if (!closes[i] || !volumes[i]) continue;

                const date = new Date(timestamps[i] * 1000);
                const currentPrice = closes[i];
                const prevClose = closes[i-1];
                const periodChange = ((currentPrice - prevClose) / prevClose) * 100;
                const high = highs[i];
                const low = lows[i];

                const bullishSignals = [];
                const bearishSignals = [];

                // 1. HIGH VOLUME
                const volLookback = isWeekly ? 10 : 20;
                const volSlice = volumes.slice(i-volLookback, i).filter(v => v);
                const avgVol = volSlice.reduce((a,b) => a+b, 0) / volSlice.length;
                const volRatio = volumes[i] / avgVol;
                if (volRatio >= VOL_THRESHOLD) {
                    if (periodChange > VOL_DIR_THRESHOLD) bullishSignals.push(`Vol${volRatio.toFixed(1)}x`);
                    else if (periodChange < -VOL_DIR_THRESHOLD) bearishSignals.push(`Vol${volRatio.toFixed(1)}x`);
                }

                // 2. RSI EXTREME - <30 or >70 with direction
                const rsiCloses = closes.slice(i-14, i+1).filter(c => c);
                let gains = 0, losses = 0;
                for (let j = 1; j < rsiCloses.length; j++) {
                    const change = rsiCloses[j] - rsiCloses[j-1];
                    if (change > 0) gains += change;
                    else losses -= change;
                }
                const rsi = 100 - (100 / (1 + (gains/14) / ((losses/14) || 0.001)));
                if (rsi < 30 && periodChange > 2) bullishSignals.push(`RSI${rsi.toFixed(0)}`);
                if (rsi > 70 && periodChange < -2) bearishSignals.push(`RSI${rsi.toFixed(0)}`);

                // 3. GOLDEN/DEATH CROSS
                const smaFast = isWeekly ? 10 : 20;
                const smaSlow = isWeekly ? 20 : 50;
                const smaFastVal = closes.slice(i-smaFast, i).filter(c => c).reduce((a,b) => a+b, 0) / smaFast;
                const smaSlowVal = closes.slice(i-smaSlow, i).filter(c => c).reduce((a,b) => a+b, 0) / smaSlow;
                const prevSmaFast = closes.slice(i-smaFast-1, i-1).filter(c => c).reduce((a,b) => a+b, 0) / smaFast;
                const prevSmaSlow = closes.slice(i-smaSlow-1, i-1).filter(c => c).reduce((a,b) => a+b, 0) / smaSlow;

                let hasGolden = false, hasDeath = false;
                if (smaFastVal > smaSlowVal && prevSmaFast <= prevSmaSlow) {
                    bullishSignals.push('Golden');
                    hasGolden = true;
                }
                if (smaFastVal < smaSlowVal && prevSmaFast >= prevSmaSlow) {
                    bearishSignals.push('Death');
                    hasDeath = true;
                }

                // 4. BIG MOVE
                if (periodChange >= BIG_MOVE_THRESHOLD) bullishSignals.push(`+${periodChange.toFixed(0)}%`);
                if (periodChange <= -BIG_MOVE_THRESHOLD) bearishSignals.push(`${periodChange.toFixed(0)}%`);

                // 5. STRONG MOMENTUM
                const priceAgo = closes[i-MOMENTUM_LOOKBACK];
                if (priceAgo) {
                    const momentum = ((currentPrice - priceAgo) / priceAgo) * 100;
                    if (momentum >= MOMENTUM_THRESHOLD) bullishSignals.push(`Mom+${momentum.toFixed(0)}%`);
                    if (momentum <= -MOMENTUM_THRESHOLD) bearishSignals.push(`Mom${momentum.toFixed(0)}%`);
                }

                // 6. BREAKOUT - period high with volume
                const lookbackPeriod = isWeekly ? 20 : 50;
                const recent50High = Math.max(...highs.slice(Math.max(0, i-lookbackPeriod), i).filter(h => h));
                if (currentPrice > recent50High && volRatio >= 2 && periodChange >= 3) {
                    bullishSignals.push(`Break${lookbackPeriod}`);
                }

                // 7. BREAKDOWN - period low with volume
                const recent50Low = Math.min(...lows.slice(Math.max(0, i-lookbackPeriod), i).filter(l => l));
                if (currentPrice < recent50Low && volRatio >= 2 && periodChange <= -3) {
                    bearishSignals.push(`Break${lookbackPeriod}`);
                }

                // 8. REJECTION - High-to-Close drop (NEW - mainly for weekly)
                if (high && currentPrice) {
                    const highToClose = ((currentPrice - high) / high) * 100;
                    if (highToClose <= -REJECTION_THRESHOLD) {
                        bearishSignals.push(`Reject${highToClose.toFixed(0)}%`);
                    }
                }

                // 9. RECLAIM - Low-to-Close rise (NEW - mainly for weekly)
                if (low && currentPrice) {
                    const lowToClose = ((currentPrice - low) / low) * 100;
                    if (lowToClose >= RECLAIM_THRESHOLD) {
                        bullishSignals.push(`Reclaim+${lowToClose.toFixed(0)}%`);
                    }
                }

                const bullScore = bullishSignals.length;
                const bearScore = bearishSignals.length;

                // Check for rejection/reclaim levels (weekly candles)
                let rejectPct = 0, reclaimPct = 0;
                if (high && currentPrice) {
                    rejectPct = ((currentPrice - high) / high) * 100;
                }
                if (low && currentPrice) {
                    reclaimPct = ((currentPrice - low) / low) * 100;
                }

                // ROCKET REQUIREMENTS:
                // - Golden/Death Cross + 1 other signal = ROCKET
                // - Mega Rejection/Reclaim (>20%) = ROCKET by itself (weekly only)
                // - Super Rejection/Reclaim (15-20%) + 1 other signal = ROCKET (weekly)
                // - OR 3+ regular signals = ROCKET
                const isGoldenRocket = hasGolden && bullScore >= 2;
                const isDeathRocket = hasDeath && bearScore >= 2;

                // Mega = fires by itself, Super = needs +1 signal
                const isMegaRejectRocket = isWeekly && rejectPct <= -18;
                const isMegaReclaimRocket = isWeekly && reclaimPct >= 18;
                const isSuperRejectRocket = isWeekly && rejectPct <= -12 && rejectPct > -18 && bearScore >= 2;
                const isSuperReclaimRocket = isWeekly && reclaimPct >= 12 && reclaimPct < 18 && bullScore >= 2;

                const isRegularBullRocket = !hasGolden && bullScore >= 3;
                const isRegularBearRocket = !hasDeath && bearScore >= 3;

                const isBullRocket = isGoldenRocket || isMegaReclaimRocket || isSuperReclaimRocket || isRegularBullRocket;
                const isBearRocket = isDeathRocket || isMegaRejectRocket || isSuperRejectRocket || isRegularBearRocket;

                if (isBullRocket || isBearRocket) {
                    const type = isBullRocket ? 'GREEN' : 'RED';
                    const sigs = isBullRocket ? bullishSignals : bearishSignals;

                    // Add the rejection/reclaim to signals if it triggered the rocket
                    if (isMegaRejectRocket || isSuperRejectRocket) {
                        if (!sigs.some(s => s.includes('Reject'))) sigs.push(`Reject${rejectPct.toFixed(0)}%`);
                    }
                    if (isMegaReclaimRocket || isSuperReclaimRocket) {
                        if (!sigs.some(s => s.includes('Reclaim'))) sigs.push(`Reclaim+${reclaimPct.toFixed(0)}%`);
                    }

                    // Cooldown check - 10 days/3 weeks between rockets
                    const cooldownPeriods = isWeekly ? 3 : 10;
                    const lastSig = signals[signals.length - 1];
                    if (lastSig) {
                        const periodsSince = (timestamps[i] - Math.floor(lastSig.timestamp)) / 86400 / (isWeekly ? 7 : 1);
                        if (periodsSince < cooldownPeriods) continue;
                    }

                    // Get future returns (use available data)
                    const futureIndex = Math.min(i + 5, closes.length - 1);
                    const price5d = closes[futureIndex];
                    const ret5d = price5d ? ((price5d - currentPrice) / currentPrice * 100) : null;

                    signals.push({
                        date: date.toLocaleDateString(),
                        timestamp: timestamps[i],
                        type,
                        price: currentPrice.toFixed(2),
                        signals: sigs,
                        signalCount: Math.max(bullScore, bearScore),
                        ret5d
                    });
                }
            }

            if (signals.length === 0) {
                console.log('No rockets found - signals are working correctly (very selective)');
            } else {
                console.log(`Found ${signals.length} ROCKET SIGNAL(S):\n`);

                signals.forEach(s => {
                    const emoji = s.type === 'GREEN' ? '🟢🚀' : '🔴🚀';
                    const win = s.type === 'GREEN' ? (s.ret5d > 0 ? '✓ WIN' : '✗ LOSS') : (s.ret5d < 0 ? '✓ WIN' : '✗ LOSS');
                    console.log(`${emoji} ${s.type} ROCKET | ${s.date} | $${s.price}`);
                    console.log(`   Signals: ${s.signals.join(', ')}`);
                    console.log(`   ${isWeekly ? '5-Week' : '5-Day'} Return: ${s.ret5d?.toFixed(1)}% ${win}`);
                    console.log('');
                });

                const greenSignals = signals.filter(s => s.type === 'GREEN');
                if (greenSignals.length > 0) {
                    const greenWins = greenSignals.filter(s => s.ret5d > 0).length;
                    const avgReturn = greenSignals.reduce((sum, s) => sum + (s.ret5d || 0), 0) / greenSignals.length;
                    console.log('--- SUMMARY ---');
                    console.log(`Total Rockets: ${signals.length} in 6 months`);
                    console.log(`Green Win Rate: ${((greenWins / greenSignals.length) * 100).toFixed(0)}%`);
                    console.log(`Avg 5-Day Return: ${avgReturn.toFixed(1)}%`);
                }
            }

        } catch(e) {
            console.log('Error:', e.message);
        }
    });
}).on('error', e => console.log('Request error:', e.message));
