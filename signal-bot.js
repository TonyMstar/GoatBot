/**
 * Signal Machine — paid-channel trade poster & tracker
 * --------------------------------------------------
 * Admin posts a trade (entry / TP / SL); the bot formats it as a clean
 * card in your channel, stores it with a short ID, and posts follow-ups
 * when you mark a TP or SL hit. Payment-agnostic — pair this with whichever
 * access layer you pick (Stars or crypto).
 *
 * Pure node:https long-polling (your usual Railway pattern). State in JSONBin
 * so posted signals survive restarts.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN  - from @BotFather
 *   CHANNEL_ID          - the PRIVATE channel id to post into (e.g. -100xxxxxxxxxx)
 *   ADMIN_IDS           - comma-separated Telegram user ids allowed to post (e.g. 6492492818)
 *   JSONBIN_KEY         - X-Master-Key for JSONBin
 *   JSONBIN_BIN_ID      - bin id holding signal state
 *
 * Admin commands (DM the bot):
 *   /signal            - multiline; see format below
 *   /hit <id> <TPn>    - mark a take-profit level hit
 *   /sl  <id>          - mark stop-loss hit
 *   /close <id> [note] - close & summarise
 *   /active            - list open signals
 *
 * /signal format (each field on its own line, order doesn't matter):
 *   /signal
 *   PAIR: BTC
 *   SIDE: LONG
 *   ENTRY: 67000
 *   TP: 68000, 69500, 71000
 *   SL: 65500
 *   LEV: 10x
 *   NOTE: scalp — move SL to BE after TP1
 */

const https = require("node:https");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

if (!BOT_TOKEN || !CHANNEL_ID || ADMIN_IDS.length === 0) {
  console.error("Need TELEGRAM_BOT_TOKEN, CHANNEL_ID, ADMIN_IDS");
  process.exit(1);
}

// ---------- tiny https helpers ----------
function tg(method, params) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(params);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error("tg error", method, e.message);
      resolve({ ok: false });
    });
    req.write(payload);
    req.end();
  });
}

function jsonbin(method, path, body) {
  return new Promise((resolve) => {
    if (!JSONBIN_KEY || !JSONBIN_BIN_ID) return resolve(null);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const req = https.request(
      { hostname: "api.jsonbin.io", path, method, headers },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- state ----------
let state = { signals: {} }; // id -> signal object

async function loadState() {
  const res = await jsonbin("GET", `/v3/b/${JSONBIN_BIN_ID}/latest`);
  if (res && res.record) state = res.record;
  if (!state.signals) state.signals = {};
}
async function saveState() {
  await jsonbin("PUT", `/v3/b/${JSONBIN_BIN_ID}`, state);
}

// ---------- formatting ----------
function fmtNum(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 });
}
function pct(entry, target) {
  return ((target - entry) / entry) * 100;
}

function renderSignal(s) {
  const long = s.side === "LONG";
  const head = `${long ? "🟢" : "🔴"} <b>${s.side} $${s.pair}</b>${s.lev ? `   ⚡${s.lev}` : ""}`;
  const lines = [head, ""];
  lines.push(`Entry: <b>${fmtNum(s.entry)}</b>`);
  s.tps.forEach((tp, i) => {
    const hit = s.hits.includes(i + 1);
    lines.push(`${hit ? "✅" : "🎯"} TP${i + 1}: ${fmtNum(tp)}${hit ? "  (hit)" : ""}`);
  });
  lines.push(`🛑 SL: ${fmtNum(s.sl)}`);
  if (s.note) lines.push("", `📝 ${escapeHtml(s.note)}`);
  lines.push("", `#${s.pair}   <code>ID: ${s.id}</code>`);
  if (s.status === "closed") lines.push("", "⚪️ <b>CLOSED</b>");
  return lines.join("\n");
}

function escapeHtml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- signal parsing ----------
function parseSignal(text) {
  const body = text.replace(/^\/signal\b/i, "").trim();
  const fields = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Za-z]+)\s*[:=]\s*(.+?)\s*$/);
    if (m) fields[m[1].toUpperCase()] = m[2];
  }
  const pair = (fields.PAIR || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const side = (fields.SIDE || "").toUpperCase();
  const entry = Number(fields.ENTRY);
  const sl = Number(fields.SL);
  const tps = (fields.TP || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => !isNaN(x) && x > 0);
  const errs = [];
  if (!pair) errs.push("PAIR");
  if (side !== "LONG" && side !== "SHORT") errs.push("SIDE (LONG/SHORT)");
  if (!entry || isNaN(entry)) errs.push("ENTRY");
  if (!sl || isNaN(sl)) errs.push("SL");
  if (tps.length === 0) errs.push("TP (at least one)");
  if (errs.length) return { error: "Missing/invalid: " + errs.join(", ") };
  return {
    signal: {
      pair,
      side,
      entry,
      sl,
      tps,
      lev: (fields.LEV || "").trim(),
      note: (fields.NOTE || "").trim(),
      hits: [],
      status: "open",
    },
  };
}

function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

// ---------- command handlers ----------
function isAdmin(uid) {
  return ADMIN_IDS.includes(String(uid));
}

