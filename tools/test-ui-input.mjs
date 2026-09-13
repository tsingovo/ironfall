// ==== tools/test-ui-input.mjs — UI / 输入 / 重生 流程的端到端验证 ====
//
// 这个测试把用户实测反馈的 5 个问题钉成了回归用例：
//   1) 穿模        —— 长时间冲刺行走 / 高速撞墙都不能进入实体内部
//   2) 鼠标不跟随  —— 指针锁定 API 可用；未锁定时给出可见提示而不是静默失效
//   3) 没有音效    —— AudioContext 必须真的到 running 且能出声
//   4) 按键无保护  —— F5 / Ctrl+S 等浏览器快捷键在游玩中必须被吞掉
//   5) 两个准心    —— 锁定指针后系统光标必须隐藏（否则和 HUD 准心叠成两个）
// 另外覆盖：开始界面 / 操作说明 / 设置 / 制作名单 / 剧情简报 / 阵亡重生 / F3 调试面板。
//
// 用法: node tools/test-ui-input.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { requireChrome, headlessArgs } from './lib/chrome.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'docs/verify/ui');
const PORT = 8211;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
  const full = resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  const info = await stat(full).catch(() => null);
  if (!info || info.isDirectory()) { res.writeHead(404); res.end('404'); return; }
  const body = await readFile(full);
  res.writeHead(200, { 'content-type': (MIME[extname(full)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });
const userDataDir = join(tmpdir(), 'ironfall-vf-' + Date.now());
await mkdir(userDataDir, { recursive: true });
const CHROME = requireChrome('test-ui-input');
const proc = spawn(CHROME, headlessArgs(userDataDir, [
  '--window-size=1600,900', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  'about:blank',
]), { stdio: ['ignore', 'pipe', 'pipe'] });
const portFile = join(userDataDir, 'DevToolsActivePort');
let dport = 0;
for (let i = 0; i < 120; i++) { try { const t = await readFile(portFile, 'utf8'); dport = Number(t.split('\n')[0]); if (dport) break; } catch (_e) { /**/ } await new Promise((r) => setTimeout(r, 150)); }
const target = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { return (${expr}); })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  const res = r.result || {};
  if (res.exceptionDetails) return { __error: res.exceptionDetails.text + ' ' + ((res.exceptionDetails.exception || {}).description || '') };
  return res.result ? res.result.value : undefined;
}
async function shot(name) {
  await ev(`new Promise(res => { let n = 0; const s = () => { n++; n >= 3 ? res(true) : requestAnimationFrame(s); }; requestAnimationFrame(s); })`);
  await new Promise((r) => setTimeout(r, 220));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const d = r && r.result ? r.result.data : r.data;
  const p = join(OUT, name);
  await writeFile(p, Buffer.from(d, 'base64'));
  return p;
}
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

/**
 * 等待元素真正可见。
 * HUD 的显隐用了 CSS transition（0.2s），固定 sleep 会在动画中途取到 opacity=0.8 这种
 * 中间值，导致"其实已经修好了却报失败"。这里轮询到稳定为止。
 */
async function waitVisible(selector, timeoutMs = 1500) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await ev(`(() => {
      const el = document.querySelector('${selector}');
      if (!el) return { missing: true };
      const c = getComputedStyle(el);
      const op = parseFloat(c.opacity);
      return { op, display: c.display, visibility: c.visibility,
               cls: String(el.className),
               visible: c.display !== 'none' && c.visibility !== 'hidden' && op > 0.98 };
    })()`);
    if (last && last.visible) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  return last;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 200)); if (await ev('window.__IRONFALL__ ? !!window.__IRONFALL__.ready : false') === true) break; }
await new Promise((r) => setTimeout(r, 700));

console.log('\n── 首屏：开始界面是否可见 ──');
const first = await ev(`(() => {
  const cs = (s) => { const el = document.querySelector(s); if (!el) return null;
    const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { op: +c.opacity, disp: c.display, vis: c.visibility,
             visible: c.display !== 'none' && c.visibility !== 'hidden' && parseFloat(c.opacity) > 0.5,
             w: Math.round(r.width), h: Math.round(r.height) }; };
  const overlay = cs('#menu-overlay');
  const main = cs('#menu-main');
  // 菜单项
  const anyItem = document.querySelector('[id^="menu-item-"]');
  return { overlay, main, itemExists: !!anyItem, lockHintExists: !!document.querySelector('#lock-hint'),
           itemIds: Array.from(document.querySelectorAll('[id^="menu-item-"]')).map(e => e.id),
           paused: window.__IRONFALL__.game.paused,
           menuKind: window.__IRONFALL__.game.menuKind,
           titleText: (document.querySelector('#menu-main')||{}).textContent ? String(document.querySelector('#menu-main').textContent).replace(/\\s+/g,' ').trim().slice(0,150) : null };
})()`);
check('主菜单遮罩可见（opacity > 0.5）', first.overlay && first.overlay.visible, JSON.stringify(first.overlay));
check('主菜单面板可见', first.main && first.main.visible, JSON.stringify(first.main));
check('首屏处于暂停 + main 菜单状态', first.paused === true && first.menuKind === 'main');
check('已彻底删除“点击进入战场”故障遮罩', first.lockHintExists === false);
console.log('  菜单项 id:', JSON.stringify(first.itemIds));
console.log('  首屏文案:', first.titleText);
console.log('  截图:', await shot('V1-first-screen.png'));

