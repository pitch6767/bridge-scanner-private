// bridge-scanner v1 — Livre 4 : triangle U/S/F, phase scanner S-F (paper)
// Node >= 18, zéro dépendance. Port 8085.
"use strict";
const VERSION = "1.18";

const http = require("http");
const fs = require("fs");
const path = require("path");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const STATE_FILE = path.join(__dirname, "state.json");

// ---------- État ----------
let state = {
  started_at: new Date().toISOString(),
  last_poll: null,
  market_open: false,
  tickers: {},          // symbol -> { s_price, f_price, f_funding, spread_pct, spread_net_pct, s_status, f_status, updated }
  dislocations: [],     // { symbol, t_start, spread_net_pct, survived_60s, resolved, t_end }
  positions: [],        // paper : { id, symbol, side, t_open, s_open, f_open, spread_open_pct, size_usd }
  history: [],          // paper : positions cloturees + { t_close, s_close, f_close, spread_close_pct, pnl_usd, reason }
  counters: { detected: 0, survived_60s: 0, weekends_logged: 0, trades: 0, wins: 0, pnl_total_usd: 0 },
  weekend_log: [],      // { weekend_of, symbol, spread_fri_22h, spread_mon_open, converged }
  errors: [],
  discover_log: [],
  sol_mints: {}
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.dislocations = prev.dislocations || [];
    state.positions = (prev.positions || []).filter(p => (p.kind || "ARB") !== "CARRY");
    state.history = (prev.history || []).filter(h => (h.kind || "ARB") !== "CARRY");
    state.sol_mints = prev.sol_mints || {};
    state.counters = Object.assign(state.counters, prev.counters || {});
    // Purge CARRY : recalcul des compteurs de trades depuis l'historique restant
    state.counters.trades = state.history.length;
    state.counters.wins = state.history.filter(h => h.pnl_usd > 0).length;
    state.counters.pnl_total_usd = Math.round(state.history.reduce((a, h) => a + (h.pnl_usd || 0), 0) * 100) / 100;
    state.weekend_log = prev.weekend_log || [];
  }
} catch (e) { /* état neuf */ }

function saveStateAtomic() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- Heures de marché US (approx, sans jours fériés en v1) ----------
function usMarketOpen(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "numeric", minute: "numeric", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const wd = parts.weekday;
  if (wd === "Sat" || wd === "Sun") return false;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ---------- Feeds ----------
function normCoin(name) {
  // "xyz:TSLA" et "TSLA" doivent matcher, quel que soit le format renvoyé par l'API
  return String(name).toUpperCase().split(":").pop();
}

// ---------- Auto-découverte de l'univers ----------
// Intersection : xStocks listés sur Bybit spot × perps equity du dex xyz sur HL.
// La liste manuelle de config.json sert de base ; la découverte ajoute le reste.
let UNIVERSE = CONFIG.tickers.slice();

function bybitToTicker(sym) {
  // "TSLAXUSDT" -> "TSLA"
  if (!sym.endsWith("XUSDT")) return null;
  return sym.slice(0, -5);
}

async function hlDexList() {
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "perpDexs" }),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    const names = (Array.isArray(j) ? j : [])
      .map(x => typeof x === "string" ? x : (x && x.name))
      .filter(n => n && n !== "");
    if (!names.includes(CONFIG.hl_dex)) names.push(CONFIG.hl_dex);
    return names;
  } catch (e) {
    pushErr("perpDexs: " + e.message);
    return [CONFIG.hl_dex];
  }
}

async function hlDexCoins(dex) {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs", dex }),
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json();
  const universe = (j[0] && j[0].universe) || [];
  const out = {};
  for (const u of universe) {
    if (u.isDelisted) continue;
    out[normCoin(u.name)] = u.name;
  }
  return out;
}