async function handleSignal(msg) {
  const { signal, error } = parseSignal(msg.text);
  if (error) return tg("sendMessage", { chat_id: msg.chat.id, text: "⚠️ " + error });
  signal.id = shortId();
  const posted = await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    text: renderSignal(signal),
    parse_mode: "HTML",
  });
  if (!posted.ok) return tg("sendMessage", { chat_id: msg.chat.id, text: "❌ Failed to post (is the bot an admin in the channel?)" });
  signal.message_id = posted.result.message_id;
  state.signals[signal.id] = signal;
  await saveState();
  await tg("sendMessage", { chat_id: msg.chat.id, text: `✅ Posted. ID: ${signal.id}` });
}

async function handleHit(msg, args) {
  const id = args[0];
  const lvl = parseInt((args[1] || "").replace(/[^0-9]/g, ""), 10);
  const s = state.signals[id];
  if (!s) return tg("sendMessage", { chat_id: msg.chat.id, text: "No signal " + id });
  if (!lvl || lvl < 1 || lvl > s.tps.length) return tg("sendMessage", { chat_id: msg.chat.id, text: "Bad TP level" });
  if (!s.hits.includes(lvl)) s.hits.push(lvl);
  s.hits.sort((a, b) => a - b);
  const move = pct(s.entry, s.tps[lvl - 1]) * (s.side === "LONG" ? 1 : -1);
  await tg("editMessageText", { chat_id: CHANNEL_ID, message_id: s.message_id, text: renderSignal(s), parse_mode: "HTML" });
  await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    reply_to_message_id: s.message_id,
    text: `✅ <b>TP${lvl} HIT</b> on $${s.pair} ${s.side}\n+${move.toFixed(2)}% from entry${s.lev ? ` (${s.lev})` : ""} 🎉`,
    parse_mode: "HTML",
  });
  await saveState();
  await tg("sendMessage", { chat_id: msg.chat.id, text: `Marked TP${lvl} on ${id}` });
}

async function handleSl(msg, args) {
  const s = state.signals[args[0]];
  if (!s) return tg("sendMessage", { chat_id: msg.chat.id, text: "No signal " + args[0] });
  s.status = "closed";
  const move = pct(s.entry, s.sl) * (s.side === "LONG" ? 1 : -1);
  await tg("editMessageText", { chat_id: CHANNEL_ID, message_id: s.message_id, text: renderSignal(s), parse_mode: "HTML" });
  await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    reply_to_message_id: s.message_id,
    text: `🛑 <b>SL hit</b> on $${s.pair} ${s.side}\n${move.toFixed(2)}% — risk managed, on to the next.`,
    parse_mode: "HTML",
  });
  await saveState();
  await tg("sendMessage", { chat_id: msg.chat.id, text: `Closed ${args[0]} at SL` });
}

async function handleClose(msg, args) {
  const s = state.signals[args[0]];
  if (!s) return tg("sendMessage", { chat_id: msg.chat.id, text: "No signal " + args[0] });
  s.status = "closed";
  const note = args.slice(1).join(" ");
  const best = s.hits.length ? Math.max(...s.hits) : 0;
  const summary = best
    ? `Closed after TP${best} ✅`
    : "Closed manually";
  await tg("editMessageText", { chat_id: CHANNEL_ID, message_id: s.message_id, text: renderSignal(s), parse_mode: "HTML" });
  await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    reply_to_message_id: s.message_id,
    text: `⚪️ <b>$${s.pair} ${s.side} closed</b>\n${summary}${note ? `\n${escapeHtml(note)}` : ""}`,
    parse_mode: "HTML",
  });
  await saveState();
  await tg("sendMessage", { chat_id: msg.chat.id, text: `Closed ${args[0]}` });
}

async function handleActive(msg) {
  const open = Object.values(state.signals).filter((s) => s.status === "open");
  if (!open.length) return tg("sendMessage", { chat_id: msg.chat.id, text: "No open signals." });
  const txt = open.map((s) => `${s.id} — ${s.side} $${s.pair} @ ${fmtNum(s.entry)} (TP hits: ${s.hits.join(",") || "—"})`).join("\n");
  await tg("sendMessage", { chat_id: msg.chat.id, text: txt });
}

// ---------- long-polling loop ----------
let offset = 0;
async function poll() {
  const res = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
  if (res && res.ok) {
    for (const u of res.result) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.text) continue;
      if (!isAdmin(msg.from.id)) continue; // ignore everyone but admins
      const [cmd, ...args] = msg.text.trim().split(/\s+/);
      try {
        if (/^\/signal/i.test(msg.text)) await handleSignal(msg);
        else if (cmd === "/hit") await handleHit(msg, args);
        else if (cmd === "/sl") await handleSl(msg, args);
        else if (cmd === "/close") await handleClose(msg, args);
        else if (cmd === "/active") await handleActive(msg);
      } catch (e) {
        console.error("handler error", e.message);
        await tg("sendMessage", { chat_id: msg.chat.id, text: "⚠️ error: " + e.message });
      }
    }
  }
  setImmediate(poll);
}

(async () => {
  await loadState();
  console.log("Signal machine online. Admins:", ADMIN_IDS.join(","));
  poll();
})();
