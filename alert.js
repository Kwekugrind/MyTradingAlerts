const fs = require("fs");
const WebSocket = require("ws");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Deriv
const APP_ID = 1089;
const SYMBOL = "R_75";
const TF = 900;     // M15
const COUNT = 700;  // candles requested from Deriv

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
          epoch: c.epoch,   // candle OPEN time
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

  console.log("Run time (UTC):", new Date().toISOString());

  if (!fs.existsSync("state.json")) {
    fs.writeFileSync("state.json", JSON.stringify({ lastCloseEpoch: 0 }, null, 2));
  }

  const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
  const lastCloseEpoch = Number(state.lastCloseEpoch || 0);
  console.log("lastCloseEpoch:", lastCloseEpoch, lastCloseEpoch ? fmtUTC(lastCloseEpoch) : "(not set)");

  const candles = await getCandles();
  const nowSec = Math.floor(Date.now() / 1000);

  const closed = candles.filter(c => (c.epoch + TF) <= nowSec);
  console.log("Candles fetched:", candles.length, "| Closed candles:", closed.length);

  if (closed.length < 60) {
    console.log("Not enough closed candles yet");
    return;
  }

  const closes = closed.map(c => c.close);
  const sma4 = sma(closes, 4);
  const sma34 = sma(closes, 34);

  const newestCloseEpoch = closed[closed.length - 1].epoch + TF;
  console.log("Newest closed candle CLOSE:", fmtUTC(newestCloseEpoch));

  // First run: set state, don't alert history
  if (lastCloseEpoch === 0) {
    state.lastCloseEpoch = newestCloseEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    console.log("Bootstrapped state.json; alerts start from next new closed candle.");
    return;
  }

  // Catch-up window
  const newIdx = [];
  for (let i = 1; i < closed.length; i++) {
    const closeEpoch = closed[i].epoch + TF;
    if (closeEpoch > lastCloseEpoch) newIdx.push(i);
  }

  if (!newIdx.length) {
    console.log("No new closed candles since last run");
    return;
  }

  console.log("New closed candles since last run:", newIdx.length);

  // Latest cross only (no spam)
  let lastEvent = null;
  let crossCount = 0;

  for (const i of newIdx) {
    if (sma4[i - 1] == null || sma34[i - 1] == null || sma4[i] == null || sma34[i] == null) continue;

    const buy = crossover(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);
    const sell = crossunder(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);

    if (buy || sell) {
      crossCount++;
      const openEpoch = closed[i].epoch;
      const closeEpoch = openEpoch + TF;

      lastEvent =
        `${fmtUTC(openEpoch)} (OPEN) | ${fmtUTC(closeEpoch)} (CLOSE) | Close ${closed[i].close} | ` +
        (buy ? "BUY (SMA4 ↑ SMA34)" : "SELL (SMA4 ↓ SMA34)");
    }
  }

  console.log("Crosses found in new window:", crossCount);

  if (lastEvent) {
    const note = crossCount > 1 ? `\n(${crossCount} crosses since last run; showing latest)` : "";
    await sendTelegram(`V75 (${SYMBOL}) M15 SMA Cross\n${lastEvent}${note}`);
    console.log("Telegram sent.");
  } else {
    console.log("No SMA cross in new candles => no Telegram alert.");
  }

  state.lastCloseEpoch = newestCloseEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log("State updated to:", fmtUTC(newestCloseEpoch));
})();
