const fs = require("fs");
const WebSocket = require("ws");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const MODE = (process.env.MODE || "").toLowerCase(); // "", "test", "backtest"
const BACKTEST_BARS = Number(process.env.BACKTEST_BARS || 300);

// Deriv
const APP_ID = 1089;
const SYMBOL = "R_75";
const TF = 900;       // M15
const COUNT = 700;    // candles requested from Deriv (max scan window)

function sma(values, length) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function crossover(pA, pB, cA, cB) {
  return pA <= pB && cA > cB;
}
function crossunder(pA, pB, cA, cB) {
  return pA >= pB && cA < cB;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
  });
  if (!res.ok) throw new Error(await res.text());
}

function getCandles() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Deriv websocket timeout"));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: "candles",
        granularity: TF,
        count: COUNT,
        end: "latest",
      }));
    });

    ws.on("message", (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.error) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        return reject(new Error(data.error.message));
      }
      if (data.msg_type === "candles") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(data.candles.map(c => ({
          epoch: c.epoch,      // candle OPEN time
          close: +c.close
        })));
      }
    });

    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function fmtUTC(sec) {
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

(async () => {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    throw new Error("Missing TG_BOT_TOKEN or TG_CHAT_ID. Add them in GitHub Secrets.");
  }

  // --- TEST MODE ---
  if (MODE === "test") {
    await sendTelegram("✅ TEST OK: GitHub Actions → Telegram is working. Time: " + new Date().toISOString());
    console.log("Sent TEST message");
    return;
  }

  const candles = await getCandles();
  const nowSec = Math.floor(Date.now() / 1000);

  // only fully closed candles
  const closed = candles.filter(c => (c.epoch + TF) <= nowSec);
  if (closed.length < 60) {
    console.log("Not enough closed candles yet");
    return;
  }

  const closes = closed.map(c => c.close);
  const sma4 = sma(closes, 4);
  const sma34 = sma(closes, 34);

  // --- BACKTEST MODE: find recent crosses and report them ---
  if (MODE === "backtest") {
    const start = Math.max(1, closed.length - Math.min(BACKTEST_BARS, closed.length - 1));
    const found = [];

    for (let i = start; i < closed.length; i++) {
      if (sma4[i-1] == null || sma34[i-1] == null || sma4[i] == null || sma34[i] == null) continue;

      const buy = crossover(sma4[i-1], sma34[i-1], sma4[i], sma34[i]);
      const sell = crossunder(sma4[i-1], sma34[i-1], sma4[i], sma34[i]);

      if (buy || sell) {
        const openEpoch = closed[i].epoch;
        const closeEpoch = openEpoch + TF;
        found.push(
          `${fmtUTC(openEpoch)} (OPEN) | ${fmtUTC(closeEpoch)} (CLOSE) | Close ${closed[i].close} | ` +
          (buy ? "BUY (SMA4 ↑ SMA34)" : "SELL (SMA4 ↓ SMA34)")
        );
      }
    }

    if (!found.length) {
      await sendTelegram(`BACKTEST: No SMA(4/34) crosses found in last ${BACKTEST_BARS} M15 candles.`);
      console.log("Backtest: no crosses found");
      return;
    }

    await sendTelegram(
      `BACKTEST: Last SMA(4/34) crosses (showing last 8)\n` +
      found.slice(-8).join("\n")
    );
    console.log("Backtest sent", found.length, "cross(es)");
    return;
  }

  // --- LIVE MODE (default): catch-up so missed GitHub runs won't miss signals ---
  if (!fs.existsSync("state.json")) {
    fs.writeFileSync("state.json", JSON.stringify({ lastCloseEpoch: 0 }, null, 2));
  }
  const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
  const lastCloseEpoch = Number(state.lastCloseEpoch || 0);

  const newIdx = [];
  for (let i = 1; i < closed.length; i++) {
    const closeEpoch = closed[i].epoch + TF;
    if (closeEpoch > lastCloseEpoch) newIdx.push(i);
  }

  if (!newIdx.length) {
    console.log("No new closed candles since last run");
    return;
  }

  // update state to newest close
  const newestCloseEpoch = closed[closed.length - 1].epoch + TF;
  state.lastCloseEpoch = newestCloseEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  const events = [];
  for (const i of newIdx.slice(-10)) {
    if (sma4[i-1] == null || sma34[i-1] == null || sma4[i] == null || sma34[i] == null) continue;

    const buy = crossover(sma4[i-1], sma34[i-1], sma4[i], sma34[i]);
    const sell = crossunder(sma4[i-1], sma34[i-1], sma4[i], sma34[i]);

    if (buy || sell) {
      const openEpoch = closed[i].epoch;
      const closeEpoch = openEpoch + TF;
      events.push(
        `${fmtUTC(openEpoch)} (OPEN) | ${fmtUTC(closeEpoch)} (CLOSE) | Close ${closed[i].close} | ` +
        (buy ? "BUY (SMA4 ↑ SMA34)" : "SELL (SMA4 ↓ SMA34)")
      );
    }
  }

  if (!events.length) {
    console.log("No SMA cross in new candles");
    return;
  }

  await sendTelegram(`V75 (${SYMBOL}) M15 SMA Cross\n` + events.join("\n"));
  console.log("Sent SMA alert:", events.length, "event(s)");
})();