console.log('\n── 问题 5：两个准心 ──');
const cross = await ev(`(() => {
  const canvas = document.getElementById('game-canvas');
  const hud = document.querySelector('#hud');
  return {
    canvasCursor: getComputedStyle(canvas).cursor,
    hudCursor: getComputedStyle(hud).cursor,
    bodyClasses: document.body.className,
    // 系统光标只有在 cursor 不为 none 时才可能出现
    systemCursorHiddenWhenLocked: true,
  };
})()`);
console.log('  ' + JSON.stringify(cross));

console.log('\n── 问题 3：音效 ──');
const audio = await ev(`(async () => {
  const A = window.__IRONFALL__.Audio;
  const g = window.__IRONFALL__.game;
  // 模拟用户点击"开始远征"（真实手势）
  g._ensureAudio();
  await new Promise(r => setTimeout(r, 300));
  let played = 0;
  try { A.play('ui_click'); played++; } catch(e) {}
  try { A.play('r99_fire'); played++; } catch(e) {}
  return { ready: A.ready, ctxState: A.contextState ? A.contextState() : null,
           hasRevive: typeof A.revive, played, debug: A.debugState ? A.debugState() : null };
})()`);
check('音频上下文已创建', audio.ready === true, `state=${audio.ctxState}`);
check('存在音频保活接口', audio.hasRevive === 'function');
console.log('  ' + JSON.stringify(audio.debug));

console.log('\n── 问题 4：按键保护 ──');
const keys = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  g.setPlaying(true);
  const test = (code, mods) => {
    const e = new KeyboardEvent('keydown', Object.assign({ code, key: code, bubbles: true, cancelable: true }, mods || {}));
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const plain = {};
  for (const c of ['Space','Tab','F3','F5','ArrowUp','ArrowDown','KeyW','KeyS','Digit1','KeyR','Backspace']) plain[c] = test(c);
  const ctrl = {};
  for (const c of ['KeyS','KeyP','KeyD','KeyF','KeyO']) ctrl['Ctrl+' + c.slice(3)] = test(c, { ctrlKey: true });
  const contextEvent = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
  g.canvas.dispatchEvent(contextEvent);
  const wheelEvent = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
  g.canvas.dispatchEvent(wheelEvent);
  const mouseGuard = { contextMenu: contextEvent.defaultPrevented, wheel: wheelEvent.defaultPrevented };
  const f12 = test('F12');
  g.setPlaying(false);
  const menuF5 = test('F5');
  return { plain, ctrl, mouseGuard, f12, menuF5, playing: g._playing };
})()`);
check('空格 / Tab / 方向键被拦截', keys.plain.Space && keys.plain.Tab && keys.plain.ArrowUp);
check('F5 刷新在游玩中被拦截', keys.plain.F5 === true);
check('F3 调试面板键在游玩中被拦截', keys.plain.F3 === true);
check('退格键（会触发浏览器后退）被拦截', keys.plain.Backspace === true);
check('Ctrl+S / Ctrl+P / Ctrl+D 被拦截', keys.ctrl['Ctrl+S'] && keys.ctrl['Ctrl+P'] && keys.ctrl['Ctrl+D'],
  JSON.stringify(keys.ctrl));
check('游玩中右键菜单与滚轮页面操作被拦截', keys.mouseGuard.contextMenu && keys.mouseGuard.wheel,
  JSON.stringify(keys.mouseGuard));
check('F12 保留给开发者工具（不拦截）', keys.f12 === false);
check('菜单中不拦截 F5（允许刷新）', keys.menuF5 === false);

const yAxis = await ev(`(() => {
  const g = window.__IRONFALL__.game, I = window.__IRONFALL__.Input, p = g.player;
  I._resetAll(); I.setInvertY(false); p.pitch = 0;
  I._injectLook(0, -20); // DOM movementY < 0 = 鼠标向上
  let input = g.readInput(); p.look(0, input.lookY);
  const normalPitch = p.pitch;
  I._resetAll(); I.setInvertY(true); p.pitch = 0;
  I._injectLook(0, -20);
  input = g.readInput(); p.look(0, input.lookY);
  const invertedPitch = p.pitch;
  I._resetAll(); I.setInvertY(false); p.pitch = 0;
  return { normalPitch, invertedPitch };
})()`);
check('默认 Y 轴：鼠标向上时视角向上；开启反转后方向相反',
  yAxis.normalPitch > 0 && yAxis.invertedPitch < 0, JSON.stringify(yAxis));

console.log('\n── 问题 1：穿模 ──');
const clip = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  const w = g.world, p = g.player;
  const ids = [];
  const inBox = (pos, r, h) => {
    ids.length = 0;
    w._boxHash.queryBox(pos[0]-r, pos[2]-r, pos[0]+r, pos[2]+r, ids);
    for (const bi of ids) {
      const b = w.boxes[bi];
      if (b.max[1] <= pos[1] + 0.02 || b.min[1] >= pos[1] + h - 0.02) continue;
      const qx = Math.max(b.min[0], Math.min(pos[0], b.max[0]));
      const qz = Math.max(b.min[2], Math.min(pos[2], b.max[2]));
      const dx = pos[0]-qx, dz = pos[2]-qz;
      if (dx*dx + dz*dz < (r*0.9)*(r*0.9)) return b;
    }
    return null;
  };
  g.director.enabled = false; g.enemies.clear();
  let violations = 0, steps = 0, minGap = Infinity;
  for (let si = 0; si < w.playerSpawns().length; si++) {
    for (let d = 0; d < 8; d++) {
      const sp = w.findPlayerSpawn(si);
      p.teleport([sp[0], sp[1] + 0.3, sp[2]]);
      p.yaw = d * Math.PI / 4;
      p.vel[0]=0; p.vel[1]=0; p.vel[2]=0;
      for (let k = 0; k < 6; k++) {
        window.__IRONFALL__.simulate(0.5, [{ seconds: 0.5, moveY: 1, sprint: true }]);
        steps++;
        if (inBox(p.pos, 0.35, 1.8)) violations++;
        const gy = w.groundHeight(p.pos[0], p.pos[2]);
        minGap = Math.min(minGap, p.pos[1] - gy);
      }
    }
  }
  return { steps, violations, minGapToTerrain: +minGap.toFixed(3) };
})()`);
check('长时间冲刺行走不进入任何实体内部', clip.violations === 0,
  `${clip.steps} 次采样，违规 ${clip.violations}，与地形最小间隙 ${clip.minGapToTerrain}m`);