async function discoverUniverse() {
  if (!CONFIG.auto_discover) return;
  try {
    // 1. Tous les xStocks cotés sur Bybit
    const r = await fetch("https://api.bybit.com/v5/market/instruments-info?category=spot&symbolType=xstocks&limit=200", { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const bybitList = {};
    for (const it of ((j && j.result && j.result.list) || [])) {
      if (it.status && it.status !== "Trading") continue;
      const tk = bybitToTicker(it.symbol);
      if (tk) bybitList[tk] = it.symbol;
    }
    // 2. Tous les dex HL, et leurs coins
    const dexes = await hlDexList();
    const dlog = [];
    dlog.push("dex HL: " + dexes.join(", "));
    const hlByTicker = {}; // ticker -> { dex, name } (premier dex qui le cote)
    for (const dex of dexes) {
      try {
        const coins = await hlDexCoins(dex);
        dlog.push(dex + ": " + Object.keys(coins).length + " marches");
        for (const tk of Object.keys(coins)) {
          if (!hlByTicker[tk]) hlByTicker[tk] = { dex, name: coins[tk], dexes: [dex] };
          else hlByTicker[tk].dexes.push(dex);
        }
      } catch (e) { dlog.push(dex + ": ERREUR " + e.message); }
    }
    // 3. Reconstruire l'univers : intersection stricte, entrées manuelles validées
    const manual = CONFIG.tickers.filter(t =>
      bybitList[t.symbol] && (hlByTicker[t.symbol] || t.hl_coin));
    const newUniverse = [];
    const seen = new Set();
    for (const t of manual) {
      const hl = hlByTicker[t.symbol];
      newUniverse.push({ symbol: t.symbol, source: "bybit", bybit_symbol: bybitList[t.symbol],
                         hl_coin: hl ? hl.name : t.hl_coin,
                         hl_dex: hl ? hl.dex : CONFIG.hl_dex });
      seen.add(t.symbol);
    }
    for (const tk of Object.keys(bybitList).sort()) {
      if (seen.has(tk) || !hlByTicker[tk]) continue;
      newUniverse.push({ symbol: tk, source: "bybit", bybit_symbol: bybitList[tk],
                         hl_coin: hlByTicker[tk].name, hl_dex: hlByTicker[tk].dex });
      seen.add(tk);
      if (newUniverse.length >= CONFIG.max_universe) break;
    }
    // 3b. Actions cotees sur HL mais absentes de Bybit : jambe S via xStock Solana (Jupiter)
    dlog.push("Bybit xStocks: " + Object.keys(bybitList).length + " | HL tickers: " + Object.keys(hlByTicker).length);
    const missing = Object.keys(hlByTicker).filter(tk => !seen.has(tk)).sort();
    const solAdded = [], solMissed = [];
    for (const tk of missing) {
      if (newUniverse.length >= CONFIG.max_universe) break;
      if (!/^[A-Z]{1,6}$/.test(tk)) continue;
      try {
        const mint = await jupFindXStock(tk);
        if (mint) {
          newUniverse.push({ symbol: tk, source: "sol", sol_mint: mint,
                             hl_coin: hlByTicker[tk].name, hl_dex: hlByTicker[tk].dex });
          seen.add(tk); solAdded.push(tk);
        } else { solMissed.push(tk); }
      } catch (e) { solMissed.push(tk + "(err)"); }
    }
    const multi = Object.keys(hlByTicker).filter(tk => hlByTicker[tk].dexes && hlByTicker[tk].dexes.length > 1)
      .map(tk => tk + "(" + hlByTicker[tk].dexes.join("+") + ")");
    dlog.push("multi-dex F-F: [" + multi.slice(0, 15).join(",") + "]");
    dlog.push("ajout Solana: [" + solAdded.join(",") + "]");
    dlog.push("sans jambe S: [" + solMissed.slice(0, 25).join(",") + "]");
    state.discover_log = dlog;
    if (newUniverse.length > 0) UNIVERSE = newUniverse;
    state.universe_size = UNIVERSE.length;
    state.universe_dexes = [...new Set(UNIVERSE.map(t => t.hl_dex))];
    console.log("univers: " + UNIVERSE.length + " tickers sur dex [" + state.universe_dexes.join(",") + "]");
  } catch (e) {
    pushErr("discover: " + e.message);
  }
}

// ---------- Jambe S secondaire : xStocks Solana via Jupiter ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jupFindXStock(ticker) {
  if (state.sol_mints[ticker]) return state.sol_mints[ticker]; // cache persistant : zero appel
  await sleep(350); // etalement anti-429
  const q = ticker + "x";
  const r = await fetch("https://lite-api.jup.ag/tokens/v2/search?query=" + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j.tokens || j.data || []);
  for (const t of list) {
    const sym = String(t.symbol || "").toUpperCase();
    const name = String(t.name || "").toLowerCase();
    if (sym === q.toUpperCase() && name.includes("xstock")) {
      const mint = t.id || t.address || t.mint || null;
      if (mint) { state.sol_mints[ticker] = mint; saveStateAtomic(); }
      return mint;
    }
  }
  return null;
}

const jupCache = { prices: {}, ts: 0, backoffUntil: 0 };

async function jupPrices(mints) {
  const now = Date.now();
  if (now < jupCache.backoffUntil) return jupCache.prices;          // en penalite : on sert le cache
  if (now - jupCache.ts < 60000 && jupCache.ts > 0) return jupCache.prices; // prix Solana rafraichis toutes les 60s max
  const out = {};
  let got429 = false;
  for (let i = 0; i < mints.length; i += 20) {
    const chunk = mints.slice(i, i + 20);
    if (i > 0) await sleep(500);
    let got = false;
    for (const base of ["https://lite-api.jup.ag/price/v3?ids=", "https://lite-api.jup.ag/price/v2?ids="]) {
      try {
        const r = await fetch(base + chunk.join(","), { signal: AbortSignal.timeout(8000) });
        if (r.status === 429) { got429 = true; break; }
        if (!r.ok) { pushErr("jup " + (base.includes("v3") ? "v3" : "v2") + ": HTTP " + r.status); continue; }
        const j = await r.json();
        const data = j.data || j;
        for (const m of chunk) {
          const d = data[m];
          if (d) {
            const p = parseFloat(d.usdPrice !== undefined ? d.usdPrice : d.price);
            if (isFinite(p) && p > 0) { out[m] = p; got = true; }
          }
        }
        if (got) break;
      } catch (e) {
        pushErr("jup: " + e.message);
      }
    }
    if (got429) break;
  }
  if (got429) {
    jupCache.backoffUntil = now + 5 * 60000; // pause 5 min, on sert le dernier cache
    pushErr("jup: 429 - backoff 5min (cache servi)");
    return jupCache.prices;
  }
  if (Object.keys(out).length) { jupCache.prices = out; jupCache.ts = now; }
  return jupCache.prices;
}

async function fetchSpot() {
  const out = {};
  const bybitT = UNIVERSE.filter(t => (t.source || "bybit") === "bybit");
  const solT = UNIVERSE.filter(t => t.source === "sol");
  const tasks = bybitT.map(async (t) => {
    try {
      const url = "https://api.bybit.com/v5/market/tickers?category=spot&symbol=" + t.bybit_symbol;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const d = j && j.result && j.result.list && j.result.list[0];
      if (d && d.bid1Price && d.ask1Price) {
        const bid = parseFloat(d.bid1Price), ask = parseFloat(d.ask1Price);
        out[t.symbol] = { mid: (bid + ask) / 2, bid, ask, status: "OK" };
      } else if (d && d.lastPrice) {
        out[t.symbol] = { mid: parseFloat(d.lastPrice), status: "OK_LAST" };
      } else {
        out[t.symbol] = { status: "UNKNOWN_PAIR" };
      }
    } catch (e) {
      out[t.symbol] = { status: "ERR" };
    }
  });
  if (solT.length) {
    tasks.push((async () => {
      try {
        const prices = await jupPrices(solT.map(t => t.sol_mint));
        for (const t of solT) {
          const p = prices[t.sol_mint];
          out[t.symbol] = p ? { mid: p, status: "OK_SOL" } : { status: "NO_SOL_PRICE" };
        }
      } catch (e) {
        for (const t of solT) out[t.symbol] = { status: "ERR" };
      }
    })());
  }
  await Promise.all(tasks);
  return out;
}

async function fetchHyperliquid() {
  const out = {};
  const dexes = [...new Set(UNIVERSE.map(t => t.hl_dex || CONFIG.hl_dex))];
  const byDex = {};
  await Promise.all(dexes.map(async (dex) => {
    try { byDex[dex] = await hlDexCoinsCtx(dex); } catch (e) { byDex[dex] = null; pushErr("hl " + dex + ": " + e.message); }
  }));
  for (const t of UNIVERSE) {
    const dex = t.hl_dex || CONFIG.hl_dex;
    const data = byDex[dex];
    if (!data) { out[t.symbol] = { status: "NO_DATA" }; continue; }
    const want = normCoin(t.hl_coin);
    const hit = data[want];
    if (hit) {
      out[t.symbol] = { mark: hit.mark, funding: hit.funding, status: "OK" };
    } else {
      out[t.symbol] = { status: "UNKNOWN_COIN" };
    }
  }
  return out;
}

async function hlDexCoinsCtx(dex) {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs", dex }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json();
  const universe = (j[0] && j[0].universe) || [];
  const ctxs = j[1] || [];
  const out = {};
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].isDelisted || !ctxs[i]) continue;
    out[normCoin(universe[i].name)] = {
      mark: parseFloat(ctxs[i].markPx),
      funding: parseFloat(ctxs[i].funding || 0)
    };
  }
  return out;
}

