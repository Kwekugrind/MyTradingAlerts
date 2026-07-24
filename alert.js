import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
// Change these 3 lines for each respective repo:
const SYMBOL = "R_100";                     // e.g., "R_75", "stpRNG", "R_50", "R_25", "R_100"
const SYMBOL_NAME = "Volatility 100 Index"; // e.g., "Volatility 75 Index", "Step Index", etc.
const REPO_LABEL = "Test Bot (V100)";       // e.g., "Lery's Elite Alerts", "Coffee Machine", etc.
// ==================================================================

const M5 = 300;       // 5 minutes in seconds
const D1 = 86400;     // 1 day in seconds
const CANDLES = 200;

const ATR_PERIOD = 14;
const FRACTAL_LOOKBACK = 8;
const SETUP_EXPIRY_BARS = 15;
const RISK_REWARD = 1.5; // 1:1.5 Risk-to-Reward Ratio

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE;
const MODE = process.env.MODE && process.env.MODE.trim() !== "" ? process.env.MODE.trim() : "scan";

if (TRIGGER_SOURCE !== "cronjob") {
  console.log("⛔ Blocked: Not a cronjob trigger.");
  process.exit(0);
}

// ==================== STATE MANAGEMENT ====================
let state = {
  waitingFor: null,
  setupEpoch: null,
  lastProcessedEpoch: null
};

try {
  if (fs.existsSync("state.json")) {
    state = JSON.parse(fs.readFileSync("state.json"));
  }
} catch (e) {
  console.log("State load error, starting fresh.");
}