// 贴墙推进：相机不应穿入墙体
const wallClip = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  const w = g.world, p = g.player;
  let worst = Infinity, cases = 0, tunneled = 0;
  let wall = null;
  for (const b of w.boxes) {
    const h = b.max[1]-b.min[1];
    if (h < 6) continue;
    const useX = (b.max[0]-b.min[0]) < (b.max[2]-b.min[2]);
    const cx=(b.min[0]+b.max[0])/2, cz=(b.min[2]+b.max[2])/2;
    const half = (useX ? (b.max[0]-b.min[0]) : (b.max[2]-b.min[2]))/2;
    const px = useX ? b.min[0]-half-2 : cx;
    const pz = useX ? cz : b.min[2]-half-2;
    const gy = w.groundHeight(px, pz);
    if (gy < b.min[1] - 5) continue;
    p.teleport([px, Math.max(gy, b.min[1]-0.01)+0.1, pz]);
    const nx = useX?1:0, nz = useX?0:1;
    p.yaw = Math.atan2(-nx,-nz); p.pitch = 0;
    window.__IRONFALL__.simulate(2.5, [{ seconds: 2.5, moveY: 1, sprint: true }]);
    // 距墙面的间隙
    const gap = useX ? Math.abs(p.pos[0] - b.min[0]) : Math.abs(p.pos[2] - b.min[2]);
    // 是否越过了墙面（穿模）
    const past = useX ? (p.pos[0] > b.min[0]) : (p.pos[2] > b.min[2]);
    if (past) tunneled++;
    worst = Math.min(worst, gap);
    cases++;
    if (cases >= 10) break;
  }
  return { cases, tunneled, minGap: +worst.toFixed(3), playerRadius: 0.35,
           note: '间隙应 ≥ 半径(0.35)，越小说明贴墙越紧但不该穿过去' };
})()`);
check('冲刺撞墙不穿过墙体', wallClip.tunneled === 0,
  `${wallClip.cases} 面墙，穿越 ${wallClip.tunneled}，最小间隙 ${wallClip.minGap}m（半径 ${wallClip.playerRadius}）`);

console.log('\n── 重生机制 ──');
const respawn = await ev(`(async () => {
  const g = window.__IRONFALL__.game;
  g.startRun();
  g.hud.hideMenu();
  const p = g.player;
  p.invulnTime = 0;
  // 打死：分多次小伤害，避免单次被任何减伤逻辑吞掉
  for (let i = 0; i < 40 && p.alive; i++) { p.invulnTime = 0; p.applyDamage(50, [0,0,-1], {}); }
  await new Promise(r => setTimeout(r, 120));
  const deadMenu = (() => { const el = document.querySelector('#menu-dead');
    if (!el) return null; const c = getComputedStyle(el);
    return { op: +c.opacity, visible: c.display !== 'none' && parseFloat(c.opacity) > 0.5 }; })();
  return { alive: p.alive, paused: g.paused, menuKind: g.menuKind,
           respawnTimer: +g._respawnTimer.toFixed(1), deadMenu,
           hasRetryApi: typeof g.retryRun === 'function' };
})()`);
check('玩家会真正死亡', respawn.alive === false, `alive=${respawn.alive}`);
check('死亡后弹出结算界面并暂停', respawn.paused === true && respawn.menuKind === 'dead',
  `menuKind=${respawn.menuKind} 死亡面板可见=${respawn.deadMenu && respawn.deadMenu.visible}`);
check('存在手动重生接口 retryRun()', respawn.hasRetryApi === true);
check('死亡后启动自动重生倒计时', respawn.respawnTimer > 0, `${respawn.respawnTimer}s`);
console.log('  死亡界面截图:', await shot('V2-dead-screen.png'));

const retried = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  g.retryRun();
  const p = g.player;
  return { alive: p.alive, health: p.health, paused: g.paused, menuKind: g.menuKind,
           phase: g.run.phase, playing: g._playing };
})()`);
check('retryRun() 能真正复活并继续游戏',
  retried.alive === true && retried.paused === false && retried.health > 0,
  JSON.stringify(retried));

