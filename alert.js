const fs = require("fs");
const WebSocket = require("ws");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const MODE = (process.env.MODE || "live").toLowerCase(); // live | backtest | test
const BACKTEST_BARS = Number(process.env.BACKTEST_BARS || 300);

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

function fmtUTC(sec) {
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
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
          epoch: c.epoch,     // candle OPEN time (seconds)
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

function ensureState() {
  if (!fs.existsSync("state.json")) {
    fs.writeFileSync(
      "state.json",
      JSON.stringify(
        { lastProcessedCloseEpoch: 0, lastAlertCloseEpoch: 0 },
        null,
        2
      )
    );
  }

  const s = JSON.parse(fs.readFileSync("state.json", "utf8"));
  return {
    lastProcessedCloseEpoch: Number(s.lastProcessedCloseEpoch || 0),
    lastAlertCloseEpoch: Number(s.lastAlertCloseEpoch || 0),
  };
}

(async () => {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    throw new Error("Missing TG_BOT_TOKEN or TG_CHAT_ID (GitHub Secrets).");
  }

  console.log("MODE:", MODE);
  console.log("Run time (UTC):", new Date().toISOString());

  // TEST (manual only)
  if (MODE === "test") {
    await sendTelegram("✅ TEST OK: Bot is running. Time: " + new Date().toISOString());
    console.log("Sent TEST message");
    return;
  }

  const candles = await getCandles();
  const nowSec = Math.floor(Date.now() / 1000);

  const closed = candles.filter(c => (c.epoch + TF) <= nowSec);
  console.log("Candles fetched:", candles.length, "| Closed:", closed.length);

  if (closed.length < 60) {
    console.log("Not enough closed candles yet");
    return;
  }

  const closes = closed.map(c => c.close);
  const sma4 = sma(closes, 4);
  const sma34 = sma(closes, 34);

  // BACKTEST (manual only): report last crosses (does not touch state.json)
  if (MODE === "backtest") {
    const start = Math.max(1, closed.length - Math.min(BACKTEST_BARS, closed.length - 1));
    const found = [];

    for (let i = start; i < closed.length; i++) {
      if (sma4[i - 1] == null || sma34[i - 1] == null || sma4[i] == null || sma34[i] == null) continue;

      const buy = crossover(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);
      const sell = crossunder(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);

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
      await sendTelegram(`BACKTEST: No SMA(4/34) crosses in last ${BACKTEST_BARS} M15 candles.`);
      console.log("Backtest: no crosses");
      return;
    }

    await sendTelegram(
      `BACKTEST: SMA(4/34) crosses (last 8)\n` + found.slice(-8).join("\n")
    );
    console.log("Backtest sent:", found.length);
    return;
  }

  // LIVE (scheduled runs are forced here)
  const state = ensureState();
  console.log("State:", state);

  const newestCloseEpoch = closed[closed.length - 1].epoch + TF;
  console.log("Newest closed candle CLOSE:", fmtUTC(newestCloseEpoch));

  // Bootstrap: start fresh (prevents historical spam)
  if (state.lastProcessedCloseEpoch === 0) {
    const newState = {
      lastProcessedCloseEpoch: newestCloseEpoch,
      lastAlertCloseEpoch: newestCloseEpoch,
    };
    fs.writeFileSync("state.json", JSON.stringify(newState, null, 2));
    console.log("Bootstrapped state.json; alerts start from next new closed candle.");
    return;
  }

  // Catch-up window: candles closed after last processed close
  const newIdx = [];
  for (let i = 1; i < closed.length; i++) {
    const closeEpoch = closed[i].epoch + TF;
    if (closeEpoch > state.lastProcessedCloseEpoch) newIdx.push(i);
  }

  if (!newIdx.length) {
    console.log("No new closed candles since last run");
    return;
  }

  console.log("New closed candles since last run:", newIdx.length);

  let lastEvent = null;
  let lastEventCloseEpoch = null;
  let crossCount = 0;

  for (const i of newIdx) {
    if (sma4[i - 1] == null || sma34[i - 1] == null || sma4[i] == null || sma34[i] == null) continue;

    const buy = crossover(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);
    const sell = crossunder(sma4[i - 1], sma34[i - 1], sma4[i], sma34[i]);

    if (buy || sell) {
      crossCount++;
      const openEpoch = closed[i].epoch;
      const closeEpoch = openEpoch + TF;

      lastEventCloseEpoch = closeEpoch;
      lastEvent =
        `${fmtUTC(openEpoch)} (OPEN) | ${fmtUTC(closeEpoch)} (CLOSE) | Close ${closed[i].close} | ` +
        (buy ? "BUY (SMA4 ↑ SMA34)" : "SELL (SMA4 ↓ SMA34)");
    }
  }

  console.log("Crosses found in new window:", crossCount);

  // If a cross exists, only alert if it's newer than the last alerted close
  if (lastEvent && lastEventCloseEpoch > state.lastAlertCloseEpoch) {
    const note = crossCount > 1 ? `\n(${crossCount} crosses since last run; showing latest)` : "";
    await sendTelegram(`V75 (${SYMBOL}) M15 SMA Cross\n${lastEvent}${note}`);
    console.log("Telegram sent.");

    const newState = {
      lastProcessedCloseEpoch: newestCloseEpoch,
      lastAlertCloseEpoch: lastEventCloseEpoch,
    };
    fs.writeFileSync("state.json", JSON.stringify(newState, null, 2));
    return;
  }

  // No new cross to alert — advance processed time only
  const newState = {
    lastProcessedCloseEpoch: newestCloseEpoch,
    lastAlertCloseEpoch: state.lastAlertCloseEpoch,
  };
  fs.writeFileSync("state.json", JSON.stringify(newState, null, 2));
  console.log("No alert sent.");
})();
