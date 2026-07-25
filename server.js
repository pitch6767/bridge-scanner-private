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
  positions: [],        // paper : { id, symbol, side, t_open, s_open, f_open, spread_open_pct, size_usd }
  history: [],          // paper : positions cloturees + { t_close, s_close, f_close, spread_close_pct, pnl_usd, reason }
  counters: { detected: 0, survived_60s: 0, weekends_logged: 0, trades: 0, wins: 0, pnl_total_usd: 0 },
  weekend_log: [],      // { weekend_of, symbol, spread_fri_22h, spread_mon_open, converged }
  errors: []
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.dislocations = prev.dislocations || [];
    state.positions = prev.positions || [];
    state.history = prev.history || [];
    state.counters = Object.assign(state.counters, prev.counters || {});
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

async function discoverUniverse() {
  if (!CONFIG.auto_discover) return;
  try {
    const [bybitList, hlList] = await Promise.all([
      (async () => {
        const r = await fetch("https://api.bybit.com/v5/market/instruments-info?category=spot&symbolType=xstocks&limit=200", { signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        const list = (j && j.result && j.result.list) || [];
        const out = {};
        for (const it of list) {
          if (it.status && it.status !== "Trading") continue;
          const tk = bybitToTicker(it.symbol);
          if (tk) out[tk] = it.symbol;
        }
        return out;
      })(),
      (async () => {
        const r = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs", dex: CONFIG.hl_dex }),
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
      })()
    ]);
    const known = new Set(UNIVERSE.map(t => t.symbol));
    let added = 0;
    for (const tk of Object.keys(bybitList).sort()) {
      if (known.has(tk)) continue;
      if (hlList[tk] !== undefined) {
        UNIVERSE.push({ symbol: tk, bybit_symbol: bybitList[tk], hl_coin: hlList[tk] });
        added++;
        if (UNIVERSE.length >= CONFIG.max_universe) break;
      }
    }
    state.universe_size = UNIVERSE.length;
    state.universe_discovered = added;
    console.log("univers: " + UNIVERSE.length + " tickers (" + added + " decouverts)");
  } catch (e) {
    pushErr("discover: " + e.message);
  }
}

async function fetchBybit() {
  // Jambe S : xStocks sur Bybit spot, API publique v5, un appel par symbole (léger, parallèle)
  const out = {};
  await Promise.all(UNIVERSE.map(async (t) => {
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
  for (const t of UNIVERSE) {
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

  for (const t of UNIVERSE) {
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
      paperEngine(t.symbol, rec, now);
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

  if (!open) {
    if (Math.abs(rec.spread_net_pct) >= P.entry_net_pct && state.positions.length < P.max_open_positions) {
      state.positions.push({
        id: Date.now().toString(36) + "-" + symbol,
        symbol,
        side: rec.spread_pct > 0 ? "SHORT_F_LONG_S" : "LONG_F_SHORT_S",
        t_open: now.toISOString(),
        s_open: rec.s_price, f_open: rec.f_price,
        spread_open_pct: rec.spread_pct,
        size_usd: P.size_usd_per_leg
      });
    }
    return;
  }

  const ageH = (now - new Date(open.t_open)) / 3600000;
  const converged = Math.abs(rec.spread_pct) <= P.exit_gross_pct;
  const sameSign = Math.sign(rec.spread_pct) === Math.sign(open.spread_open_pct);
  const timeStop = ageH >= P.max_hold_hours;

  if (converged || timeStop || !sameSign) {
    // P&L : capture de spread (dans le sens de la position) - frais aller-retour
    const captured = sameSign
      ? Math.abs(open.spread_open_pct) - Math.abs(rec.spread_pct)
      : Math.abs(open.spread_open_pct) + Math.abs(rec.spread_pct); // le spread a traversé zéro : gain bonus
    const pnl = (captured - roundTripFeesPct) / 100 * open.size_usd;
    const closed = Object.assign({}, open, {
      t_close: now.toISOString(),
      s_close: rec.s_price, f_close: rec.f_price,
      spread_close_pct: rec.spread_pct,
      pnl_usd: Math.round(pnl * 100) / 100,
      reason: converged ? "CONVERGENCE" : (timeStop ? "TIME_STOP" : "CROSS_ZERO")
    });
    state.history.unshift(closed);
    state.history = state.history.slice(0, 200);
    state.positions = state.positions.filter(p => p.id !== open.id);
    state.counters.trades++;
    if (pnl > 0) state.counters.wins++;
    state.counters.pnl_total_usd = Math.round((state.counters.pnl_total_usd + pnl) * 100) / 100;
  }
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
<h1>bridge-scanner <span id="mkt" class="badge closed">…</span>
<button id="upd" style="float:right;background:#21262d;color:#58a6ff;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer">Mettre à jour</button></h1>
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
      d.innerHTML = '<div class="sym">' + p.symbol + ' <small class="lbl">' + (p.side === 'SHORT_F_LONG_S' ? 'short perp / long spot' : 'long perp / short spot') + '</small></div>'
        + '<div class="row"><span class="lbl">Ouvert</span><span>' + p.t_open.slice(5,16).replace('T',' ') + '</span></div>'
        + '<div class="row"><span class="lbl">Spread entrée</span><span>' + p.spread_open_pct.toFixed(3) + '%</span></div>'
        + '<div class="row"><span class="lbl">Spread actuel</span><span>' + (cur === null ? '–' : cur.toFixed(3) + '%') + '</span></div>'
        + '<div class="row"><span class="lbl">P&L latent</span><span class="' + (upnl === null ? 'lbl' : (upnl >= 0 ? 'pos' : 'neg')) + '">' + (upnl === null ? '–' : '$' + upnl.toFixed(2)) + '</span></div>';
      pg.appendChild(d);
    }
    // historique
    const h = document.getElementById('hist');
    let rows = '<tr style="color:#8b949e;text-align:left"><th>Clôturé</th><th>Ticker</th><th>Sens</th><th>Entrée</th><th>Sortie</th><th>Raison</th><th style="text-align:right">P&L</th></tr>';
    for (const x of s.history.slice(0, 30)){
      rows += '<tr style="border-top:1px solid #21262d"><td>' + x.t_close.slice(5,16).replace('T',' ') + '</td><td><b>' + x.symbol + '</b></td>'
        + '<td>' + (x.side === 'SHORT_F_LONG_S' ? 'F→S' : 'S→F') + '</td>'
        + '<td>' + x.spread_open_pct.toFixed(2) + '%</td><td>' + x.spread_close_pct.toFixed(2) + '%</td>'
        + '<td>' + x.reason + '</td>'
        + '<td style="text-align:right" class="' + (x.pnl_usd >= 0 ? 'pos' : 'neg') + '">$' + x.pnl_usd.toFixed(2) + '</td></tr>';
    }
    h.innerHTML = rows;
    document.getElementById('errs').textContent = (s.errors[0] ? 'Dernière erreur: ' + s.errors[0].t + ' ' + s.errors[0].msg : '');
  }catch(e){ document.getElementById('errs').textContent = 'refresh: ' + e.message; }
}
function fmt(x, suf){ if (x === null || x === undefined) return '–'; return (typeof x === 'number' ? x.toFixed(suf ? 3 : 2) : x) + (suf || ''); }
refresh(); setInterval(refresh, 10000);
document.getElementById('upd').onclick = async function(){
  const k = prompt('Clé de mise à jour :');
  if (!k) return;
  this.textContent = '…';
  try{
    const r = await fetch('/api/update?key=' + encodeURIComponent(k));
    const j = await r.json();
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
  execFile("git", ["-C", __dirname, "pull", "--ff-only"], { timeout: 30000 }, (err, stdout, stderr) => {
    const out = (stdout || "") + (stderr || "");
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, msg: out || err.message }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, msg: out.trim(), restart: !/Already up to date/i.test(out) }));
    if (!/Already up to date/i.test(out)) {
      saveStateAtomic();
      setTimeout(() => process.exit(0), 800); // systemd relance le service avec le nouveau code
    }
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, "http://localhost");
  if (urlObj.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
  } else if (urlObj.pathname === "/api/update") {
    handleUpdate(req, res, urlObj);
  } else if (urlObj.pathname === "/" || urlObj.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