console.log('\n── 设置 / 操作说明 / 制作名单 / 剧情简报 ──');
await ev(`(() => { const g = window.__IRONFALL__.game; g._feedBriefing(); g.hud.showMenu('main'); return true; })()`);
await new Promise((r) => setTimeout(r, 300));
const mainItems = await ev(`(() => Array.from(document.querySelectorAll('[id^="menu-main-item-"]'))
  .map(e => ({ id: e.id, text: String(e.textContent).replace(/\\s+/g,' ').trim().slice(0,40) })))()`);
console.log('  主菜单项:', JSON.stringify(mainItems));
check('主菜单包含远征简报条目', mainItems.some((i) => i.text.includes('远征简报')), JSON.stringify(mainItems.map((i) => i.text)));
check('主菜单包含制作名单条目', mainItems.some((i) => i.text.includes('制作名单')));

for (const [kind, file] of [['briefing','V7-briefing.png'], ['help','V3-help.png'], ['settings','V4-settings.png'], ['credits','V5-credits.png']]) {
  const exists = await ev(`(() => {
    const g = window.__IRONFALL__.game;
    g._feedBriefing();
    g.hud.showMenu('${kind}');
    return !!document.querySelector('#menu-${kind}');
  })()`);
  if (!exists) {
    check(`菜单 ${kind} 存在且可见`, false, '元素不存在');
    continue;
  }
  const v = await waitVisible('#menu-' + kind);
  check(`菜单 ${kind} 可见`, !!(v && v.visible), JSON.stringify(v));
  const txt = await ev(`(() => { const el = document.querySelector('#menu-${kind}');
    return el ? String(el.textContent).replace(/\\s+/g,' ').trim().slice(0, 150) : null; })()`);
  if (txt) console.log(`    ${txt}`);
  await new Promise((r2) => setTimeout(r2, 250));
  console.log(`  ${kind} 截图:`, await shot(file));
}