// ---------- Boucle scanner ----------
const totalFeesPct =
  CONFIG.assumed_fees_pct.spot_taker +
  CONFIG.assumed_fees_pct.hl_taker +
  CONFIG.assumed_fees_pct.slippage_buffer;

async function poll() {
  const now = new Date();
  state.market_open = usMarketOpen(now);
  let kr = {}, hl = {};
  try { kr = await fetchSpot(); } catch (e) { pushErr("bybit: " + e.message); }
  try { hl = await fetchHyperliquid(); } catch (e) { pushErr("hyperliquid: " + e.message); }

  for (const t of UNIVERSE) {
    const s = kr[t.symbol] || { status: "NO_DATA" };
    const f = hl[t.symbol] || { status: "NO_DATA" };
    const rec = state.tickers[t.symbol] || {};
    rec.s_status = s.status; rec.f_status = f.status;
    rec.s_price = s.mid || null;
    rec.f_price = f.mark || null;
    rec.f_funding = (f.funding !== undefined) ? f.funding : null;
    if (rec.f_funding !== null && isFinite(rec.f_funding)) {
      rec.funding_ema = rec.funding_ema === undefined || rec.funding_ema === null
        ? rec.f_funding
        : rec.funding_ema + 0.008 * (rec.f_funding - rec.funding_ema); // ~30min de lissage a 15s/poll
      rec.funding_obs = (rec.funding_obs || 0) + 1;
    }
    if ((s.status === "OK" || s.status === "OK_SOL" || s.status === "OK_LAST") && f.status === "OK") {
      const spread = ((f.mark - s.mid) / s.mid) * 100; // F riche > 0
      rec.spread_pct = round4(spread);
      rec.spread_net_pct = round4(Math.abs(spread) - totalFeesPct) * Math.sign(spread);
      if (Math.abs(spread) > 3.0) {
        rec.s_status = "DATA_SUSPECT"; // prix spot probablement perime/illiquide : on observe, on ne trade pas
      } else {
        trackDislocation(t.symbol, rec.spread_net_pct, now);
        paperEngine(t.symbol, rec, now);
      }
    } else {
      rec.spread_pct = null; rec.spread_net_pct = null;
    }
    rec.updated = now.toISOString();
    state.tickers[t.symbol] = rec;
  }
  state.last_poll = now.toISOString();
  saveStateAtomic();
}

