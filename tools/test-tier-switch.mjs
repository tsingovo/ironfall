// 验证：切换关卡不重置背包 / 配件 / 加成；且关卡无条件开放。
//
// ⚠ 需要在真实浏览器里跑：startRun/loadMission 依赖 WebGL 世界与地图生成。
// 用 __IRONFALL__ 暴露的入口驱动，模拟"玩家在 ESC 菜单里点了第 N 关"。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { requireChrome, headlessArgs } from './lib/chrome.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8352;
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

const ud = join(tmpdir(), 'ironfall-tier-' + Date.now());
await mkdir(ud, { recursive: true });
const proc = spawn(requireChrome('tier-check'), headlessArgs(ud, [
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
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { return (${x}); })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  const s = r.result || {};
  if (s.exceptionDetails) return { __error: s.exceptionDetails.text + ' ' + (s.exceptionDetails.exception?.description || '') };
  return s.result ? s.result.value : undefined;
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let ready = false;
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await ev('window.__IRONFALL__ ? !!window.__IRONFALL__.ready : false') === true) { ready = true; break; }
}
console.log('页面 ready:', ready ? '✅' : '❌');
if (!ready) { console.log('错误:', errors.slice(0, 3)); ws.close(); proc.kill(); server.close(); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

// ── 起一局，制造"背包里有东西 + 装了配件 + 有强化加成"的状态
//
// 注意用**有限物资**（装甲板 / 瞄具）而不是 medkit 这类"无限补给"：
// 无限补给在背包里恒为 Infinity，断言它们是空的、证明不了保留逻辑。
const setup = await ev(`(() => {
  const A = window.__IRONFALL__;
  const g = A.game;
  A.setAutomationMode(true);
  g.tier = 2; g.mapIndex = 1;
  A.startRun();
  g.hud.hideMenu(); g.paused = false; g.menuKind = null; g.setPlaying(true);

  const inv = g.inventory;
  inv.add('armor_plate', 3);      // 有限堆叠（stack 3）
  inv.add('optic_1x', 1);         // 有限堆叠（stack 1）
  // 装一个配件到主武器
  const att = g.weapons.installAttachment('optic_1x', 'r99');
  // 造一个"已购强化"
  g.upgrades.addAlloy(500);
  if (g.upgrades._owned) { g.upgrades._owned.set('slide_servo', 2); g.upgrades.applyAll(); }

  const snap = () => ({
    inv: inv.slots.filter(Boolean).map(s => s.itemId + 'x' + s.count).sort(),
    att: JSON.stringify(g.weapons.lootAttachments),
    alloy: g.upgrades.alloy,
    owned: JSON.stringify(g.upgrades.owned),
    mods: JSON.stringify(g.player.mods && g.player.mods.move ? g.player.mods.move.slideSpeedMul : null),
  });
  return Object.assign(snap(), { attInstall: att && att.ok });
})()`);
console.log('\n切换前:', JSON.stringify(setup));

// ── 通过 ESC 菜单的真实路径切到第 7 关
const after = await ev(`(() => {
  const A = window.__IRONFALL__;
  const g = A.game;
  // 模拟玩家在 ESC 菜单里点"第 7 关"（走真实 intent）
  g._onIntent ? g._onIntent('switch_tier', { tier: 7 }) : null;
  const inv = g.inventory;
  return {
    tier: g.tier, mapIndex: g.mapIndex, mapName: g.mapName,
    inv: inv.slots.filter(Boolean).map(s => s.itemId + 'x' + s.count).sort(),
    att: JSON.stringify(g.weapons.lootAttachments),
    alloy: g.upgrades.alloy,
    owned: JSON.stringify(g.upgrades.owned),
    mods: JSON.stringify(g.player.mods && g.player.mods.move ? g.player.mods.move.slideSpeedMul : null),
    playing: g._playing, paused: g.paused,
  };
})()`);
console.log('切换后:', JSON.stringify(after));

console.log('\n切换关卡的行为');
check('确实换到了第 7 关', after && after.tier === 7 && after.mapIndex === 6,
  `tier=${after?.tier} mapIndex=${after?.mapIndex}`);
check('地图真的换了', after && typeof after.mapName === 'string' && after.mapName !== '',
  `mapName=${after?.mapName}`);
check('背包里的有限物资被保留',
  after && JSON.stringify(after.inv) === JSON.stringify(setup.inv),
  `${JSON.stringify(setup.inv)} → ${JSON.stringify(after?.inv)}`);
check('武器配件被保留',
  after && after.att === setup.att,
  `${setup.att} → ${after?.att}`);
check('强化合金被保留', after && after.alloy === setup.alloy,
  `${setup.alloy} → ${after?.alloy}`);
check('已购强化被保留', after && after.owned === setup.owned,
  `${setup.owned} → ${after?.owned}`);
check('强化效果仍然生效（modifiers 未被清空）',
  after && after.mods === setup.mods && setup.mods !== 'null',
  `slideSpeedMul: ${setup.mods} → ${after?.mods}`);
check('切换后回到可游玩状态', after && after.playing === true && after.paused === false,
  `playing=${after?.playing} paused=${after?.paused}`);

console.log('\n关卡解锁');
const unlock = await ev(`(() => {
  const A = window.__IRONFALL__; const g = A.game;
  const bad = [];
  for (let t = 1; t <= 10; t++) {
    if (!g.meta.isTierUnlocked(t)) bad.push(t);
  }
  return { bad, tiers: g.meta.unlocked.tiers };
})()`);
check('十关全部可选（新存档也是如此）', unlock && unlock.bad.length === 0,
  unlock ? `不可选: [${unlock.bad}] 推进进度=${unlock.tiers}` : 'n/a');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (errors.length) { console.log('运行时错误:'); errors.slice(0, 3).forEach((e) => console.log('  !', String(e).split('\n')[0].slice(0, 140))); }
ws.close(); proc.kill(); server.close();
process.exitCode = fail > 0 ? 1 : 0;