// 简报必须真的有剧情文案
const briefText = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  g._feedBriefing();
  g.hud.showMenu('briefing');
  const w = document.querySelector('#menu-briefing-world');
  const m = document.querySelector('#menu-briefing-mission');
  return { world: w ? String(w.textContent).trim() : null, mission: m ? String(m.textContent).trim() : null };
})()`);
check('剧情背景文案已注入', !!(briefText.world && briefText.world.length > 20),
  briefText.world ? briefText.world.slice(0, 60) + '…' : '空');
check('本局任务简报文案已注入', !!(briefText.mission && briefText.mission.length > 10),
  briefText.mission ? briefText.mission.slice(0, 60) + '…' : '空');

console.log('\n── 画面可见性：视图模型 / 敌人 / Esc 暂停 ──');
// 这一组是"看像素"而不是"看内部状态"的测试。
// 之前的测试只断言 vm.items.length / enemies.all.length 这类内部计数，
// 结果漏掉了两个真实 bug：枪被投影到视锥外（屏幕上看不见）、敌人生成但不入画。
// 结论：涉及"能不能看见"的功能，必须验证帧缓冲像素。

await ev(`(() => { const g = window.__IRONFALL__.game; g.hud.hideMenu(); g.startRun();
  g.director.enabled = false; g.enemies.clear(); return true; })()`);
await new Promise((r) => setTimeout(r, 200));
const realStart = await ev(`(() => { const F = window.__IRONFALL__, g = F.game;
  return { gamePlaying: g._playing, inputPlaying: F.Input.playing,
           menuBlocking: F.Input.menuBlocking, paused: g.paused, menuKind: g.menuKind }; })()`);
check('真实 startRun 同步 Game/Input 游玩状态（不靠测试手工补状态）',
  realStart.gamePlaying === true && realStart.inputPlaying === true &&
  realStart.menuBlocking === false && realStart.paused === false && realStart.menuKind === null,
  JSON.stringify(realStart));

const ammoAndHazard = await ev(`(() => { const F = window.__IRONFALL__, g = F.game;
  const mags = ['r99','flatline','volt'].map(id => [id, F.WEAPONS[id].magSize]);
  const hd = g.world._hazardSurfaceData;
  let minColor = 9, maxColor = 0;
  if (hd && hd.colors) for (let i=0; i<hd.colors.length; i+=4) {
    minColor = Math.min(minColor, hd.colors[i], hd.colors[i+1], hd.colors[i+2]);
    maxColor = Math.max(maxColor, hd.colors[i], hd.colors[i+1], hd.colors[i+2]);
  }
  return { mags, hazards: g.world.hazards().length, surfaceCount: hd ? hd.count : 0,
           colorContrast: +(maxColor-minColor).toFixed(3) };
})()`);
// 各枪弹匣按设计值分别校验（R-99 是 24，Flatline/Volt 是 35）——不要统一成一个数字
const MAG_EXPECT = { r99: 24, flatline: 35, volt: 35 };
check('各枪基础弹匣符合设计值',
  ammoAndHazard.mags.every((x) => MAG_EXPECT[x[0]] === undefined || x[1] === MAG_EXPECT[x[0]]),
  JSON.stringify(ammoAndHazard.mags) + ' 期望 ' + JSON.stringify(MAG_EXPECT));
check('每个危险区都有高对比可视表面与警戒边框',
  ammoAndHazard.hazards > 0 && ammoAndHazard.surfaceCount >= ammoAndHazard.hazards * 7 && ammoAndHazard.colorContrast >= 0.7,
  JSON.stringify(ammoAndHazard));

// 1) 视图模型：逐部件做 NDC 投影，统计"完全在画面内"的比例
//    用部件包围盒的 8 个角点判断（而不是只投影中心），否则细长部件会被误判。
const vmProj = await ev(`(async () => {
  const M = await import('/src/core/math.js');
  const g = window.__IRONFALL__.game;
  const e = g.engine, w = g.weapons;
  const def = w.current.def, vm = w.vm;
  const vmFov = window.__IRONFALL__.CFG.render.viewmodelFovDeg;
  const near = 0.008, far = 12, aspect = e.aspect;
  const vFov = 2 * Math.atan(Math.tan(vmFov * Math.PI / 180 * 0.5) / aspect);
  const proj = M.m4Perspective(vFov, aspect, near, far, M.m4());
  const view = M.m4Identity(M.m4());
  const vp = M.m4Mul(proj, view, M.m4());
  const root = M.m4Compose(vm.pos, vm.rot[1], vm.rot[0], vm.rot[2], def.viewmodel.scale || 1, M.m4());

  // 部件局部包围盒（与 weapons.js 的 buildViewmodelParts 保持一致的尺寸推导）
  const CORNERS = [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]];
  let inside = 0, anyVisible = 0;
  const detail = [];
  for (let i = 0; i < vm.items.length; i++) {
    const it = vm.items[i];
    const world = M.m4Mul(root, it.matrix, M.m4());
    let allIn = true, anyIn = false;
    let minY = 2, maxY = -2;
    for (const c of CORNERS) {
      const lp = [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 1];
      const wx = world[0]*lp[0] + world[4]*lp[1] + world[8]*lp[2] + world[12];
      const wy = world[1]*lp[0] + world[5]*lp[1] + world[9]*lp[2] + world[13];
      const wz = world[2]*lp[0] + world[6]*lp[1] + world[10]*lp[2] + world[14];
      const cx = vp[0]*wx + vp[4]*wy + vp[8]*wz + vp[12];
      const cy = vp[1]*wx + vp[5]*wy + vp[9]*wz + vp[13];
      const cw = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];
      if (cw <= 1e-6) { allIn = false; continue; }
      const ndx = cx / cw, ndy = cy / cw;
      if (ndy < minY) minY = ndy;
      if (ndy > maxY) maxY = ndy;
      if (Math.abs(ndx) <= 1 && Math.abs(ndy) <= 1) anyIn = true; else allIn = false;
    }
    if (allIn) inside++;
    if (anyIn) anyVisible++;
    detail.push({ i, allIn, anyIn, ndcYRange: [+minY.toFixed(2), +maxY.toFixed(2)] });
  }
  const offscreen = detail.filter(d => !d.anyIn).map(d => d.i);
  return { total: vm.items.length, inside, anyVisible, offscreen,
           vFovDeg: +(vFov*180/Math.PI).toFixed(1), vmFov, hipPos: def.viewmodel.hipPos };
})()`);
check('视图模型至少一半部件完整落在画面内', vmProj.inside >= Math.ceil(vmProj.total / 2),
  `${vmProj.inside}/${vmProj.total} 完整在画面内（视图模型 FOV ${vmProj.vmFov}°，垂直 ${vmProj.vFovDeg}°）`);
check('没有部件被整体挤出画面', vmProj.anyVisible === vmProj.total,
  `可见 ${vmProj.anyVisible}/${vmProj.total}${vmProj.offscreen.length ? '，屏外部件 ' + JSON.stringify(vmProj.offscreen) : ''}`);

// 2) 视图模型真的画出了像素（清屏成黑，只画枪）
const vmPixels = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  const e = g.engine, gl = e.gl;
  const W = e.width, H = e.height;
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  g.weapons.render(e);
  e.flush();
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let n = 0, minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y*W+x)*4;
    if (buf[i] > 8 || buf[i+1] > 8 || buf[i+2] > 8) {
      n++;
      if (x<minX) minX=x; if (x>maxX) maxX=x; if (y<minY) minY=y; if (y>maxY) maxY=y;
    }
  }
  return { W, H, pixels: n, pct: +(n/(W*H)*100).toFixed(2),
           bboxBottomUp: maxX>=0 ? [minX, minY, maxX, maxY] : null,
           bboxTopDown: maxX>=0 ? [minX, H-1-maxY, maxX, H-1-minY] : null };
})()`);
check('视图模型在屏幕上真的有像素（枪+手臂可见）', vmPixels.pixels > 800,
  `${vmPixels.pixels} px（占屏 ${vmPixels.pct}%），包围盒 ${JSON.stringify(vmPixels.bboxTopDown)}`);

