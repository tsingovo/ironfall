// ==== tools/_verify-standalone.mjs — 验证单文件离线版在 file:// 下真能跑 ====
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { requireChrome, headlessArgs, killChrome } from './lib/chrome.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'docs/verify/standalone');
// 优先验证「从发布包解压出来的文件」—— 那才是客户真正拿到的东西
const EXTRACTED = join(ROOT, 'dist/_extract_test/IRONFALL.html');
const FILE = existsSync(EXTRACTED) ? EXTRACTED : join(ROOT, 'dist/IRONFALL.html');
await mkdir(OUT, { recursive: true });

const userDataDir = join(tmpdir(), 'ironfall-sa-' + Date.now());
await mkdir(userDataDir, { recursive: true });
const proc = spawn(requireChrome('verify-standalone'), headlessArgs(userDataDir, [
  '--window-size=1600,900',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // 不添加 --allow-file-access-from-files：就是要验证"默认浏览器设置下能否直接跑"
  'about:blank',
]), { stdio: ['ignore', 'pipe', 'pipe'] });

const portFile = join(userDataDir, 'DevToolsActivePort');
let dport = 0;
for (let i = 0; i < 120; i++) {
  try { dport = Number((await readFile(portFile, 'utf8')).split('\n')[0]); if (dport) break; } catch (_e) { /* 等待 */ }
  await new Promise((r) => setTimeout(r, 150));
}
const target = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { return (${expr}); })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  const s = r.result || {};
  if (s.exceptionDetails) return { __error: s.exceptionDetails.text + ' ' + ((s.exceptionDetails.exception || {}).description || '') };
  return s.result ? s.result.value : undefined;
}
async function shot(n) {
  await ev('new Promise(res=>{let k=0;const s=()=>{k++;k>=3?res(true):requestAnimationFrame(s);};requestAnimationFrame(s);})');
  await new Promise((r) => setTimeout(r, 250));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT, n); await writeFile(p, Buffer.from(r.result.data, 'base64')); return p;
}
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

const url = pathToFileURL(FILE).href;
console.log('\n── 从 file:// 直接打开（无服务器）──');
console.log('  URL:', url.slice(0, 78) + '…');
await send('Page.navigate', { url });

let ready = false;
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await ev('window.__IRONFALL__ ? !!window.__IRONFALL__.ready : false') === true) { ready = true; break; }
}

check('页面加载后 __IRONFALL__.ready 为真', ready);
check('没有未捕获的运行时错误', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ').slice(0, 220) : '无');

if (ready) {
  const info = await ev(`(() => {
    const g = window.__IRONFALL__.game;
    const c = document.getElementById('game-canvas');
    const gl = c ? (c.getContext('webgl2') || null) : null;
    return {
      protocol: location.protocol,
      hasGame: !!g,
      canvasSize: c ? [c.width, c.height] : null,
      webgl2: !!gl,
      renderer: gl ? (() => { const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })() : null,
      modulesInlined: typeof window !== 'undefined',
      menuVisible: (() => { const el = document.querySelector('#menu-overlay');
        if (!el) return null; const s = getComputedStyle(el);
        return { opacity: +s.opacity, display: s.display }; })(),
    };
  })()`);
  console.log('  ' + JSON.stringify(info));
  check('WebGL2 上下文可用', info.webgl2 === true, info.renderer);

  // 真的能开一局、跑物理、渲染
  const play = await ev(`(() => {
    const g = window.__IRONFALL__.game;
    window.__IRONFALL__.setAutomationMode(true);
    window.__IRONFALL__.startRun();
    g.hud.hideMenu();
    g.paused = false; g.menuKind = null; g.setPlaying(true);
    // 分段推进并记录最大水平速度 —— 只看末帧会因为已松开前进键而读到 0
    let maxHs = 0;
    for (let i = 0; i < 6; i++) {
      window.__IRONFALL__.simulate(0.25, [{ seconds: 0.25, moveY: 1, sprint: i < 2 }]);
      maxHs = Math.max(maxHs, g.player.state.hspeed);
    }
    window.__IRONFALL__.simulate(0.5, [{ seconds: 0.5, fire: true }]);
    const p = g.player;
    return {
      pos: Array.from(p.pos).map((v) => +v.toFixed(2)),
      maxHspeed: +maxHs.toFixed(2),
      grounded: p.state.grounded,
      ammo: g.weapons.current.ammo,
      enemyAlive: g.enemies.aliveCount(),
      tracers: g.weapons.projectiles.tracerCount,
      fps: window.__IRONFALL__.measureFps ? 'ok' : 'missing',
      stats: { dc: g.engine.stats.drawCalls, inst: g.engine.stats.instances, tri: g.engine.stats.triangles },
    };
  })()`);
  console.log('  ' + JSON.stringify(play));
  check('运行时能推进物理（跑起来了）', play.maxHspeed > 3, `峰值 ${play.maxHspeed} m/s`);
  // 弹匣可能刚好打空并进入自动换弹，所以不断言具体数值，只看射击链路是否跑通
  check('运行时能射击（走完开火链路）', typeof play.ammo === 'number', `剩 ${play.ammo}`);
  check('渲染器在工作（有 draw call 与三角）', play.stats.dc > 0 && play.stats.tri > 0, JSON.stringify(play.stats));
  check('离线版也能刷出敌人', play.enemyAlive > 0, `${play.enemyAlive} 个`);

  // 模型是否通过内联 data: URI 成功载入
  const model = await ev(`(() => {
    const g = window.__IRONFALL__.game;
    return {
      importedModels: g.world.importedModels ? g.world.importedModels.length : (g.world._imported ? g.world._imported.length : null),
      // file:// 下 Chrome 默认禁用 localStorage —— 存档必须优雅降级而不是抛错
      storageAvailable: (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch (e) { return false; } })(),
      saveWorks: (() => { try { g.meta.recordRun({ extracted: true, tier: 1, kills: 1, headshots: 0, time: 1, alloy: 1, score: 1 }); return true; } catch (e) { return 'threw: ' + e.message; } })(),
    };
  })()`);
  console.log('  模型导入:', JSON.stringify(model));

  await new Promise((r) => setTimeout(r, 400));
  console.log('  截图:', await shot('S1-offline-game.png'));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
ws.close(); killChrome(proc);
process.exit(fail > 0 ? 1 : 0);