// ---------- Moteur paper ----------
// Entrée : |spread net| >= entry_net_pct → short la jambe riche / long la jambe pauvre
// Sortie : |spread brut| <= exit_gross_pct (convergence) OU time stop
const P = CONFIG.paper;
const roundTripFeesPct = 2 * (CONFIG.assumed_fees_pct.spot_taker + CONFIG.assumed_fees_pct.hl_taker) + CONFIG.assumed_fees_pct.slippage_buffer;

function paperEngine(symbol, rec, now) {
  if (rec.spread_pct === null) return;
  const open = state.positions.find(p => p.symbol === symbol);

  if (open && rec.f_funding !== null && isFinite(rec.f_funding)) {
    const dir = open.side === "SHORT_F_LONG_S" ? 1 : -1;
    open.funding_usd = (open.funding_usd || 0) + rec.f_funding * open.size_usd * (CONFIG.poll_interval_sec / 3600) * dir;
  }

  if (!open) {
    const CR = P.carry || {};
    if (CR.enabled && rec.funding_ema !== undefined && rec.funding_ema !== null
        && (rec.funding_obs || 0) >= (CR.min_obs || 60)
        && state.positions.length < P.max_open_positions
        && Math.abs(rec.spread_pct) <= (CR.max_spread_entry_pct || 0.15)) {
      const aprPct = rec.funding_ema * 24 * 365 * 100;
      if (Math.abs(aprPct) >= (CR.min_apr_pct || 15)) {
        const cpos = {
          id: Date.now().toString(36) + "-" + symbol,
          symbol, kind: "CARRY",
          side: aprPct > 0 ? "SHORT_F_LONG_S" : "LONG_F_SHORT_S",
          t_open: now.toISOString(),
          s_open: rec.s_price, f_open: rec.f_price,
          spread_open_pct: rec.spread_pct,
          apr_open_pct: Math.round(aprPct * 100) / 100,
          size_usd: P.size_usd_per_leg, funding_usd: 0,
          s_depth_usd: null, f_depth_usd: null, max_size_usd: null
        };
        state.positions.push(cpos);
        attachDepth(cpos).catch(() => {});
        return;
      }
    }
    if (Math.abs(rec.spread_net_pct) >= P.entry_net_pct && state.positions.length < P.max_open_positions) {
      const pos = {
        id: Date.now().toString(36) + "-" + symbol,
        symbol, kind: "ARB",
        side: rec.spread_pct > 0 ? "SHORT_F_LONG_S" : "LONG_F_SHORT_S",
        t_open: now.toISOString(),
        s_open: rec.s_price, f_open: rec.f_price,
        spread_open_pct: rec.spread_pct,
        size_usd: P.size_usd_per_leg, funding_usd: 0,
        s_depth_usd: null, f_depth_usd: null, max_size_usd: null
      };
      state.positions.push(pos);
      attachDepth(pos).catch(() => {});
    }
    return;
  }

  const ageH = (now - new Date(open.t_open)) / 3600000;
  const sameSign = Math.sign(rec.spread_pct) === Math.sign(open.spread_open_pct);
  let shouldClose = false, closeReason = "";
  if (open.kind === "CARRY") {
    const CR = P.carry || {};
    const emaApr = (rec.funding_ema !== undefined && rec.funding_ema !== null ? rec.funding_ema : (rec.f_funding || 0)) * 24 * 365 * 100;
    const receiveApr = open.side === "SHORT_F_LONG_S" ? emaApr : -emaApr;
    if (receiveApr < (CR.exit_apr_pct || 3)) {
      if (!open.below_since) open.below_since = now.toISOString();
    } else {
      open.below_since = null;
    }
    const belowH = open.below_since ? (now - new Date(open.below_since)) / 3600000 : 0;
    if (receiveApr < (CR.hard_exit_apr_pct !== undefined ? CR.hard_exit_apr_pct : -10) && belowH >= 0.25) {
      shouldClose = true; closeReason = "CARRY_PAIE";
    } else if (ageH >= (CR.min_hold_hours || 6) && belowH >= (CR.exit_patience_hours || 2)) {
      shouldClose = true; closeReason = "CARRY_APR_BAS";
    } else if (ageH >= (CR.max_hold_hours || 336)) {
      shouldClose = true; closeReason = "TIME_STOP";
    }
  } else {
    if (Math.abs(rec.spread_pct) <= P.exit_gross_pct) { shouldClose = true; closeReason = "CONVERGENCE"; }
    else if (ageH >= P.max_hold_hours) { shouldClose = true; closeReason = "TIME_STOP"; }
    else if (!sameSign) { shouldClose = true; closeReason = "CROSS_ZERO"; }
  }

  if (shouldClose) {
    const captured = sameSign
      ? Math.abs(open.spread_open_pct) - Math.abs(rec.spread_pct)
      : Math.abs(open.spread_open_pct) + Math.abs(rec.spread_pct);
    const feesPct = open.kind === "CARRY" ? ((P.carry || {}).fees_roundtrip_pct || 0.15) : roundTripFeesPct;
    const pnl = (captured - feesPct) / 100 * open.size_usd + (open.funding_usd || 0);
    const closed = Object.assign({}, open, {
      t_close: now.toISOString(),
      s_close: rec.s_price, f_close: rec.f_price,
      spread_close_pct: rec.spread_pct,
      funding_usd: Math.round((open.funding_usd || 0) * 100) / 100,
      pnl_usd: Math.round(pnl * 100) / 100,
      reason: closeReason
    });
    state.history.unshift(closed);
    state.history = state.history.slice(0, 200);
    state.positions = state.positions.filter(p => p.id !== open.id);
    state.counters.trades++;
    if (pnl > 0) state.counters.wins++;
    state.counters.pnl_total_usd = Math.round((state.counters.pnl_total_usd + pnl) * 100) / 100;
  }
}