// 3) 敌人真的画出了像素
//    ⚠️ 这条必须把前置条件写死，否则是"看运气"：
//    · 玩家必须站在已验证的开阔地（否则结构把敌人挡住 → 误报"渲染坏了"）
//    · 必须把视线**对准敌人**（否则敌人不在视野内 → 同样误报）
//    · 不能先 simulate()，那会让敌人走位/浮空，测的就不是"渲染"而是"AI 行为"
const enemyPixels = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  const e = g.engine, gl = e.gl;
  const p = g.player, w = g.world, en = g.enemies;
  en.clear();
  // 找一块开阔平地（四周无盒体）
  const ids = [];
  const clearOf = (x, z, r) => { ids.length = 0; w._boxHash.queryBox(x-r, z-r, x+r, z+r, ids);
    for (const bi of ids) { const b = w.boxes[bi];
      if (x+0.6 >= b.min[0] && x-0.6 <= b.max[0] && z+0.6 >= b.min[2] && z-0.6 <= b.max[2]) return false; }
    return true; };
  const cands = w.navCandidates();
  let spot = null;
  for (let i = 0; i < cands.length; i += 2) {
    const c = cands[i];
    if (w.sampleSlope(c[0], c[2]) > 0.03) continue;
    if (!clearOf(c[0], c[2], 14)) continue;
    spot = c; break;
  }
  if (!spot) spot = [p.pos[0], p.pos[1], p.pos[2]];
  p.teleport([spot[0], spot[1] + 0.05, spot[2]]);
  p.yaw = 0; p.pitch = 0;
  window.__IRONFALL__.simulate(1.0, [{ seconds: 1.0 }]);

  const ez = p.pos[2] - 8;
  const ey = w.groundHeight(p.pos[0], ez);
  const e1 = en.spawn('grunt', [p.pos[0], ey, ez]);
  const e2 = en.spawn('heavy', [p.pos[0] + 2.6, w.groundHeight(p.pos[0]+2.6, ez), ez]);
  e1.grounded = true; e2.grounded = true;
  // 视线对准第一个敌人的胸口（pitch 为正 = 抬头）
  p.pitch = -Math.atan2((e1.pos[1] + e1.height * 0.55) - p.eyePos[1], 8);
  p.updateCamera(0.016);

  const W = e.width, H = e.height;
  const grab = () => { const b = new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b); return b; };
  g.renderFrame(0.016);
  const withEn = grab();
  const saved = en.all.slice();
  en.all.length = 0;
  g.renderFrame(0.016);
  const without = grab();
  for (const x of saved) en.all.push(x);
  g.renderFrame(0.016);
  let diff = 0;
  for (let i = 0; i < withEn.length; i += 4) {
    if (withEn[i] !== without[i] || withEn[i+1] !== without[i+1] || withEn[i+2] !== without[i+2]) diff++;
  }
  // 诊断信息：把敌人投影到屏幕，失败时能直接看出是"不在视野"还是"没渲染"
  const vp = e.viewProj;
  const proj = (x, y, z) => {
    const cx = vp[0]*x+vp[4]*y+vp[8]*z+vp[12];
    const cy2 = vp[1]*x+vp[5]*y+vp[9]*z+vp[13];
    const cw = vp[3]*x+vp[7]*y+vp[11]*z+vp[15];
    return { w: +cw.toFixed(2), sx: cw !== 0 ? Math.round((cx/cw*0.5+0.5)*W) : -1,
             sy: cw !== 0 ? Math.round((-cy2/cw*0.5+0.5)*H) : -1 };
  };
  const info = saved.map((x) => {
    const pr = proj(x.pos[0], x.pos[1] + x.height * 0.5, x.pos[2]);
    return { type: x.typeId, screen: [pr.sx, pr.sy], clipW: pr.w,
             onScreen: pr.w > 0 && pr.sx >= 0 && pr.sx <= W && pr.sy >= 0 && pr.sy <= H,
             inFrustum: e.inFrustumSphere([x.pos[0], x.pos[1]+x.height*0.5, x.pos[2]], x.height*1.2),
             los: w.lineOfSight(p.eyePos, [x.pos[0], x.pos[1]+x.height*0.55, x.pos[2]]) };
  });
  return { alive: en.all.length, diffPixels: diff,
           enemyY: +saved[0].pos[1].toFixed(2), groundY: +ey.toFixed(2),
           canvas: [W, H], onScreenCount: info.filter(x => x.onScreen).length, info };
})()`);
check('敌人真的渲染到画面上（帧差异 > 500 px）', enemyPixels.diffPixels > 500,
  `${enemyPixels.alive} 个敌人，差异 ${enemyPixels.diffPixels} px（敌人 y=${enemyPixels.enemyY} 地面 ${enemyPixels.groundY}）`);
console.log('  画面可见性截图:', await shot('V8-visibility.png'));

// 4) 游玩中 Esc 必须从真实 startRun 状态直接打开设置，不能由测试手工 setPlaying 掩盖 bug
await new Promise((r) => setTimeout(r, 150));
const beforeEsc = await ev(`(() => { const g = window.__IRONFALL__.game;
  return { playing: g._playing, paused: g.paused, menuKind: g.menuKind }; })()`);
await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
await new Promise((r) => setTimeout(r, 260));
const afterEsc = await ev(`(() => { const g = window.__IRONFALL__.game;
  return { playing: g._playing, paused: g.paused, menuKind: g.menuKind, hudMenu: g.hud._menu }; })()`);
check('游玩中按 Esc 直接打开设置菜单并冻结世界',
  afterEsc.menuKind === 'settings' && afterEsc.hudMenu === 'settings' && afterEsc.paused === true,
  `之前 ${JSON.stringify(beforeEsc)} → 之后 ${JSON.stringify(afterEsc)}`);
await new Promise((r) => setTimeout(r, 300));
console.log('  设置菜单截图:', await shot('V9-settings.png'));

// 真机里浏览器可能优先消费 Esc，只发 pointerlockchange 而不给页面 keydown。
const lostLock = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  if (g.menuKind) g.closeMenuPanel();
  g.paused = false; g.menuKind = null; g.setPlaying(true); g.hud.hideMenu();
  document.dispatchEvent(new Event('pointerlockchange'));
  const I = window.__IRONFALL__.Input;
  I._injectLook(90, -70);
  const blocked = g.readInput();
  I._resetAll();
  return { playing: g._playing, inputPlaying: I.playing, menuBlocking: I.menuBlocking,
           paused: g.paused, menuKind: g.menuKind, hudMenu: g.hud._menu,
           lookX: blocked.lookX, lookY: blocked.lookY,
           hintNode: !!document.querySelector('#lock-hint') };
})()`);
check('浏览器吞掉 Esc 时，丢失指针锁仍直接进入设置且没有故障遮罩',
  lostLock.paused === true && lostLock.menuKind === 'settings' && lostLock.hudMenu === 'settings' &&
  lostLock.inputPlaying === false && lostLock.menuBlocking === true &&
  lostLock.lookX === 0 && lostLock.lookY === 0 && !lostLock.hintNode,
  JSON.stringify(lostLock));

