# SCALPER CODE BACKUP - January 26, 2026

This file contains both versions of the scalper signal detection code.

---

## VERSION 1: REAL-TIME SWING DETECTOR (Current - No Delay)
**Status:** Currently active in index.html
**Pros:** Fires IMMEDIATELY when candle closes at swing high/low
**Cons:** May have more false signals since no lookahead confirmation

```javascript
// REAL-TIME SWING DETECTOR - Left side only, no lookahead delay
const detectScalpSignals = (candles, vwap, ema9, ema21, ema50, rsi, macdData, levels, timeframe = '5m') => {
    const signals = [];
    const avgVolumes = [];

    // TIMEFRAME-SPECIFIC SETTINGS
    const settings = {
        '1m': { swingLookback: 6, cooldown: 6, swingDepth: 0.004, volumeMult: 1.2, zonePct: 0.50 },
        '5m': { swingLookback: 12, cooldown: 12, swingDepth: 0.007, volumeMult: 1.3, zonePct: 0.55 },
        '15m': { swingLookback: 8, cooldown: 8, swingDepth: 0.012, volumeMult: 1.5, zonePct: 0.60 }
    };
    const cfg = settings[timeframe] || settings['5m'];

    // Pre-calculate 20-bar average volumes
    for (let i = 0; i < candles.length; i++) {
        if (i < 20) {
            avgVolumes.push(candles.slice(0, i + 1).reduce((s, c) => s + c.volume, 0) / (i + 1));
        } else {
            avgVolumes.push(candles.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20);
        }
    }

    // Helpers
    const hasBottomWick = (c) => {
        const body = Math.abs(c.close - c.open);
        const lowerWick = Math.min(c.open, c.close) - c.low;
        return lowerWick > body * 0.4;
    };
    const hasTopWick = (c) => {
        const body = Math.abs(c.close - c.open);
        const upperWick = c.high - Math.max(c.open, c.close);
        return upperWick > body * 0.4;
    };
    const nearLevel = (price, level, tolerance = 0.003) => {
        if (!level) return false;
        return Math.abs(price - level) / level < tolerance;
    };

    let lastLongIdx = -cfg.cooldown * 2;
    let lastShortIdx = -cfg.cooldown * 2;

    const lookback = cfg.swingLookback;

    // Loop all the way to the end - no lookahead needed
    for (let i = lookback; i < candles.length; i++) {
        const c = candles[i];

        const hasVolume = c.volume > avgVolumes[i] * cfg.volumeMult;

        // SWING DETECTION: LEFT SIDE ONLY (real-time, no delay)
        const leftBars = candles.slice(Math.max(0, i - lookback), i);
        const leftMaxHigh = Math.max(...leftBars.map(x => x.high));
        const leftMinLow  = Math.min(...leftBars.map(x => x.low));

        const isSwingHigh = c.high >= leftMaxHigh;
        const isSwingLow  = c.low  <= leftMinLow;

        const isGreen = c.close > c.open;
        const isRed   = c.close < c.open;

        const atPDL = nearLevel(c.low, levels.PDL);
        const atPMH = nearLevel(c.high, levels.PMH);

        // LONG SIGNAL
        const longCooldownOk = (i - lastLongIdx) >= cfg.cooldown;
        const strongHammer = hasBottomWick(c) && (c.low <= leftMinLow * 1.001);
        const longPattern = isGreen || strongHammer;

        const recentHigh = Math.max(...candles.slice(Math.max(0, i - 20), i).map(x => x.high));
        const swingDepth = (recentHigh - c.low) / recentHigh;
        const isSignificantDepth = swingDepth > cfg.swingDepth;

        const atSupportLevel = nearLevel(c.low, levels.PDL, 0.0015) ||
                               nearLevel(c.low, levels.PDH, 0.0015) ||
                               nearLevel(c.low, levels.PML, 0.0015);

        if (isSwingLow && longPattern && longCooldownOk && (isSignificantDepth || atSupportLevel)) {
            const reasons = ['SwingLow'];
            if (atPDL) reasons.push('PDL');
            if (hasBottomWick(c)) reasons.push('Wick');
            if (hasVolume) reasons.push('Vol');

            signals.push({
                type: 'long',
                time: c.time,
                price: c.close,
                low: c.low,
                reasons: reasons,
                strength: reasons.length
            });
            lastLongIdx = i;
        }

        // SHORT SIGNAL
        const shortCooldownOk = (i - lastShortIdx) >= cfg.cooldown;
        const hasRejectionWick = hasTopWick(c);
        const shortPattern = isRed || hasRejectionWick;

        const recentLow = Math.min(...candles.slice(Math.max(0, i - 20), i).map(x => x.low));
        const swingHeight = (c.high - recentLow) / recentLow;
        const isSignificantHeight = swingHeight > cfg.swingDepth;

        const atResistanceLevel = nearLevel(c.high, levels.PDH, 0.0015) ||
                                  nearLevel(c.high, levels.PMH, 0.0015);

        if (isSwingHigh && shortPattern && shortCooldownOk && (isSignificantHeight || atResistanceLevel)) {
            const reasons = ['SwingHigh'];
            if (atPMH) reasons.push('PMH');
            if (hasTopWick(c)) reasons.push('Wick');
            if (hasVolume) reasons.push('Vol');

            signals.push({
                type: 'short',
                time: c.time,
                price: c.close,
                high: c.high,
                reasons: reasons,
                strength: reasons.length
            });
            lastShortIdx = i;
        }
    }

    return signals;
};
```