// ---------- Profondeur exécutable au moment du trade ----------
const DEPTH_BAND_PCT = 0.10; // on cumule les niveaux jusqu'a 0.10% d'impact

async function bybitDepthUsd(symbol, side) {
  // side "buy": on consomme les asks ; "sell": les bids
  try {
    const r = await fetch("https://api.bybit.com/v5/market/orderbook?category=spot&symbol=" + symbol + "&limit=50", { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const ob = j && j.result;
    if (!ob) return null;
    const levels = side === "buy" ? ob.a : ob.b;
    if (!levels || !levels.length) return null;
    const best = parseFloat(levels[0][0]);
    let usd = 0;
    for (const [pxs, qs] of levels) {
      const px = parseFloat(pxs), q = parseFloat(qs);
      if (Math.abs(px - best) / best * 100 > DEPTH_BAND_PCT) break;
      usd += px * q;
    }
    return Math.round(usd);
  } catch (e) { return null; }
}

async function hlDepthUsd(coin, side) {
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin }),
      signal: AbortSignal.timeout(6000)
    });
    const j = await r.json();
    const lv = j && j.levels;
    if (!lv || lv.length < 2) return null;
    const levels = side === "buy" ? lv[1] : lv[0]; // [bids, asks]
    if (!levels || !levels.length) return null;
    const best = parseFloat(levels[0].px);
    let usd = 0;
    for (const l of levels) {
      const px = parseFloat(l.px), q = parseFloat(l.sz);
      if (Math.abs(px - best) / best * 100 > DEPTH_BAND_PCT) break;
      usd += px * q;
    }
    return Math.round(usd);
  } catch (e) { return null; }
}

async function attachDepth(pos) {
  const t = UNIVERSE.find(x => x.symbol === pos.symbol);
  if (!t) return;
  // SHORT_F_LONG_S : on achete S (asks) et on vend F (bids) ; inverse sinon
  const sSide = pos.side === "SHORT_F_LONG_S" ? "buy" : "sell";
  const fSide = pos.side === "SHORT_F_LONG_S" ? "sell" : "buy";
  const [sD, fD] = await Promise.all([
    (t.source || "bybit") === "bybit" ? bybitDepthUsd(t.bybit_symbol, sSide) : Promise.resolve(null),
    hlDepthUsd(t.hl_coin, fSide)
  ]);
  pos.s_depth_usd = sD;   // null = DEX onchain, profondeur non mesuree en v1
  pos.f_depth_usd = fD;
  pos.max_size_usd = (sD !== null && fD !== null) ? Math.min(sD, fD) : (fD !== null ? fD : sD);
}