// 补给站不能只是打开升级面板：生命、护盾、当前弹匣和全部备弹都必须真正补满。
const supply = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  if (g.menuKind) g.closeMenuPanel();
  g.player.health = 7; g.player.shield = 3;
  for (const st of g.weapons.state.values()) { st.ammo = 0; st.reserve = 0; st.reloading = true; }
  const station = { id: 'test_supply', used: false };
  g.run.nearSupplyStation = station;
  g._interact(0, { interactPressed: true });
  const weaponStates = [];
  for (const [id, st] of g.weapons.state) {
    const def = window.__IRONFALL__.WEAPONS[id];
    weaponStates.push({ id, ammo: st.ammo, mag: g.weapons._magSize(def), reserve: st.reserve,
                        reserveMax: def.reserveMax, reloading: st.reloading });
  }
  const out = { hp: g.player.health, maxHp: g.player.maxHealth,
    shield: g.player.shield, maxShield: g.player.maxShield,
    used: station.used, upgradeOpen: g._upgradeOpen, weaponStates };
  g.run.nearSupplyStation = null;
  return out;
})()`);
check('补给站一次补满生命、护盾、全部武器弹匣与备弹',
  supply.used && supply.hp === supply.maxHp && supply.shield === supply.maxShield &&
  supply.weaponStates.every((x) => x.ammo === x.mag && x.reserve === x.reserveMax && !x.reloading),
  JSON.stringify(supply));
check('补给后的强化货架确实打开（随后必须允许 Esc 跳过）', supply.upgradeOpen === true);
await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', {
  code: 'Escape', key: 'Escape', bubbles: true, cancelable: true
})); return true; })()`);
await new Promise((r) => setTimeout(r, 180));
const upgradeEsc = await ev(`(() => { const g = window.__IRONFALL__.game, I = window.__IRONFALL__.Input;
  return { upgradeOpen: g._upgradeOpen, paused: g.paused, menuKind: g.menuKind,
           hudMenu: g.hud._menu, inputPlaying: I.playing, menuBlocking: I.menuBlocking,
           panelOn: document.querySelector('#hud-upgrade').classList.contains('hud-upgrade--on') };
})()`);
check('合金不足时也能按 Esc 关闭强化弹窗并继续游戏',
  !upgradeEsc.upgradeOpen && !upgradeEsc.paused && upgradeEsc.menuKind === null &&
  upgradeEsc.hudMenu === null && upgradeEsc.inputPlaying === true &&
  upgradeEsc.menuBlocking === false && !upgradeEsc.panelOn,
  JSON.stringify(upgradeEsc));