---

## VERSION 2: CONFLUENCE SCALPER (Yesterday's - Accurate but Delayed)
**Status:** Still in index.html as `detectConfluenceSignals`
**Pros:** Very accurate, uses 8 indicators for confluence scoring
**Cons:** 6-12 candle delay due to lookahead confirmation

### Settings:
```javascript
const settings = {
    '1m': { cooldown: 4, minScore: 4, adxMin: 15 },
    '5m': { cooldown: 3, minScore: 4, adxMin: 15 },
    '15m': { cooldown: 2, minScore: 4, adxMin: 15 }
};
```

### 8 Confluence Indicators:
1. **EMA Stack** - EMA9 > EMA21 > EMA50 alignment
2. **MACD** - Histogram direction and crossovers
3. **RSI** - Oversold (<35) for longs, Overbought (>65) for shorts
4. **Bollinger Bands** - Price at lower band (long) / upper band (short)
5. **Volume** - Above 20-bar average
6. **ADX** - Trend strength > 15
7. **Key Levels** - Near PDL/PDH/PMH/PML
8. **Candle Pattern** - Hammer/shooting star recognition

### Signal Requirements:
- Minimum score of 4/8 indicators aligning
- Cooldown between signals (3-4 bars depending on timeframe)
- ADX minimum of 15 for trend confirmation
- Lookahead confirmation (checks future candles to confirm swing)

---

## BUGS FIXED TODAY:

### 1. Blue Screen - Cannot read 'winRate' of undefined
**Cause:** Changed `scalpStats` structure but UI expected backtest stats
**Fix:** Replaced backtest stats panel with "REAL-TIME MODE" indicator

### 2. Cannot read 'toFixed' of undefined
**Cause:** Signals didn't have `return10` property, check used `!== null`
**Fix:** Changed to `!= null` (catches both null and undefined)

### 3. Zero Signals on 15min
**Cause:** Filters too strict (minScore 5, mandatory volume, ADX > 20)
**Fix:** Loosened thresholds, made filters scoring factors not hard blocks

### 4. Too Many Signals (every candle)
**Cause:** Criteria too loose after over-loosening
**Fix:** Implemented left-side-only swing detection with proper depth filters

### 5. Signals Only After 10:45am
**Cause:** `scanStart = Math.max(50, candles.length - 30)` only scanned last 30 candles
**Fix:** Changed to `scanStart = 50` to scan all candles

---

## KEY DIFFERENCE EXPLAINED:

### LOOKAHEAD (Yesterday's Confluence):
```javascript
// Checks FUTURE candles to confirm swing
const rightBars = candles.slice(i + 1, Math.min(candles.length, i + lookback + 1));
const rightMaxHigh = Math.max(...rightBars.map(x => x.high));
const isSwingLow = c.low < leftMinLow && c.low < rightMinLow;  // Needs future data
```
Result: Arrow placed at exact swing, but alert fires 6-12 candles LATER

### LEFT-SIDE ONLY (Today's Real-time):
```javascript
// Only checks PAST candles - no future data needed
const leftBars = candles.slice(Math.max(0, i - lookback), i);
const leftMinLow = Math.min(...leftBars.map(x => x.low));
const isSwingLow = c.low <= leftMinLow;  // Only needs past data
```
Result: Alert fires IMMEDIATELY when candle closes, some may be false alarms

---

## TO SWITCH BETWEEN VERSIONS:

To use the CONFLUENCE version (delayed but accurate):
1. In index.html, find where `detectScalpSignals` is called
2. Change it to call `detectConfluenceSignals` instead
3. Update the UI panel text accordingly

To use the REAL-TIME version (current):
- Keep using `detectScalpSignals` as-is
