import WebSocket from "ws";

const DERIV_APP_ID = 1089;       // public Deriv app_id
const SYMBOL = "R_75";           // Volatility 75 Index (Deriv API symbol)
const GRANULARITY = 900;         // 15 minutes (M15)
const CANDLE_COUNT = 250;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

function ema(values, length) {
  const k = 2 / (length + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

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

// Stoch logic (similar to what we built): rawK -> EMA(5) -> EMA(5) -> EMA(15 red)
function stochasticTriple(candles, kLen=28, kSmooth=5, dSmooth=5, redLen=15) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const rawK = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kLen - 1) { rawK.push(null); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const denom = (hh - ll);
    rawK.push(denom === 0 ? 0 : 100 * (closes[i] - ll) / denom);
  }

  const firstIdx = rawK.findIndex(v => v !== null);
  const rk = rawK.slice(firstIdx);

  const k = ema(rk, kSmooth);
  const d = ema(k, dSmooth);
  const red = ema(d, redLen);

  const pad = Array(firstIdx).fill(null);
  return { k: pad.concat(k), red: pad.concat(red) };
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TG_CHAT_ID, text };
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
}

function getCandles() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: "candles",
        granularity: GRANULARITY,
        count: CANDLE_COUNT,
        end: "latest"
      }));
    });

    ws.on("message", (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.error) {
        ws.close();
        reject(new Error(data.error.message));
        return;
      }
      if (data.msg_type === "candles") {
        ws.close();
        const candles = data.candles.map(c => ({
          epoch: c.epoch,
          open: +c.open,
          high: +c.high,
          low: +c.low,
          close: +c.close
        }));
        resolve(candles);
      }
    });

    ws.on("error", reject);
  });
}

function crossover(prevA, prevB, curA, curB) {
  return prevA <= prevB && curA > curB;
}
function crossunder(prevA, prevB, curA, curB) {
  return prevA >= prevB && curA < curB;
}

(async () => {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) throw new Error("Missing Telegram secrets");

  const candles = await getCandles();
  const now = Math.floor(Date.now()/1000);

  // use last completed M15 candle
  const completed = candles.filter(c => (c.epoch + GRANULARITY) <= now);
  if (completed.length < 60) return;

  const closes = completed.map(c => c.close);

  // SMA cross (4/34)
  const sma4 = sma(closes, 4);
  const sma34 = sma(closes, 34);

  // Stoch cross (%K vs red)
  const st = stochasticTriple(completed, 28, 5, 5, 15);
  const k = st.k, red = st.red;

  const i = closes.length - 1;
  const p = i - 1;

  const events = [];

  if (sma4[p] != null && sma34[p] != null) {
    if (crossover(sma4[p], sma34[p], sma4[i], sma34[i])) events.push("SMA4 crossed ABOVE SMA34");
    if (crossunder(sma4[p], sma34[p], sma4[i], sma34[i])) events.push("SMA4 crossed BELOW SMA34");
  }

  if (k[p] != null && red[p] != null) {
    if (crossover(k[p], red[p], k[i], red[i])) events.push("Stoch %K crossed ABOVE Red");
    if (crossunder(k[p], red[p], k[i], red[i])) events.push("Stoch %K crossed BELOW Red");
  }

  if (events.length) {
    const last = completed[completed.length - 1];
    const t = new Date(last.epoch * 1000).toISOString().replace("T"," ").slice(0,19) + " UTC";
    const msg =
      `V75 Alert (Deriv ${SYMBOL}) M15 close\n` +
      `Time: ${t}\n` +
      `Close: ${last.close}\n` +
      events.map(e => `- ${e}`).join("\n");
    await sendTelegram(msg);
  }
})();
