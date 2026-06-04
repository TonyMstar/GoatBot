/**
 * Copy Machine v2 — consensus-based whale signal detector
 * --------------------------------------------------
 * Monitors top Hyperliquid wallets. Only posts a signal when CONSENSUS_MIN
 * or more whales are in the same direction on the same asset. One active
 * signal per asset. Closes automatically when consensus flips or drops.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   - bot token
 *   CHANNEL_ID           - private channel id
 *   TRADER_ADDRESSES     - comma-separated HL wallet addresses to monitor
 *   CONSENSUS_MIN        - how many whales must agree to post (default 2)
 *   MIN_POSITION_USD     - ignore positions smaller than this (default 100000)
 *   JSONBIN_KEY          - X-Master-Key for JSONBin
 *   JSONBIN_BIN_ID       - bin id for copy bot state
 *   POLL_INTERVAL        - ms between polls (default 60000)
 */

const https = require("node:https");

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID     = process.env.CHANNEL_ID;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL    || "60000");
const CONSENSUS_MIN  = parseInt(process.env.CONSENSUS_MIN    || "2");
const MIN_POS_USD    = parseFloat(process.env.MIN_POSITION_USD || "100000");
const TRADERS        = (process.env.TRADER_ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);

const SL_PCT  = 0.02;
const TP_PCTS = [0.02, 0.04, 0.06];

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("Need TELEGRAM_BOT_TOKEN and CHANNEL_ID");
  process.exit(1);
}
if (TRADERS.length === 0) {
  console.error("Need TRADER_ADDRESSES");
  process.exit(1);
}

// ---------- HTTP ----------
function request(opts, payload) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let b = "";
      res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", (e) => { console.error("req err", e.message); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

function tg(method, params) {
  const payload = JSON.stringify(params);
  return request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/${method}`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, payload);
}

function hl(body) {
  const payload = JSON.stringify(body);
  return request({
    hostname: "api.hyperliquid.xyz",
    path: "/info",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, payload);
}

function jsonbin(method, path, body) {
  if (!JSONBIN_KEY || !JSONBIN_BIN_ID) return Promise.resolve(null);
  const payload = body ? JSON.stringify(body) : null;
  const headers = { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY };
  if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
  return request({ hostname: "api.jsonbin.io", path, method, headers }, payload);
}

// ---------- state ----------
// positions: { [addr]: { [coin]: { side, entry, valueUsd } } }
// signals:   { [coin]: { side, entry, lev, messageId, whaleCount } }
let state = { positions: {}, signals: {} };

async function loadState() {
  const r = await jsonbin("GET", `/v3/b/${JSONBIN_BIN_ID}/latest`);
  if (r && r.record) state = r.record;
  state.positions = state.positions || {};
  state.signals   = state.signals   || {};
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => jsonbin("PUT", `/v3/b/${JSONBIN_BIN_ID}`, state), 300);
}

// ---------- formatting ----------
function fmtNum(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function calcLevels(entry, side) {
  const dir = side === "LONG" ? 1 : -1;
  return {
    sl:  entry * (1 - dir * SL_PCT),
    tps: TP_PCTS.map(p => entry * (1 + dir * p)),
  };
}

function renderSignal(coin, side, entry, lev, whaleCount) {
  const long = side === "LONG";
  const { sl, tps } = calcLevels(entry, side);
  return [
    `${long ? "🟢" : "🔴"} <b>${side} $${coin}</b>${lev ? `   ⚡${lev}x` : ""}`,
    "",
    `Entry: <b>${fmtNum(entry)}</b>`,
    `🎯 TP1: ${fmtNum(tps[0])}`,
    `🎯 TP2: ${fmtNum(tps[1])}`,
    `🎯 TP3: ${fmtNum(tps[2])}`,
    `🛑 SL: ${fmtNum(sl)}`,
    "",
    `🐋 ${whaleCount} whale${whaleCount > 1 ? "s" : ""} aligned`,
    `#${coin}`,
  ].join("\n");
}

function renderClose(coin, side, entry, exitPrice) {
  const move = exitPrice
    ? ((exitPrice - entry) / entry) * 100 * (side === "LONG" ? 1 : -1)
    : null;
  return [
    `⚪️ <b>$${coin} ${side} closed</b>`,
    move !== null ? `${move >= 0 ? "+" : ""}${move.toFixed(2)}% from entry` : "Whales exited",
  ].join("\n");
}

// ---------- consensus ----------
function buildConsensus() {
  // consensus[coin] = { LONG: count, SHORT: count, levSum: number, entries: [] }
  const consensus = {};
  for (const [, coinMap] of Object.entries(state.positions)) {
    for (const [coin, pos] of Object.entries(coinMap)) {
      if (!consensus[coin]) consensus[coin] = { LONG: 0, SHORT: 0, levs: [], entries: [] };
      consensus[coin][pos.side]++;
      if (pos.lev)   consensus[coin].levs.push(pos.lev);
      consensus[coin].entries.push(pos.entry);
    }
  }
  return consensus;
}

