/**
 * Access Machine — crypto-paid private channel subscriptions
 * --------------------------------------------------
 * Sells timed access to a private Telegram channel, paid in crypto via
 * NOWPayments. Handles: subscribe flow -> invoice -> IPN webhook -> grant
 * (single-use invite link) -> subscriber store -> expiry sweep -> auto-kick
 * + renewal reminders -> admin tools.
 *
 * Pure node (https + http). Long-polling for DMs, an HTTP server for the IPN
 * webhook. State in JSONBin.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN
 *   CHANNEL_ID            - private channel id (-100...). Bot must be admin with invite+ban rights.
 *   ADMIN_IDS             - comma-separated admin Telegram ids
 *   NOWPAYMENTS_API_KEY
 *   NOWPAYMENTS_IPN_SECRET
 *   PUBLIC_URL            - your Railway public URL, e.g. https://xxx.up.railway.app
 *   JSONBIN_KEY, JSONBIN_BIN_ID
 *   PORT                  - Railway sets this automatically
 */

const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const NP_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NP_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const PORT = process.env.PORT || 3000;

for (const [k, v] of Object.entries({ BOT_TOKEN, CHANNEL_ID, NP_API_KEY, NP_IPN_SECRET, PUBLIC_URL })) {
  if (!v) { console.error("Missing env:", k); process.exit(1); }
}

// ---------- plans ----------
const PLANS = {
  m1: { label: "1 Month", days: 30, usd: 49 },
  m3: { label: "3 Months", days: 90, usd: 119 },
  m12: { label: "12 Months", days: 365, usd: 349 },
};

// ---------- generic https request ----------
function request(opts, payload) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
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