function trackDislocation(symbol, netPct, now) {
  if (netPct === null) return;
  const th = CONFIG.dislocation_threshold_pct;
  const open = state.dislocations.find(d => d.symbol === symbol && !d.resolved);
  if (Math.abs(netPct) >= th && !open) {
    state.dislocations.push({
      symbol, t_start: now.toISOString(), spread_net_pct: netPct,
      survived_60s: false, resolved: false, t_end: null
    });
    state.counters.detected++;
  } else if (open) {
    const age = (now - new Date(open.t_start)) / 1000;
    if (Math.abs(netPct) >= th && age >= CONFIG.survival_check_sec && !open.survived_60s) {
      open.survived_60s = true;
      state.counters.survived_60s++;
    }
    if (Math.abs(netPct) < th) {
      open.resolved = true;
      open.t_end = now.toISOString();
    }
  }
  if (state.dislocations.length > 500) state.dislocations = state.dislocations.slice(-500);
}

function pushErr(msg) {
  state.errors.unshift({ t: new Date().toISOString(), msg });
  state.errors = state.errors.slice(0, 20);
}
function round4(x) { return Math.round(x * 10000) / 10000; }

// ---------- Dashboard ----------
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bridge-scanner · Livre 4</title>
<style>
body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;margin:0;padding:20px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px}
.sym{font-weight:700;font-size:16px}
.row{display:flex;justify-content:space-between;font-size:13px;margin-top:6px}
.lbl{color:#8b949e}
.pos{color:#3fb950}.neg{color:#f85149}.warn{color:#d29922}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;margin-left:8px}
.open{background:#1f6feb33;color:#58a6ff}.closed{background:#6e768133;color:#8b949e}
.counters{display:flex;gap:12px;margin:16px 0}
.cbox{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 18px;text-align:center}
.cbox .v{font-size:22px;font-weight:700}
.cbox .l{font-size:11px;color:#8b949e}
.err{color:#f85149;font-size:12px;margin-top:14px}
</style></head><body>
<h1>bridge-scanner <small style="color:#8b949e;font-size:12px">v${VERSION} \u00b7 <span id="tkcount">${UNIVERSE.length}</span> tickers</small> <span id="mkt" class="badge closed">…</span>
<button id="upd" style="float:right;background:#21262d;color:#58a6ff;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer">Mettre à jour</button></h1>
<div class="sub" id="diag" style="color:#d29922;font-size:12px;margin-bottom:6px"></div>
<div class="sub">Livre 4 · Triangle U/S/F · Phase 1 paper · S = xStocks Bybit · F = perp Hyperliquid · seuil ${CONFIG.dislocation_threshold_pct}% net</div>
<div class="counters">
  <div class="cbox"><div class="v" id="c_det">0</div><div class="l">dislocations</div></div>
  <div class="cbox"><div class="v" id="c_sur">0</div><div class="l">survie 60s</div></div>
  <div class="cbox"><div class="v" id="c_rate">–</div><div class="l">taux survie</div></div>
  <div class="cbox"><div class="v" id="c_trades">0</div><div class="l">trades paper</div></div>
  <div class="cbox"><div class="v" id="c_win">–</div><div class="l">winrate</div></div>
  <div class="cbox"><div class="v" id="c_pnl">$0</div><div class="l">P&L paper</div></div>
</div>
<div class="grid" id="grid"></div>
<h2 style="font-size:15px;margin:20px 0 8px">Positions ouvertes <small class="lbl">(paper · entrée ≥ ${CONFIG.paper.entry_net_pct}% net · sortie ≤ ${CONFIG.paper.exit_gross_pct}% brut · $${CONFIG.paper.size_usd_per_leg}/jambe)</small></h2>
<div id="pos" class="grid"></div>
<h2 style="font-size:15px;margin:20px 0 8px">Historique</h2>
<table style="width:100%;border-collapse:collapse;font-size:12px" id="hist"></table>
<div class="err" id="errs"></div>
<script>
async function refresh(){
  try{
    const r = await fetch('/api/state'); const s = await r.json();
    document.getElementById('mkt').textContent = s.market_open ? 'NYSE OUVERT (triangle complet)' : 'NYSE FERMÉ (mode S-F, fenêtre edge)';
    document.getElementById('mkt').className = 'badge ' + (s.market_open ? 'open' : 'closed');
    document.getElementById('diag').textContent = (s.discover_log || []).join('  \u00b7  ');
    document.getElementById('tkcount').textContent = Object.keys(s.tickers).length;
    document.getElementById('c_det').textContent = s.counters.detected;
    document.getElementById('c_sur').textContent = s.counters.survived_60s;
    document.getElementById('c_rate').textContent = s.counters.detected > 0 ? Math.round(100*s.counters.survived_60s/s.counters.detected)+'%' : '–';
    const g = document.getElementById('grid'); g.innerHTML = '';
    for (const [sym, t] of Object.entries(s.tickers)){
      const spread = t.spread_pct, net = t.spread_net_pct;
      const cls = net === null ? 'lbl' : (Math.abs(net) >= ${CONFIG.dislocation_threshold_pct} ? 'warn' : (net >= 0 ? 'pos' : 'neg'));
      const div = document.createElement('div'); div.className = 'card';
      div.innerHTML = '<div class="sym">' + sym + '</div>'
        + '<div class="row"><span class="lbl">xStock (S)</span><span>' + fmt(t.s_price) + ' <small class="lbl">' + t.s_status + '</small></span></div>'
        + '<div class="row"><span class="lbl">Perp HL (F)</span><span>' + fmt(t.f_price) + ' <small class="lbl">' + t.f_status + '</small></span></div>'
        + '<div class="row"><span class="lbl">Funding</span><span>' + (t.f_funding === null ? '–' : (100*t.f_funding).toFixed(4) + '%') + '</span></div>'
        + '<div class="row"><span class="lbl">Spread F-S</span><span class="' + cls + '">' + fmt(spread, '%') + '</span></div>'
        + '<div class="row"><span class="lbl">Net après frais</span><span class="' + cls + '">' + fmt(net, '%') + '</span></div>';
      g.appendChild(div);
    }
    document.getElementById('c_trades').textContent = s.counters.trades;
    document.getElementById('c_win').textContent = s.counters.trades > 0 ? Math.round(100*s.counters.wins/s.counters.trades)+'%' : '–';
    var pnlEl = document.getElementById('c_pnl');
    pnlEl.textContent = '$' + s.counters.pnl_total_usd.toFixed(2);
    pnlEl.className = 'v ' + (s.counters.pnl_total_usd >= 0 ? 'pos' : 'neg');
    // positions ouvertes
    const pg = document.getElementById('pos'); pg.innerHTML = '';
    if (!s.positions.length) pg.innerHTML = '<div class="lbl" style="font-size:13px">aucune</div>';
    for (const p of s.positions){
      const t = s.tickers[p.symbol] || {};
      const cur = t.spread_pct;
      const sameSign = cur !== null && Math.sign(cur) === Math.sign(p.spread_open_pct);
      const capt = cur === null ? null : (sameSign ? Math.abs(p.spread_open_pct) - Math.abs(cur) : Math.abs(p.spread_open_pct) + Math.abs(cur));
      const upnl = capt === null ? null : ((capt - 0.39) / 100 * p.size_usd);
      const d = document.createElement('div'); d.className = 'card';
      d.innerHTML = '<div class="sym">' + p.symbol + ' <small class="' + (p.kind === 'CARRY' ? 'pos' : 'warn') + '">' + (p.kind || 'ARB') + '</small> <small class="lbl">' + (p.side === 'SHORT_F_LONG_S' ? 'short perp / long spot' : 'long perp / short spot') + '</small></div>'
        + '<div class="row"><span class="lbl">Ouvert</span><span>' + p.t_open.slice(5,16).replace('T',' ') + '</span></div>'
        + '<div class="row"><span class="lbl">Spread entrée</span><span>' + p.spread_open_pct.toFixed(3) + '%</span></div>'
        + '<div class="row"><span class="lbl">Spread actuel</span><span>' + (cur === null ? '–' : cur.toFixed(3) + '%') + '</span></div>'
        + '<div class="row"><span class="lbl">P&L latent</span><span class="' + (upnl === null ? 'lbl' : (upnl >= 0 ? 'pos' : 'neg')) + '">' + (upnl === null ? '–' : '$' + upnl.toFixed(2)) + '</span></div>'
        + '<div class="row"><span class="lbl">Funding cumulé</span><span class="' + ((p.funding_usd||0) >= 0 ? 'pos' : 'neg') + '">$' + (p.funding_usd||0).toFixed(2) + '</span></div>'
        + '<div class="row"><span class="lbl">Durée</span><span>' + dur(p.t_open, new Date().toISOString()) + '</span></div>'
        + '<div class="row"><span class="lbl">Taille / max possible</span><span>$' + p.size_usd + ' / ' + (p.max_size_usd ? '$' + p.max_size_usd.toLocaleString() : '–') + '</span></div>';
      pg.appendChild(d);
    }
    // historique
    const h = document.getElementById('hist');
    let rows = '<tr style="color:#8b949e;text-align:left"><th>Clôturé</th><th>Ticker</th><th>Type</th><th>Sens</th><th>Entrée</th><th>Sortie</th><th>Raison</th><th>Durée</th><th style="text-align:right">Fund.</th><th style="text-align:right">Taille</th><th style="text-align:right">Max possible</th><th style="text-align:right">P&L</th><th style="text-align:right">P&L%</th></tr>';
    for (const x of s.history.slice(0, 30)){
      rows += '<tr style="border-top:1px solid #21262d"><td>' + x.t_close.slice(5,16).replace('T',' ') + '</td><td><b>' + x.symbol + '</b></td>'
        + '<td>' + (x.kind || 'ARB') + '</td>'
        + '<td>' + (x.side === 'SHORT_F_LONG_S' ? 'F→S' : 'S→F') + '</td>'
        + '<td>' + x.spread_open_pct.toFixed(2) + '%</td><td>' + x.spread_close_pct.toFixed(2) + '%</td>'
        + '<td>' + x.reason + '</td>'
        + '<td>' + dur(x.t_open, x.t_close) + '</td>'
        + '<td style="text-align:right">$' + (x.funding_usd||0).toFixed(2) + '</td>'
        + '<td style="text-align:right">$' + x.size_usd + '</td>'
        + '<td style="text-align:right">' + (x.max_size_usd ? '$' + x.max_size_usd.toLocaleString() : '–') + '</td>'
        + '<td style="text-align:right" class="' + (x.pnl_usd >= 0 ? 'pos' : 'neg') + '">$' + x.pnl_usd.toFixed(2) + '</td>'
        + '<td style="text-align:right" class="' + (x.pnl_usd >= 0 ? 'pos' : 'neg') + '">' + (100 * x.pnl_usd / x.size_usd).toFixed(2) + '%</td></tr>';
    }
    h.innerHTML = rows;
    document.getElementById('errs').textContent = (s.errors[0] ? 'Dernière erreur: ' + s.errors[0].t + ' ' + s.errors[0].msg : '');
  }catch(e){ document.getElementById('errs').textContent = 'refresh: ' + e.message; }
}
function dur(a, b){
  var ms = new Date(b) - new Date(a);
  if (!isFinite(ms) || ms < 0) return '–';
  var m = Math.floor(ms / 60000);
  if (m < 60) return m + 'min';
  var h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + String(m % 60).padStart(2, '0');
  return Math.floor(h / 24) + 'j' + (h % 24) + 'h';
}
function fmt(x, suf){ if (x === null || x === undefined) return '–'; return (typeof x === 'number' ? x.toFixed(suf ? 3 : 2) : x) + (suf || ''); }
refresh(); setInterval(refresh, 10000);
document.getElementById('upd').onclick = async function(){
  const k = prompt('Clé de mise à jour :');
  if (!k) return;
  this.textContent = '…';
  try{
    let r = await fetch('/api/update?key=' + encodeURIComponent(k));
    let j = await r.json();
    if (j.auth_needed){
      const t = prompt('Accès GitHub manquant sur le serveur. Colle un token GitHub (repo access) — il sera enregistré une fois pour toutes :');
      if (!t){ this.textContent = 'Mettre à jour'; return; }
      r = await fetch('/api/update?key=' + encodeURIComponent(k) + '&gh_token=' + encodeURIComponent(t.trim()));
      j = await r.json();
    }
    if (j.ok && j.restart){
      this.textContent = 'Redémarrage…';
      setTimeout(function(){ location.reload(); }, 6000);
    } else {
      this.textContent = 'Mettre à jour';
      alert(j.msg || 'erreur');
    }
  }catch(e){
    this.textContent = 'Redémarrage…';
    setTimeout(function(){ location.reload(); }, 6000);
  }
};
</script>
</body></html>`;
}

// ---------- HTTP ----------
const { execFile } = require("child_process");

function handleUpdate(req, res, urlObj) {
  const key = urlObj.searchParams.get("key") || "";
  if (!CONFIG.update_key || key !== CONFIG.update_key) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, msg: "clé invalide" }));
    return;
  }
  const ghToken = urlObj.searchParams.get("gh_token") || "";
  const doPull = () => {
    execFile("git", ["-C", __dirname, "pull", "--ff-only"], { timeout: 30000 }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      if (err) {
        const authFail = /could not read Username|Authentication failed|403/i.test(out);
        res.writeHead(authFail ? 401 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, auth_needed: authFail, msg: out.trim() || err.message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, msg: out.trim(), restart: !/Already up to date/i.test(out) }));
      if (!/Already up to date/i.test(out)) {
        saveStateAtomic();
        setTimeout(() => process.exit(0), 800); // systemd relance le service avec le nouveau code
      }
    });
  };
  if (ghToken) {
    // Le dashboard a fourni un token : on configure le remote puis on pull (zéro terminal)
    const url = "https://pitch6767:" + ghToken + "@github.com/pitch6767/bridge-scanner-private.git";
    execFile("git", ["-C", __dirname, "remote", "set-url", "origin", url], { timeout: 10000 }, (err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, msg: "set-url: " + err.message }));
        return;
      }
      doPull();
    });
  } else {
    doPull();
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, "http://localhost");
  if (urlObj.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
  } else if (urlObj.pathname === "/api/update") {
    handleUpdate(req, res, urlObj);
  } else if (urlObj.pathname === "/" || urlObj.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(dashboardHTML());
  } else {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log("bridge-scanner · port " + CONFIG.port);
  discoverUniverse().then(() => poll());
  setInterval(discoverUniverse, 6 * 3600 * 1000); // re-scan de l'univers toutes les 6h
  setInterval(poll, CONFIG.poll_interval_sec * 1000);
});