function avgEntry(entries) {
  return entries.reduce((a, b) => a + b, 0) / entries.length;
}

function medianLev(levs) {
  if (!levs.length) return null;
  const sorted = [...levs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------- main poll ----------
async function poll() {
  try {
    // 1. Fetch positions for each trader
    for (const addr of TRADERS) {
      const res = await hl({ type: "clearinghouseState", user: addr });
      if (!res || !Array.isArray(res.assetPositions)) continue;

      const coinMap = {};
      for (const ap of res.assetPositions) {
        const pos = ap.position;
        if (!pos || !pos.coin || !pos.szi) continue;
        const size = parseFloat(pos.szi);
        if (Math.abs(size) < 1e-8) continue;
        const valueUsd = parseFloat(pos.positionValue || "0");
        if (valueUsd < MIN_POS_USD) continue; // ignore small positions

        coinMap[pos.coin] = {
          side:     size > 0 ? "LONG" : "SHORT",
          entry:    parseFloat(pos.entryPx),
          valueUsd,
          lev:      pos.leverage ? pos.leverage.value : null,
        };
      }
      state.positions[addr] = coinMap;
      await new Promise(r => setTimeout(r, 300));
    }

    // 2. Build consensus map
    const consensus = buildConsensus();

    // 3. Check each coin for signal open/close
    const allCoins = new Set([
      ...Object.keys(consensus),
      ...Object.keys(state.signals),
    ]);

    for (const coin of allCoins) {
      const counts    = consensus[coin] || { LONG: 0, SHORT: 0, levs: [], entries: [] };
      const dominant  = counts.LONG >= counts.SHORT ? "LONG" : "SHORT";
      const domCount  = counts[dominant];
      const activeSig = state.signals[coin];

      if (!activeSig) {
        // No active signal — open one if consensus reached
        if (domCount >= CONSENSUS_MIN) {
          const entry = avgEntry(counts.entries);
          const lev   = medianLev(counts.levs);
          const posted = await tg("sendMessage", {
            chat_id: CHANNEL_ID,
            text: renderSignal(coin, dominant, entry, lev, domCount),
            parse_mode: "HTML",
          });
          state.signals[coin] = {
            side: dominant, entry, lev,
            messageId: posted && posted.ok ? posted.result.message_id : null,
            whaleCount: domCount,
          };
          console.log(`Signal opened: ${dominant} ${coin} (${domCount} whales)`);
        }
      } else {
        const opposite = activeSig.side === "LONG" ? "SHORT" : "LONG";
        const oppCount = counts[opposite] || 0;
        const sameCount = counts[activeSig.side] || 0;

        if (sameCount === 0 && oppCount === 0) {
          // All whales exited — close signal
          await closeSignal(coin, activeSig, null);
        } else if (oppCount >= CONSENSUS_MIN && oppCount > sameCount) {
          // Consensus flipped — close and open opposite
          await closeSignal(coin, activeSig, avgEntry(counts.entries));
          const entry = avgEntry(counts.entries);
          const lev   = medianLev(counts.levs);
          const posted = await tg("sendMessage", {
            chat_id: CHANNEL_ID,
            text: renderSignal(coin, opposite, entry, lev, oppCount),
            parse_mode: "HTML",
          });
          state.signals[coin] = {
            side: opposite, entry, lev,
            messageId: posted && posted.ok ? posted.result.message_id : null,
            whaleCount: oppCount,
          };
          console.log(`Signal flipped: ${opposite} ${coin} (${oppCount} whales)`);
        }
        // otherwise keep signal open — minor fluctuations are ignored
      }
    }

    saveState();
  } catch (e) {
    console.error("poll error:", e.message);
  }

  setTimeout(poll, POLL_INTERVAL);
}

async function closeSignal(coin, sig, exitPrice) {
  const text = renderClose(coin, sig.side, sig.entry, exitPrice);
  if (sig.messageId) {
    await tg("sendMessage", {
      chat_id: CHANNEL_ID,
      reply_to_message_id: sig.messageId,
      text,
      parse_mode: "HTML",
    });
  } else {
    await tg("sendMessage", { chat_id: CHANNEL_ID, text, parse_mode: "HTML" });
  }
  delete state.signals[coin];
  console.log(`Signal closed: ${sig.side} ${coin}`);
}

(async () => {
  await loadState();
  console.log(`Copy machine v2 online. Watching ${TRADERS.length} wallets. Consensus: ${CONSENSUS_MIN}+`);
  poll();
})();
