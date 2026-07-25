// bridge-scanner v1 — Livre 4 : triangle U/S/F, phase scanner S-F (paper)
// Node >= 18, zéro dépendance. Port 8085.
"use strict";

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
  counters: { detected: 0, survived_60s: 0, weekends_logged: 0 },
  weekend_log: [],      // { weekend_of, symbol, spread_fri_22h, spread_mon_open, converged }
  errors: []
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.dislocations = prev.dislocations || [];
    state.counters = prev.counters || state.counters;
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
async function fetchBybit() {
  // Jambe S : xStocks sur Bybit spot, API publique v5, un appel par symbole (léger, parallèle)
  const out = {};
  await Promise.all(CONFIG.tickers.map(async (t) => {
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
  }));
  return out;
}

function normCoin(name) {
  // "xyz:TSLA" et "TSLA" doivent matcher, quel que soit le format renvoyé par l'API
  return String(name).toUpperCase().split(":").pop();
}

async function fetchHyperliquid() {
  const body = JSON.stringify({ type: "metaAndAssetCtxs", dex: CONFIG.hl_dex });
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json();
  const out = {};
  const universe = (j[0] && j[0].universe) || [];
  const ctxs = j[1] || [];
  for (const t of CONFIG.tickers) {
    const want = normCoin(t.hl_coin);
    const idx = universe.findIndex(u => normCoin(u.name) === want);
    if (idx >= 0 && ctxs[idx]) {
      out[t.symbol] = {
        mark: parseFloat(ctxs[idx].markPx),
        funding: parseFloat(ctxs[idx].funding || 0),
        status: "OK"
      };
    } else {
      out[t.symbol] = { status: "UNKNOWN_COIN" };
    }
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
  try { kr = await fetchBybit(); } catch (e) { pushErr("bybit: " + e.message); }
  try { hl = await fetchHyperliquid(); } catch (e) { pushErr("hyperliquid: " + e.message); }

  for (const t of CONFIG.tickers) {
    const s = kr[t.symbol] || { status: "NO_DATA" };
    const f = hl[t.symbol] || { status: "NO_DATA" };
    const rec = state.tickers[t.symbol] || {};
    rec.s_status = s.status; rec.f_status = f.status;
    rec.s_price = s.mid || null;
    rec.f_price = f.mark || null;
    rec.f_funding = (f.funding !== undefined) ? f.funding : null;
    if (s.status === "OK" && f.status === "OK") {
      const spread = ((f.mark - s.mid) / s.mid) * 100; // F riche > 0
      rec.spread_pct = round4(spread);
      rec.spread_net_pct = round4(Math.abs(spread) - totalFeesPct) * Math.sign(spread);
      trackDislocation(t.symbol, rec.spread_net_pct, now);
    } else {
      rec.spread_pct = null; rec.spread_net_pct = null;
    }
    rec.updated = now.toISOString();
    state.tickers[t.symbol] = rec;
  }
  state.last_poll = now.toISOString();
  saveStateAtomic();
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
<h1>bridge-scanner <span id="mkt" class="badge closed">…</span></h1>
<div class="sub">Livre 4 · Triangle U/S/F · Phase 1 paper · S = xStocks Bybit · F = perp Hyperliquid · seuil ${CONFIG.dislocation_threshold_pct}% net</div>
<div class="counters">
  <div class="cbox"><div class="v" id="c_det">0</div><div class="l">dislocations</div></div>
  <div class="cbox"><div class="v" id="c_sur">0</div><div class="l">survie 60s</div></div>
  <div class="cbox"><div class="v" id="c_rate">–</div><div class="l">taux survie</div></div>
</div>
<div class="grid" id="grid"></div>
<div class="err" id="errs"></div>
<script>
async function refresh(){
  try{
    const r = await fetch('/api/state'); const s = await r.json();
    document.getElementById('mkt').textContent = s.market_open ? 'NYSE OUVERT (triangle complet)' : 'NYSE FERMÉ (mode S-F, fenêtre edge)';
    document.getElementById('mkt').className = 'badge ' + (s.market_open ? 'open' : 'closed');
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
    document.getElementById('errs').textContent = (s.errors[0] ? 'Dernière erreur: ' + s.errors[0].t + ' ' + s.errors[0].msg : '');
  }catch(e){ document.getElementById('errs').textContent = 'refresh: ' + e.message; }
}
function fmt(x, suf){ if (x === null || x === undefined) return '–'; return (typeof x === 'number' ? x.toFixed(suf ? 3 : 2) : x) + (suf || ''); }
refresh(); setInterval(refresh, 10000);
</script>
</body></html>`;
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
  } else if (req.url === "/" || req.url === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML());
  } else {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log("bridge-scanner v1 · port " + CONFIG.port);
  poll();
  setInterval(poll, CONFIG.poll_interval_sec * 1000);
});