function npCreateInvoice(body) {
  const payload = JSON.stringify(body);
  return request({
    hostname: "api.nowpayments.io",
    path: "/v1/invoice",
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": NP_API_KEY, "Content-Length": Buffer.byteLength(payload) },
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
// subs: { [userId]: { plan, expiry(ms), status, username, lastReminder } }
// pending: { [orderId]: { userId, plan } }
let state = { subs: {}, pending: {} };
async function loadState() {
  const r = await jsonbin("GET", `/v3/b/${JSONBIN_BIN_ID}/latest`);
  if (r && r.record) state = r.record;
  state.subs = state.subs || {};
  state.pending = state.pending || {};
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => jsonbin("PUT", `/v3/b/${JSONBIN_BIN_ID}`, state), 300);
}

// ---------- helpers ----------
const isAdmin = (uid) => ADMIN_IDS.includes(String(uid));
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// recursive sorted stringify — NOWPayments signs sorted JSON; nested objects
// must be sorted too or signatures won't match.
function sortedStringify(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(sortedStringify).join(",") + "]";
  if (obj && typeof obj === "object") {
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}

// ---------- subscribe flow ----------
async function sendPlans(chatId) {
  const rows = Object.entries(PLANS).map(([k, p]) => [{ text: `${p.label} — $${p.usd}`, callback_data: `plan:${k}` }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "💎 <b>Choose your access plan</b>\nPaid in crypto (USDT/BTC/ETH and more). Access is granted automatically once payment confirms.",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function createInvoiceFor(userId, username, planKey) {
  const plan = PLANS[planKey];
  const orderId = `${userId}:${planKey}:${crypto.randomBytes(3).toString("hex")}`;
  const inv = await npCreateInvoice({
    price_amount: plan.usd,
    price_currency: "usd",
    order_id: orderId,
    order_description: `Channel access — ${plan.label}`,
    ipn_callback_url: `${PUBLIC_URL}/ipn`,
  });
  if (!inv || !inv.invoice_url) return null;
  state.pending[orderId] = { userId, plan: planKey, username };
  saveState();
  return inv.invoice_url;
}

// ---------- granting access ----------
async function grantAccess(userId, planKey, username) {
  const plan = PLANS[planKey];
  const now = Date.now();
  const existing = state.subs[userId];
  // extend if still active, else start fresh
  const base = existing && existing.expiry > now ? existing.expiry : now;
  const expiry = base + plan.days * 86400000;
  state.subs[userId] = { plan: planKey, expiry, status: "active", username: username || (existing && existing.username) || "" , lastReminder: 0 };
  saveState();

  // single-use invite link that itself expires in 1h if unused
  const link = await tg("createChatInviteLink", {
    chat_id: CHANNEL_ID,
    member_limit: 1,
    expire_date: Math.floor((now + 3600000) / 1000),
    name: `sub:${userId}`,
  });
  const url = link && link.ok ? link.result.invite_link : null;
  await tg("sendMessage", {
    chat_id: userId,
    text: url
      ? `✅ <b>Payment confirmed!</b>\nYour access is active until <b>${fmtDate(expiry)}</b>.\n\nJoin here (single-use, expires in 1h):\n${url}`
      : `✅ Payment confirmed, access active until ${fmtDate(expiry)}. (Invite link failed — contact admin.)`,
    parse_mode: "HTML",
  });
}

async function kick(userId) {
  await tg("banChatMember", { chat_id: CHANNEL_ID, user_id: Number(userId) });
  await tg("unbanChatMember", { chat_id: CHANNEL_ID, user_id: Number(userId), only_if_banned: true }); // allow future rejoin
}

// ---------- expiry sweep ----------
async function sweep() {
  const now = Date.now();
  for (const [userId, sub] of Object.entries(state.subs)) {
    if (sub.status !== "active") continue;
    const daysLeft = (sub.expiry - now) / 86400000;
    if (sub.expiry <= now) {
      await kick(userId);
      sub.status = "expired";
      saveState();
      await tg("sendMessage", { chat_id: userId, text: "⌛️ Your access has expired and you've been removed. Send /subscribe to renew anytime." });
    } else if (daysLeft <= 3 && now - (sub.lastReminder || 0) > 86400000) {
      sub.lastReminder = now;
      saveState();
      await tg("sendMessage", { chat_id: userId, text: `⏰ Your access expires in ~${Math.ceil(daysLeft)} day(s) (${fmtDate(sub.expiry)}). Send /subscribe to renew.` });
    }
  }
}

// ---------- admin ----------
async function adminCmd(msg, cmd, args) {
  if (cmd === "/subs") {
    const list = Object.entries(state.subs).filter(([, s]) => s.status === "active");
    const txt = list.length
      ? list.map(([id, s]) => `${id} @${s.username || "?"} — ${PLANS[s.plan]?.label || s.plan} → ${fmtDate(s.expiry)}`).join("\n")
      : "No active subscribers.";
    await tg("sendMessage", { chat_id: msg.chat.id, text: txt });
  } else if (cmd === "/grant") {
    const [uid, days] = args;
    if (!uid || !days) return tg("sendMessage", { chat_id: msg.chat.id, text: "Usage: /grant <userId> <days>" });
    const now = Date.now();
    const ex = state.subs[uid] && state.subs[uid].expiry > now ? state.subs[uid].expiry : now;
    state.subs[uid] = { plan: "manual", expiry: ex + Number(days) * 86400000, status: "active", username: (state.subs[uid] || {}).username || "", lastReminder: 0 };
    saveState();
    const link = await tg("createChatInviteLink", { chat_id: CHANNEL_ID, member_limit: 1, name: `grant:${uid}` });
    await tg("sendMessage", { chat_id: uid, text: `🎁 You've been granted access until ${fmtDate(state.subs[uid].expiry)}.\n${link.ok ? link.result.invite_link : ""}` });
    await tg("sendMessage", { chat_id: msg.chat.id, text: `Granted ${days}d to ${uid}.` });
  } else if (cmd === "/revoke") {
    const uid = args[0];
    if (!uid || !state.subs[uid]) return tg("sendMessage", { chat_id: msg.chat.id, text: "No such sub." });
    await kick(uid);
    state.subs[uid].status = "revoked";
    saveState();
    await tg("sendMessage", { chat_id: msg.chat.id, text: `Revoked ${uid}.` });
  } else if (cmd === "/stats") {
    const active = Object.values(state.subs).filter((s) => s.status === "active").length;
    const mrr = Object.values(state.subs).filter((s) => s.status === "active")
      .reduce((sum, s) => sum + (PLANS[s.plan] ? PLANS[s.plan].usd / (PLANS[s.plan].days / 30) : 0), 0);
    await tg("sendMessage", { chat_id: msg.chat.id, text: `📊 Active: ${active}\nApprox MRR: $${mrr.toFixed(0)}` });
  }
}

// ---------- update handling ----------
async function onMessage(msg) {
  if (!msg.text) return;
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  if (isAdmin(msg.from.id) && ["/subs", "/grant", "/revoke", "/stats"].includes(cmd)) return adminCmd(msg, cmd, args);
  if (cmd === "/start" || cmd === "/subscribe" || cmd === "/plans") return sendPlans(msg.chat.id);
  if (cmd === "/status") {
    const sub = state.subs[msg.from.id];
    const txt = sub && sub.status === "active" ? `✅ Active until ${fmtDate(sub.expiry)}.` : "❌ No active subscription. Send /subscribe.";
    return tg("sendMessage", { chat_id: msg.chat.id, text: txt });
  }
}

async function onCallback(cq) {
  const data = cq.data || "";
  if (data.startsWith("plan:")) {
    const planKey = data.slice(5);
    if (!PLANS[planKey]) return;
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Creating invoice…" });
    const url = await createInvoiceFor(cq.from.id, cq.from.username, planKey);
    await tg("sendMessage", {
      chat_id: cq.from.id,
      text: url ? `🧾 <b>${PLANS[planKey].label}</b> — pay here:\n${url}\n\nAccess is granted automatically once payment confirms on-chain.` : "⚠️ Could not create invoice, try again.",
      parse_mode: "HTML",
    });
  }
}

// ---------- IPN webhook server ----------
const server = http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200); return res.end("ok"); } // health check
  if (req.method === "POST" && req.url === "/ipn") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const sig = req.headers["x-nowpayments-sig"];
        const body = JSON.parse(raw);
        const expected = crypto.createHmac("sha512", NP_IPN_SECRET).update(sortedStringify(body)).digest("hex");
        if (sig !== expected) { console.warn("bad IPN sig"); res.writeHead(403); return res.end(); }
        res.writeHead(200); res.end("ok"); // ack fast

        if (body.payment_status === "finished" || body.payment_status === "confirmed") {
          const pend = state.pending[body.order_id];
          const [uid, planKey] = (body.order_id || "").split(":");
          if (PLANS[planKey]) {
            await grantAccess(uid, planKey, pend && pend.username);
            delete state.pending[body.order_id];
            saveState();
            console.log("granted", uid, planKey);
          }
        }
      } catch (e) { console.error("ipn err", e.message); try { res.writeHead(500); res.end(); } catch {} }
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ---------- long-poll ----------
let offset = 0;
async function poll() {
  const res = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
  if (res && res.ok) {
    for (const u of res.result) {
      offset = u.update_id + 1;
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) { console.error("update err", e.message); }
    }
  }
  setImmediate(poll);
}

(async () => {
  await loadState();
  server.listen(PORT, () => console.log("IPN server on", PORT, "→", `${PUBLIC_URL}/ipn`));
  setInterval(sweep, 3600000); // hourly expiry sweep
  console.log("Access machine online. Plans:", Object.keys(PLANS).join(","));
  poll();
})();