// ==================== TELEGRAM HELPER ====================
async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// ==================== DERIV PUBLIC API HELPERS ====================
async function fetchCandles(granularity, count = CANDLES) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: count,
        end: "latest",
        style: "candles",
        granularity: granularity
      }));
    });

    ws.on("message", (data) => {
      const response = JSON.parse(data);
      if (response.error) {
        clearTimeout(timeout);
        reject(new Error(response.error.message));
        ws.close();
      }
      if (response.candles) {
        clearTimeout(timeout);
        resolve(response.candles);
        ws.close();
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function getCurrentPrice() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    const timeout = setTimeout(() => { ws.terminate(); reject("Timeout"); }, 10000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ ticks_history: SYMBOL, count: 1, end: "latest" }));
    });

    ws.on("message", (data) => {
      const response = JSON.parse(data);
      if (response.history && response.history.prices) {
        clearTimeout(timeout);
        resolve(parseFloat(response.history.prices[0]));
        ws.close();
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ==================== INDICATORS & FRACTALS ====================
function sma(data, period) {
  return data.map((_, i, arr) => {
    if (i < period - 1) return null;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data, period) {
  let k = 2 / (period + 1);
  let emaArray = [data[0]];
  for (let i = 1; i < data.length; i++) {
    emaArray[i] = data[i] * k + emaArray[i - 1] * (1 - k);
  }
  return emaArray;
}

function calculateATR(candles, period) {
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getFractals(candles) {
  let highFractals = [];
  let lowFractals = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const h = parseFloat(candles[i].high);
    if (
      h > parseFloat(candles[i - 1].high) &&
      h > parseFloat(candles[i - 2].high) &&
      h > parseFloat(candles[i + 1].high) &&
      h > parseFloat(candles[i + 2].high)
    ) {
      highFractals.push(h);
    }

    const l = parseFloat(candles[i].low);
    if (
      l < parseFloat(candles[i - 1].low) &&
      l < parseFloat(candles[i - 2].low) &&
      l < parseFloat(candles[i + 1].low) &&
      l < parseFloat(candles[i + 2].low)
    ) {
      lowFractals.push(l);
    }
  }

  return {
    significantHigh: highFractals.length > 0 ? Math.max(...highFractals.slice(-FRACTAL_LOOKBACK)) : null,
    significantLow: lowFractals.length > 0 ? Math.min(...lowFractals.slice(-FRACTAL_LOOKBACK)) : null
  };
}

// ==================== D1 CONTEXT HELPER ====================
async function getD1Context() {
  try {
    const d1Candles = await fetchCandles(D1, 2);
    if (!d1Candles || d1Candles.length === 0) return null;
    const c = d1Candles[d1Candles.length - 1];
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);

    let direction, change, changePct;
    if (close > open) {
      direction = "🟢 BULLISH";
      change = close - open;
      changePct = ((change / open) * 100);
    } else if (close < open) {
      direction = "🔴 BEARISH";
      change = open - close;
      changePct = ((open - close) / open) * 100;
    } else {
      direction = "⚪ NEUTRAL";
      change = 0;
      changePct = 0;
    }
    return { open, close, direction, change, changePct };
  } catch (err) {
    return null;
  }
}

function checkAlignment(signalDir, d1Dir) {
  if (signalDir === "BUY" && d1Dir === "🟢 BULLISH") return "✅ ALIGNED with daily trend";
  if (signalDir === "SELL" && d1Dir === "🔴 BEARISH") return "✅ ALIGNED with daily trend";
  if (d1Dir === "⚪ NEUTRAL") return "⚪ Daily is flat";
  return "⚠️ COUNTER-TREND to daily";
}

// ==================== PERFORMANCE REPORTS ====================
async function runSummary(daysBack, title) {
  let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const periodTrades = trades.filter(t => t.result && t.result !== "CANCELLED" && new Date(t.closeTime) >= cutoff);
  if (periodTrades.length === 0) return;

  const wins = periodTrades.filter(t => t.result === "WIN").length;
  const losses = periodTrades.filter(t => t.result === "LOSS").length;
  const netR = periodTrades.reduce((s, t) => s + (t.result === "WIN" ? t.rr : -1), 0);
  const winRate = ((wins / periodTrades.length) * 100).toFixed(1);

  let report = `📊 ${REPO_LABEL} — ${title}\n\n` +
    `Trades: ${periodTrades.length}\n` +
    `Wins: ${wins} | Losses: ${losses}\n` +
    `Win Rate: ${winRate}%\n` +
    `Net R: ${netR.toFixed(1)}R`;

  await sendTelegram(report);
}

// ==================== MAIN LOGIC ====================
(async () => {
  try {
    if (MODE === "weekly") {
      await runSummary(7, "Weekly Report");
      return;
    } else if (MODE === "monthly") {
      await runSummary(30, "Monthly Report");
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];

    const candles = await fetchCandles(M5, CANDLES);
    if (!candles || candles.length < 50) return;
    const i = candles.length - 2;

    // 1. Check existing open trade settlement locally (TP1 or SL)
    let openTrade = trades.find(t => t.result === null);
    if (openTrade) {
      const currentPrice = await getCurrentPrice();
      let settledResult = null;
      let exitReason = "";

      if (openTrade.direction === "BUY") {
        if (currentPrice >= openTrade.tp1) { settledResult = "WIN"; exitReason = "TP1 Hit"; }
        else if (currentPrice <= openTrade.sl) { settledResult = "LOSS"; exitReason = "Stop Loss Hit"; }
      } else {
        if (currentPrice <= openTrade.tp1) { settledResult = "WIN"; exitReason = "TP1 Hit"; }
        else if (currentPrice >= openTrade.sl) { settledResult = "LOSS"; exitReason = "Stop Loss Hit"; }
      }

      if (settledResult) {
        openTrade.result = settledResult;
        openTrade.closeTime = new Date().toISOString();
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

        const icon = settledResult === "WIN" ? "✅" : "❌";
        const rMult = settledResult === "WIN" ? `+${openTrade.rr}R` : "-1.0R";
        await sendTelegram(`${icon} ${REPO_LABEL} Trade Result: ${settledResult}\nSymbol: ${SYMBOL_NAME}\nReason: ${exitReason}\nExit Price: ${currentPrice}\nOutcome: ${rMult}`);
      }
      return;
    }

    // 2. Run Strategy Engine (Entry Guard)
    const currentCandleEpoch = candles[i].epoch;
    const isoTime = new Date(currentCandleEpoch * 1000).toISOString();

    if (state.lastProcessedEpoch === currentCandleEpoch) return;

    const closes = candles.map(c => parseFloat(c.close));
    const opens = candles.map(c => parseFloat(c.open));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));

    const smaFast = sma(closes, 4);
    const smaSlow = sma(closes, 34);
    const atr14 = calculateATR(candles, ATR_PERIOD);

    const bodies = candles.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const avgBodyArr = sma(bodies, 20);
    const avgBody = avgBodyArr[i] || 0;
    const currentBody = bodies[i];

    const crossUp = (smaFast[i - 1] <= smaSlow[i - 1]) && (smaFast[i] > smaSlow[i]);
    const crossDn = (smaFast[i - 1] >= smaSlow[i - 1]) && (smaFast[i] < smaSlow[i]);

    if (crossUp) {
      state.waitingFor = "BUY";
      state.setupEpoch = currentCandleEpoch;
    } else if (crossDn) {
      state.waitingFor = "SELL";
      state.setupEpoch = currentCandleEpoch;
    }

    if (state.waitingFor !== null && state.setupEpoch !== null) {
      if ((currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) {
        state.waitingFor = null;
        state.setupEpoch = null;
      }
    }

    const candleRange = highs[i] - lows[i];
    const closePosBuy = (closes[i] - lows[i]) / candleRange;
    const closePosSell = (highs[i] - closes[i]) / candleRange;
    const smaSeparation = Math.abs(smaFast[i] - smaSlow[i]);
    const sma34Slope = smaSlow[i] - smaSlow[i - 3];

    const separationOk = smaSeparation > (atr14 * 0.5);
    const slopeBuyOk = sma34Slope > 0;
    const slopeSellOk = sma34Slope < 0;
    const impulseOk = currentBody > (avgBody * 1.5);
    const strongBuyOk = (closePosBuy >= 0.7) && (closes[i] > opens[i]);
    const strongSellOk = (closePosSell >= 0.7) && (closes[i] < opens[i]);

    const fractals = getFractals(candles);
    const fractalBreakUp = (fractals.significantHigh !== null) && (closes[i] > fractals.significantHigh);
    const fractalBreakDown = (fractals.significantLow !== null) && (closes[i] < fractals.significantLow);

    const buySignal = (state.waitingFor === "BUY") && fractalBreakUp && separationOk && slopeBuyOk && impulseOk && strongBuyOk;
    const sellSignal = (state.waitingFor === "SELL") && fractalBreakDown && separationOk && slopeSellOk && impulseOk && strongSellOk;

    let signalTriggered = false;
    let direction = "";
    let entry, sl, risk, tp1, tp2, tp3;

    if (buySignal) {
      signalTriggered = true;
      direction = "BUY";
      entry = closes[i];
      const slOption1 = fractals.significantLow;
      const slOption2 = entry - (atr14 * 1.5);
      sl = slOption1 !== null ? Math.min(slOption1, slOption2) : slOption2;
      risk = entry - sl;
      tp1 = entry + (risk * RISK_REWARD);
      tp2 = entry + (risk * 2.0);
      tp3 = entry + (risk * 3.0);
    } else if (sellSignal) {
      signalTriggered = true;
      direction = "SELL";
      entry = closes[i];
      const slOption1 = fractals.significantHigh;
      const slOption2 = entry + (atr14 * 1.5);
      sl = slOption1 !== null ? Math.max(slOption1, slOption2) : slOption2;
      risk = sl - entry;
      tp1 = entry - (risk * RISK_REWARD);
      tp2 = entry - (risk * 2.0);
      tp3 = entry - (risk * 3.0);
    }

    if (signalTriggered) {
      const d1 = await getD1Context();
      const alignment = d1 ? checkAlignment(direction, d1.direction) : "⚠️ D1 data unavailable";
      const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T", " ").substring(0, 19);

      let message = `🚨 ${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL 🚨\n\n` +
        `Direction: ${direction}\n` +
        `Repo: ${REPO_LABEL}\n` +
        `Timeframe: M5\n\n` +
        `📍 Entry:  ${entry.toFixed(4)}\n` +
        `🛑 SL:     ${sl.toFixed(4)}\n` +
        `🎯 TP1:    ${tp1.toFixed(4)}  (1:1.5)\n` +
        `🎯 TP2:    ${tp2.toFixed(4)}  (2:1)\n` +
        `🎯 TP3:    ${tp3.toFixed(4)}  (3:1)\n\n` +
        `📊 Risk:   ${risk.toFixed(2)} points\n\n` +
        `🔥 Setup:  Fractal break confirmed with impulse\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📅 D1 CANDLE STATUS\n` +
        `━━━━━━━━━━━━━━━━━━━━\n`;

      if (d1) {
        message += `Direction:  ${d1.direction}\n` +
          `D1 Open:    ${d1.open.toFixed(4)}\n` +
          `D1 Current: ${d1.close.toFixed(4)}\n` +
          `Movement:   ${d1.change.toFixed(4)} points (${d1.changePct.toFixed(2)}%)\n` +
          `Alignment:  ${alignment}\n\n`;
      } else {
        message += `⚠️ D1 data unavailable\n\n`;
      }

      message += `⏰ Time (UTC): ${timeFormatted}`;

      await sendTelegram(message);

      // Log trade to trades.json to enforce Entry Guard and track outcomes
      trades.push({
        id: `${SYMBOL}-${isoTime}`,
        repo: REPO_LABEL,
        symbol: SYMBOL,
        direction: direction,
        entry: entry,
        sl: sl,
        tp1: tp1,
        tp2: tp2,
        tp3: tp3,
        rr: RISK_REWARD,
        openTime: timeFormatted,
        closeTime: null,
        result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

      state.waitingFor = null;
      state.setupEpoch = null;
    }

    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  } catch (err) {
    console.error("❌ BOT ERROR:", err.message);
    process.exit(1);
  }
})();