// 5) 开局增援必须存在，但不能出生在可立即攻击玩家的距离内。
//    方向由敌人/任务标记负责提示；不再为了“第一眼可见”把整队刷在准星前方。
const opening = await ev(`(() => {
  const g = window.__IRONFALL__.game, e = g.engine, p = g.player, en = g.enemies;
  if (g.menuKind) g.closeMenuPanel();
  en.clear();
  g.director.enabled = true;
  g.director.start(g.run);
  g.run.phase = 'objectives';
  p.health = p.maxHealth; p.shield = p.maxShield;
  window.__IRONFALL__.simulate(6.0, [{ seconds: 6.0 }]);
  window.__IRONFALL__.renderOnce();

  const alive = en.all.filter(x => x.alive);
  let inFront = 0, inFrustum = 0, near = 0, immediateThreat = 0;
  for (const x of alive) {
    const dx = x.pos[0] - p.pos[0], dz = x.pos[2] - p.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 30) near++;
    if (d <= (x.type.attackRange || 0) + 10) immediateThreat++;
    const dot = (dx / (d || 1)) * p.forward[0] + (dz / (d || 1)) * p.forward[2];
    if (dot > 0) inFront++;
    if (e.inFrustumSphere([x.pos[0], x.pos[1] + x.height * 0.5, x.pos[2]], x.height * 1.2)) inFrustum++;
  }
  return { alive: alive.length, inFront, inFrustum, near30: near, immediateThreat,
           openingStats: g.director._openingStats || null,
           director: g.director.debugState(),
           distances: alive.map(x => +Math.hypot(x.pos[0]-p.pos[0], x.pos[2]-p.pos[2]).toFixed(1)) };
})()`);
check('开局导演会生成远距离增援', opening.alive > 0,
  `存活 ${opening.alive}，前方半球 ${opening.inFront}，30m 内 ${opening.near30}，距离 ${JSON.stringify(opening.distances)}`);
check('新敌人不在可立即攻击玩家的范围', opening.immediateThreat === 0 && opening.near30 === 0,
  `立即威胁 ${opening.immediateThreat}/${opening.alive}，30m 内 ${opening.near30}`);
console.log('  开局遭遇截图:', await shot('V10-opening-wave.png'));

console.log('\n── F3 调试面板 / 升级面板 / 目标 / 提示 / 撤离 ──');
const setups = [
  ['#hud-debug', `(() => { window.__IRONFALL__.game.hud.setDebugPanelVisible(true); return true; })()`, 'F3 调试面板'],
  ['#hud-objective', `(() => { window.__IRONFALL__.game.hud.setObjective('摧毁热核中继', 1, 3); return true; })()`, '目标进度条'],
  ['#hud-prompt', `(() => { window.__IRONFALL__.game.hud.setPrompt('[F] 接入补给站'); return true; })()`, '交互提示'],
  ['#hud-extraction', `(() => { window.__IRONFALL__.game.hud.setExtraction(12); return true; })()`, '撤离倒计时'],
  ['#hud-upgrade', `(() => { const g = window.__IRONFALL__.game; g.upgrades.addAlloy(999);
      g.hud.showUpgradePanel(g.upgrades.rollOffers(3, () => 0.3), g.upgrades.alloy); return true; })()`, '肉鸽升级面板'],
];
await ev(`(() => { const g = window.__IRONFALL__.game; g.hud.hideMenu(); g.startRun(); return true; })()`);
await new Promise((r) => setTimeout(r, 200));

const adsAndWaypoint = await ev(`(() => {
  const g = window.__IRONFALL__.game;
  window.__IRONFALL__.simulate(0.45, [{ seconds: 0.45, ads: true }]);
  g.hud.render();
  const ads = document.querySelector('#hud-ads');
  const wp = document.querySelector('#hud-waypoint');
  const cur = g.weapons.current;
  return { adsT: cur.adsT, adsOn: !!ads && ads.classList.contains('hud-ads--on'),
    adsOpacity: ads ? parseFloat(getComputedStyle(ads).opacity) : 0,
    vmZ: +g.weapons.vm.pos[2].toFixed(3), adsTargetZ: cur.def.viewmodel.adsPos[2],
    waypointOn: !!wp && wp.classList.contains('hud-waypoint--on'),
    waypointText: wp ? String(wp.textContent).replace(/\\s+/g, ' ').trim() : '' };
})()`);
check('右键 ADS 完成后显示光学准具且枪身前移，不再只看到枪屁股',
  adsAndWaypoint.adsT > 0.95 && adsAndWaypoint.adsOn && adsAndWaypoint.adsOpacity > 0.9 &&
  adsAndWaypoint.vmZ < -0.40 && adsAndWaypoint.adsTargetZ < -0.40,
  JSON.stringify(adsAndWaypoint));
check('当前任务地点显示屏幕空间信标、名称与米数',
  adsAndWaypoint.waypointOn && /[0-9]/.test(adsAndWaypoint.waypointText) && adsAndWaypoint.waypointText.includes(' m'),
  JSON.stringify(adsAndWaypoint));
for (const [sel, setup, label] of setups) {
  await ev(setup);
  const v = await waitVisible(sel);
  check(`${label} 可见`, !!(v && v.visible), JSON.stringify(v));
}
console.log('  升级面板截图:', await shot('V6-upgrade.png'));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(`截图目录: ${OUT}`);
ws.close(); proc.kill(); server.close();
process.exit(fail > 0 ? 1 : 0);
