const fs = require('fs');
const vm = require('vm');
const http = require('http');

const html = fs.readFileSync('/tmp/page.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const els = {};
const sandbox = {
  console,
  document: {
    getElementById(id) {
      if (!els[id]) els[id] = { textContent: '', innerHTML: '', className: '', appendChild() {}, onclick: null };
      return els[id];
    },
    createElement() { return { className: '', innerHTML: '', appendChild() {} }; }
  },
  location: { reload() {} },
  alert(m) { console.log('ALERT:', m); },
  prompt() { return null; },
  setInterval() {},
  setTimeout(f) {},
  encodeURIComponent,
  Math, Object, JSON,
  fetch(u) {
    return new Promise((res, rej) => {
      http.get('http://localhost:8085' + u, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => res({ json: async () => JSON.parse(d) }));
      }).on('error', rej);
    });
  }
};
vm.createContext(sandbox);

try {
  vm.runInContext(script, sandbox, { filename: 'dashboard.js' });
  console.log('=== parse/exec initial OK ===');
} catch (e) {
  console.log('=== CRASH AU CHARGEMENT ===');
  console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

(async () => {
  try {
    await sandbox.refresh();
    console.log('=== refresh() OK ===');
    console.log('badge :', els.mkt && els.mkt.textContent);
    console.log('trades:', els.c_trades && els.c_trades.textContent);
    console.log('pnl   :', els.c_pnl && els.c_pnl.textContent);
    console.log('errs  :', els.errs && els.errs.textContent);
  } catch (e) {
    console.log('=== CRASH DANS refresh() ===');
    console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  }
})();
