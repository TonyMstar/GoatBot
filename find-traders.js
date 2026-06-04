/**
 * Hyperliquid Trader Scanner
 * Finds consistent daily traders: active most days, profitable most days.
 * Run once: node find-traders.js
 */

const https = require("node:https");

const MIN_WIN_RATE       = 50;   // minimum trade win rate %
const MAX_WIN_RATE       = 98;   // above this = likely wash trader / arb bot
const MAX_TRADES_30D     = 1000; // above this = likely bot/market maker
const MIN_TRADES_30D     = 10;   // below this = not enough data
const MIN_PNL_30D        = 10000; // minimum $10k profit in 30 days
const MIN_ACTIVE_DAYS    = 10;   // must trade on at least 10 distinct days in 30
const TOP_N              = 100;  // how many leaderboard traders to scan

const THIRTY_DAYS_AGO = Date.now() - 30 * 24 * 60 * 60 * 1000;

function post(hostname, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let b = "";
      res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function get(hostname, path) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: "GET",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let b = "";
      res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function getLeaderboard() {
  console.log(`Fetching Hyperliquid leaderboard (top ${TOP_N} per window)...`);
  const data = await get("stats-data.hyperliquid.xyz", "/Mainnet/leaderboard");
  if (!data || !Array.isArray(data.leaderboardRows)) {
    console.error("Failed to fetch leaderboard — check connection.");
    return [];
  }

  const rows = data.leaderboardRows;
  const seen = new Set();
  const addrs = [];

  // Pick top N by PnL from each time window, deduped
  for (const window of ["day", "week", "month", "allTime"]) {
    const sorted = rows
      .filter(r => {
        const w = r.windowPerformances.find(p => p[0] === window);
        return w && parseFloat(w[1].pnl) > 0;
      })
      .sort((a, b) => {
        const pa = parseFloat(a.windowPerformances.find(p => p[0] === window)[1].pnl);
        const pb = parseFloat(b.windowPerformances.find(p => p[0] === window)[1].pnl);
        return pb - pa;
      })
      .slice(0, TOP_N);

    for (const r of sorted) {
      if (!seen.has(r.ethAddress)) {
        seen.add(r.ethAddress);
        addrs.push(r.ethAddress);
      }
    }
  }

  console.log(`Got ${addrs.length} unique addresses to scan.\n`);
  return addrs;
}

async function analyzeTrader(address) {
  // Try both fill endpoint formats
  let fills = await post("api.hyperliquid.xyz", "/info", {
    type: "userFillsByTime",
    user: address,
    startTime: THIRTY_DAYS_AGO,
    endTime: Date.now(),
  });

  if (!fills || !Array.isArray(fills) || fills.length === 0) {
    fills = await post("api.hyperliquid.xyz", "/info", {
      type: "userFills",
      user: address,
    });
  }

  if (!fills || !Array.isArray(fills) || fills.length === 0) {
    process.stdout.write(`(no fills) `);
    return null;
  }

  // Filter to last 30 days
  fills = fills.filter(f => f.time >= THIRTY_DAYS_AGO);

  // Only count closing trades (closedPnl != 0 — opening trades have "0.0")
  const closed = fills.filter(f => f.closedPnl !== undefined && parseFloat(f.closedPnl) !== 0);
  const wins   = closed.filter(f => parseFloat(f.closedPnl) > 0);
  const losses = closed.filter(f => parseFloat(f.closedPnl) < 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const totalPnl = closed.reduce((sum, f) => sum + parseFloat(f.closedPnl), 0);

  // Daily activity: group all fills by day, then check PnL per day
  const dayMap = {};
  for (const f of fills) {
    const day = new Date(f.time).toISOString().slice(0, 10);
    if (!dayMap[day]) dayMap[day] = 0;
    if (f.closedPnl !== undefined) dayMap[day] += parseFloat(f.closedPnl);
  }
  const activeDays = Object.keys(dayMap).length;
  const greenDays  = Object.values(dayMap).filter(pnl => pnl > 0).length;
  const profitableDayRate = activeDays > 0 ? greenDays / activeDays : 0;

  process.stdout.write(`(fills:${fills.length} closed:${closed.length} wr:${winRate.toFixed(0)}% pnl:$${totalPnl.toFixed(0)} days:${activeDays} green:${greenDays}) `);

  if (closed.length < MIN_TRADES_30D) return null;
  if (closed.length > MAX_TRADES_30D) return null;
  if (winRate < MIN_WIN_RATE)  return null;
  if (winRate > MAX_WIN_RATE)  return null;
  if (totalPnl < MIN_PNL_30D) return null;
  if (activeDays < MIN_ACTIVE_DAYS) return null;

  // Check if they have current open positions (active directional trader)
  const state = await post("api.hyperliquid.xyz", "/info", { type: "clearinghouseState", user: address });
  const openPositions = state && state.assetPositions
    ? state.assetPositions.filter(ap => ap.position && Math.abs(parseFloat(ap.position.szi || "0")) > 1e-8)
    : [];

  return {
    address,
    winRate: winRate.toFixed(1),
    totalPnl: totalPnl.toFixed(0),
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    activeDays,
    greenDays,
    profitableDayRate: (profitableDayRate * 100).toFixed(0),
    openPositions: openPositions.map(ap => `${ap.position.coin} ${parseFloat(ap.position.szi) > 0 ? "LONG" : "SHORT"}`),
  };
}

async function main() {
  const addresses = await getLeaderboard();
  if (addresses.length === 0) {
    console.error("Could not fetch leaderboard. Check your internet connection.");
    return;
  }

  console.log(`Scanning ${addresses.length} traders...\n`);

  const qualified = [];

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    process.stdout.write(`[${i + 1}/${addresses.length}] ${addr.slice(0, 10)}... `);

    const result = await analyzeTrader(addr);
    if (result) {
      qualified.push(result);
      process.stdout.write(`✅ Win: ${result.winRate}% | PnL: $${Number(result.totalPnl).toLocaleString()} | Trades: ${result.trades} | Days: ${result.activeDays} (${result.profitableDayRate}% green)\n`);
    } else {
      process.stdout.write(`❌\n`);
    }

    await new Promise(r => setTimeout(r, 400)); // rate limit
  }

  console.log("\n" + "=".repeat(60));
  console.log(`QUALIFIED TRADERS (${qualified.length} found)`);
  console.log("=".repeat(60));

  if (qualified.length === 0) {
    console.log("No traders met the criteria. Try lowering MIN_WIN_RATE or MIN_PNL_30D at the top of the file.");
    return;
  }

  // Sort by win rate descending
  qualified.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));

  for (const t of qualified) {
    console.log(`\nAddress:   ${t.address}`);
    console.log(`Win Rate:  ${t.winRate}%`);
    console.log(`30d PnL:   $${Number(t.totalPnl).toLocaleString()}`);
    console.log(`Trades:    ${t.wins}W / ${t.losses}L (${t.trades} total)`);
    console.log(`Active:    ${t.activeDays} days | ${t.greenDays} green (${t.profitableDayRate}%)`);
    console.log(`Open Now:  ${t.openPositions.length > 0 ? t.openPositions.join(", ") : "none"}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("TRADER_ADDRESSES for Railway (copy this):");
  console.log("=".repeat(60));
  console.log(qualified.map(t => t.address).join(","));
}

main();
