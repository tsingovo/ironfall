// 快速验证：页面能否正常起来（抓未捕获异常）
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { requireChrome, headlessArgs, killChrome } from './lib/chrome.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8351;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
  const full = resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  const i = await stat(full).catch(() => null);
  if (!i || !i.isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': (MIME[extname(full)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(await readFile(full));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const ud = join(tmpdir(), 'ironfall-err-' + Date.now());
await mkdir(ud, { recursive: true });
const proc = spawn(requireChrome('err-check'), headlessArgs(ud, [
  '--window-size=1280,720', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
]), { stdio: ['ignore', 'pipe', 'pipe'] });
const pf = join(ud, 'DevToolsActivePort');
let dport = 0;
for (let i = 0; i < 120; i++) {
  try { dport = Number((await readFile(pf, 'utf8')).split('\n')[0]); if (dport) break; } catch (_e) { /* 等 */ }
  await new Promise((r) => setTimeout(r, 150));
}
const target = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { return (${x}); })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  const s = r.result || {};
  if (s.exceptionDetails) return { __error: s.exceptionDetails.text };
  return s.result ? s.result.value : undefined;
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let ready = false;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await ev('window.__IRONFALL__ ? !!window.__IRONFALL__.ready : false') === true) { ready = true; break; }
}

console.log('页面 ready:', ready ? '✅ 是' : '❌ 否');
console.log('未捕获异常/console 错误:', errors.length);
for (const e of errors.slice(0, 6)) console.log('  !', String(e).split('\n')[0].slice(0, 150));

if (ready) {
  const run = await ev(`(() => {
    const g = window.__IRONFALL__.game;
    window.__IRONFALL__.setAutomationMode(true);
    window.__IRONFALL__.startRun();
    g.hud.hideMenu();
    g.paused = false; g.menuKind = null; g.setPlaying(true);
    window.__IRONFALL__.simulate(2.0, [{ seconds: 1.0, moveY: 1, sprint: true }, { seconds: 1.0, fire: true }]);
    return { hspeed: +g.player.state.hspeed.toFixed(2), ammo: g.weapons.current.ammo,
             enemies: g.enemies.aliveCount(), dc: g.engine.stats.drawCalls };
  })()`);
  console.log('跑一局:', JSON.stringify(run));
}
console.log('\n结论:', (ready && errors.length === 0) ? '✅ 启动正常，无运行时错误' : '❌ 仍有问题');
ws.close(); killChrome(proc); server.close();
process.exit(0);
