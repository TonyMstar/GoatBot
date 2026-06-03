/**
 * Copy Machine — auto-mirrors top Hyperliquid trader positions to Telegram channel
 * --------------------------------------------------
 * Polls each tracked wallet on Hyperliquid every minute. When a new position
 * opens → posts a formatted signal card. When it closes → posts the result.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   - bot token (can reuse Goat Signals token)
 *   CHANNEL_ID           - private channel id (-100...)
 *   TRADER_ADDRESSES     - comma-separated HL wallet addresses to monitor
 *   TOP_TRADERS_COUNT    - how many leaderboard traders to auto-fetch (default 5)
 *   JSONBIN_KEY          - X-Master-Key for JSONBin (optional — for state persistence)
 *   JSONBIN_BIN_ID       - separate bin id for copy bot state
 *   POLL_INTERVAL        - poll interval ms (default 60000)
 */

const https = require("node:https");
const crypto = require("node:crypto");

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.CHANNEL_ID;
const JSONBIN_KEY   = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "60000");
const TOP_N         = parseInt(process.env.TOP_TRADERS_COUNT || "5");
const MANUAL_TRADERS = (process.env.TRADER_ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("Need TELEGRAM_BOT_TOKEN and CHANNEL_ID");
  process.exit(1);
}

// ---------- HTTP helpers ----------
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
// positions: { [traderAddr]: { [coin]: { side, entry, size, lev, messageId, openedAt } } }
let state = { positions: {}, traders: [] };

async function loadState() {
  const r = await jsonbin("GET", `/v3/b/${JSONBIN_BIN_ID}/latest`);
  if (r && r.record) state = r.record;
  state.positions = state.positions || {};
  state.traders   = state.traders   || [];
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => jsonbin("PUT", `/v3/b/${JSONBIN_BIN_ID}`, state), 300);
}

// ---------- leaderboard ----------
async function fetchTopTraders() {
  if (MANUAL_TRADERS.length > 0) {
    console.log("Using manual trader list:", MANUAL_TRADERS.length);
    return MANUAL_TRADERS;
  }

  const res = await hl({ type: "leaderboard", window: "allTime" });
  if (res && Array.isArray(res)) {
    const addrs = res
      .slice(0, TOP_N)
      .map(t => t.ethAddress || t.user || t.address)
      .filter(a => a && a.startsWith("0x"));
    if (addrs.length > 0) {
      console.log("Fetched top traders from leaderboard:", addrs.length);
      return addrs;
    }
  }

  if (state.traders.length > 0) {
    console.log("Using cached trader list:", state.traders.length);
    return state.traders;
  }

  console.warn("No traders found. Set TRADER_ADDRESSES env var with comma-separated HL wallet addresses.");
  return [];
}

// ---------- formatting ----------
function fmtNum(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function renderOpen(coin, side, entry, lev, traderAddr) {
  const long = side === "LONG";
  return [
    `${long ? "🟢" : "🔴"} <b>${side} $${coin}</b>${lev ? `   ⚡${lev}x` : ""}`,
    "",
    `Entry: <b>${fmtNum(entry)}</b>`,
    `🎯 TP/SL: manage your own risk`,
    "",
    `👤 Copied from: <code>${shortAddr(traderAddr)}</code>`,
    `#${coin} #copytrade`,
  ].join("\n");
}

function renderClose(coin, side, entry, exitPrice, traderAddr) {
  const move = exitPrice
    ? ((exitPrice - entry) / entry) * 100 * (side === "LONG" ? 1 : -1)
    : null;
  return [
    `⚪️ <b>$${coin} ${side} closed</b>`,
    move !== null ? `${move >= 0 ? "+" : ""}${move.toFixed(2)}% from entry` : "Position closed",
    `👤 Trader: <code>${shortAddr(traderAddr)}</code>`,
  ].join("\n");
}

// ---------- position checking ----------
async function checkTrader(address) {
  const res = await hl({ type: "clearinghouseState", user: address });
  if (!res || !Array.isArray(res.assetPositions)) return;

  const current = {};
  for (const ap of res.assetPositions) {
    const pos = ap.position;
    if (!pos || !pos.coin || !pos.szi) continue;
    const size = parseFloat(pos.szi);
    if (Math.abs(size) < 1e-8) continue;

    current[pos.coin] = {
      side:  size > 0 ? "LONG" : "SHORT",
      entry: parseFloat(pos.entryPx),
      size:  Math.abs(size),
      lev:   pos.leverage ? pos.leverage.value : null,
    };
  }

  const prev = state.positions[address] || {};

  // Detect new / flipped positions
  for (const [coin, pos] of Object.entries(current)) {
    const old = prev[coin];
    if (!old) {
      // brand new position
      const posted = await tg("sendMessage", {
        chat_id: CHANNEL_ID,
        text: renderOpen(coin, pos.side, pos.entry, pos.lev, address),
        parse_mode: "HTML",
      });
      if (!state.positions[address]) state.positions[address] = {};
      state.positions[address][coin] = {
        ...pos,
        messageId: posted && posted.ok ? posted.result.message_id : null,
        openedAt: Date.now(),
      };
      console.log(`Opened: ${shortAddr(address)} ${pos.side} ${coin} @ ${pos.entry}`);
    } else if (old.side !== pos.side) {
      // direction flipped — close old, open new
      await postClose(address, coin, old, pos.entry);
      const posted = await tg("sendMessage", {
        chat_id: CHANNEL_ID,
        text: renderOpen(coin, pos.side, pos.entry, pos.lev, address),
        parse_mode: "HTML",
      });
      state.positions[address][coin] = {
        ...pos,
        messageId: posted && posted.ok ? posted.result.message_id : null,
        openedAt: Date.now(),
      };
    }
    // size-only changes (adding to position) are silently updated
    if (state.positions[address] && state.positions[address][coin]) {
      state.positions[address][coin].size = pos.size;
    }
  }

  // Detect closed positions
  for (const [coin, old] of Object.entries(prev)) {
    if (!current[coin]) {
      await postClose(address, coin, old, null);
      delete state.positions[address][coin];
      console.log(`Closed: ${shortAddr(address)} ${old.side} ${coin}`);
    }
  }

  saveState();
}

async function postClose(address, coin, old, exitPrice) {
  const text = renderClose(coin, old.side, old.entry, exitPrice, address);
  if (old.messageId) {
    await tg("sendMessage", {
      chat_id: CHANNEL_ID,
      reply_to_message_id: old.messageId,
      text,
      parse_mode: "HTML",
    });
  } else {
    await tg("sendMessage", { chat_id: CHANNEL_ID, text, parse_mode: "HTML" });
  }
}

// ---------- poll loop ----------
async function poll() {
  try {
    const traders = await fetchTopTraders();
    if (traders.length === 0) {
      setTimeout(poll, POLL_INTERVAL);
      return;
    }

    state.traders = traders;

    for (const address of traders) {
      await checkTrader(address);
      await new Promise(r => setTimeout(r, 500)); // avoid hammering the API
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
  setTimeout(poll, POLL_INTERVAL);
}

(async () => {
  await loadState();
  console.log(`Copy machine online. Poll: ${POLL_INTERVAL}ms, Top N: ${TOP_N}`);
  if (MANUAL_TRADERS.length > 0) console.log("Monitoring:", MANUAL_TRADERS.join(", "));
  poll();
})();
