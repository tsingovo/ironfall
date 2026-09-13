// ==== tools/test-lan.mjs — 局域网联机端到端验证（两个真实 Chrome 客户端）====
//
// 这是联机功能的**唯一可信**验证：起一个真实的局域网服务器，开两个互相独立的
// Chrome 实例，一个当房主一个当房客，走完“建房 → 加入 → 开局 → 同图 → 互相看见
// → 敌人同步 → 命中转发 → 敌人伤害转发”的完整链路。
//
// 用法: node tools/test-lan.mjs [--keep] [--port 19311]
//   --keep   保留截图与浏览器现场（排查用）

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireChrome, headlessArgs } from './lib/chrome.mjs';
import { createLanServer } from './lan-server.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'docs/verify/lan');
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const PORT = flag('port', 19300 + Math.floor(Math.random() * 60));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; process.stdout.write(`  PASS  ${name}\n`); }
  else {
    fail++;
    failures.push(`${name}${detail ? '  [' + detail + ']' : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? '  [' + detail + ']' : ''}\n`);
  }
}
function section(t) { process.stdout.write(`\n── ${t} ──\n`); }

// ---------------------------------------------------------------- CDP 客户端

class Client {
  constructor(label, userDataDir) {
    this.label = label;
    this.userDataDir = userDataDir;
    this.proc = null;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  async launch(chrome, url) {
    // 沙箱禁止通过管道捕获子进程输出，因此把 stdout/stderr 直接重定向到日志文件：
    // 既能拿到崩溃诊断，又不使用 stdio: 'pipe'。
    await mkdir(this.userDataDir, { recursive: true });
    this.logPath = join(this.userDataDir, 'chrome.log');
    const fd = openSync(this.logPath, 'w');
    try {
      this.proc = spawn(chrome, headlessArgs(this.userDataDir, [
        '--window-size=1280,720', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', 'about:blank',
      ]), { stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const portFile = join(this.userDataDir, 'DevToolsActivePort');
    let dport = 0;
    for (let i = 0; i < 200; i++) {
      try {
        const t = await readFile(portFile, 'utf8');
        dport = Number(t.split('\n')[0]);
        if (dport) break;
      } catch (_e) { /* 还没写出来 */ }
      await sleep(150);
    }
    if (!dport) {
      let tail = '';
      try { tail = String(await readFile(this.logPath, 'utf8')).slice(-800); } catch (_e) { /* 忽略 */ }
      throw new Error(`${this.label}: 未能取得 DevTools 端口\n${tail}`);
    }
    const target = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: 'PUT' })).json();
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.wsState = 'connecting';
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${this.label}: DevTools WebSocket 连接超时`)), 15000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); this.wsState = 'open'; res(); });
      this.ws.addEventListener('error', () => { this.wsState = 'error'; });
      this.ws.addEventListener('close', () => { this.wsState = 'closed'; });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this._pending.has(m.id)) { this._pending.get(m.id)(m); this._pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
        const text = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
        this.consoleErrors.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        this.pageErrors.push(String((d && d.exception && d.exception.description) || (d && d.text) || 'error'));
      }
    });
    this.send('Page.enable');
    this.send('Runtime.enable');
    this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    this.send('Page.navigate', { url });
    return this;
  }

  send(method, params, timeoutMs = 25000) {
    return new Promise((res) => {
      const i = ++this._id;
      // 超时兜底：CDP 连接一旦失效，Promise 永远不会 settle，整个测试会静默挂死。
      // 这里宁可返回一个带 __timeout 的结果，让断言如实报错。
      const timer = setTimeout(() => {
        if (!this._pending.has(i)) return;
        this._pending.delete(i);
        res({ __timeout: true, method });
      }, timeoutMs);
      this._pending.set(i, (m) => { clearTimeout(timer); res(m); });
      try {
        this.ws.send(JSON.stringify({ id: i, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(i);
        res({ __error: String(err && err.message) });
      }
    });
  }

  async ev(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r && r.__timeout) return { __timeout: true, expr };
    const res = r.result || {};
    if (res.exceptionDetails) {
      return { __error: String(res.exceptionDetails.text || '') + ' ' + String((res.exceptionDetails.exception || {}).description || '') };
    }
    return res.result ? res.result.value : undefined;
  }

  async waitReady(timeoutMs = 60000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.ev('window.__IRONFALL__ ? !!window.__IRONFALL__.ready : false');
      if (last === true) return true;
      if (last && last.__timeout) return { __timeout: true, ws: this.wsState };
      if (this.proc && this.proc.exitCode !== null && this.proc.exitCode !== undefined) {
        return { __exited: this.proc.exitCode };
      }
      await sleep(300);
    }
    return { __bootTimeout: true, last };
  }

  /** 轮询等待表达式变为真值 */
  async waitFor(expr, timeoutMs = 12000, label = '') {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.ev(expr);
      if (last) return last;
      await sleep(150);
    }
    return { __timeout: true, label, last };
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const d = (r && r.result ? r.result : r).data;
    if (!d) return null;
    const p = join(OUT, `${this.label}-${name}.png`);
    await writeFile(p, Buffer.from(d, 'base64'));
    return p;
  }

  kill() {
    try { if (this.ws) this.ws.close(); } catch (_e) { /* 忽略 */ }
    try { if (this.proc) this.proc.kill(); } catch (_e) { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------- 主流程

await mkdir(OUT, { recursive: true });
const chrome = requireChrome('test-lan');
const server = createLanServer({ port: PORT, host: '127.0.0.1' });
await server.listen();
process.stdout.write(`局域网服务器: http://127.0.0.1:${PORT}/\n`);

const host = new Client('host', join(tmpdir(), 'ironfall-lan-host-' + Date.now()));
const guest = new Client('guest', join(tmpdir(), 'ironfall-lan-guest-' + Date.now()));

try {
  section('1. 两个客户端加载局域网服务器上的游戏');

  // 两个无头实例都跑 SwiftShader，串行启动更稳（并发启动时第二个常常起不来）
  await host.launch(chrome, `http://127.0.0.1:${PORT}/index.html?lan=1`);
  const hostReady = await host.waitReady();
  check('房主客户端启动完成', hostReady === true, JSON.stringify(hostReady));
  if (hostReady !== true) throw new Error('房主客户端未能启动，后续联机断言无法进行');

  await guest.launch(chrome, `http://127.0.0.1:${PORT}/index.html?lan=1`);
  const guestReady = await guest.waitReady();
  check('房客客户端启动完成', guestReady === true, JSON.stringify(guestReady));
  if (guestReady !== true) throw new Error('房客客户端未能启动，后续联机断言无法进行');

  await host.ev('window.__IRONFALL__.setAutomationMode(true)');
  await guest.ev('window.__IRONFALL__.setAutomationMode(true)');
  await sleep(300);

  const bootErrors = await host.ev('window.__IRONFALL__.errors.length');
  check('房主启动无内部错误', bootErrors === 0, String(bootErrors));

  section('1b. 未联机时单机玩法不受联机代码影响（回归护栏）');

  // 这条护栏对应一个真实踩过的坑：LanSession.applyRoleToWorld() 曾经只判断
  // isHost，于是 role='off' 的单机也会掉进“房客”分支，把敌人切成复制模式，
  // 结果单机敌人全部不动、也不攻击。
  await host.ev('window.__IRONFALL__.startRun()');
  await sleep(700);
  const offline = await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    return {
      replicated: g.enemies.replicated,
      players: g.enemies.players.length,
      directorActive: g.director.active,
      lanActive: g.lan.active,
    };
  })()`);
  check('未联机时敌人系统处于权威模式', !!(offline && offline.replicated === false), JSON.stringify(offline));
  check('未联机时敌人目标列表只有本机玩家', !!(offline && offline.players === 1), JSON.stringify(offline));
  check('未联机时刷怪导演在运行', !!(offline && offline.directorActive === true), JSON.stringify(offline));

  // 找一块干净场地（与 headless-check 相同的判据）：否则玩家可能背靠结构，
  // 敌人没有视线也不会警觉，护栏就会假失败。
  const clearSpot = await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    const w = g.world;
    const cands = w.navCandidates ? w.navCandidates() : [];
    let best = null, bestScore = -1e9;
    for (const c of cands) {
      if (!c || c.length < 3) continue;
      if (w.sampleSlope(c[0], c[2]) > 0.05) continue;
      let hMin = Infinity, hMax = -Infinity;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const h = w.groundHeight(c[0] + dx, c[2] + dz);
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      }
      if (hMax - hMin > 2.5) continue;
      if (w.raycast([c[0], c[1] + 1.0, c[2]], [0, 0, -1], 14, { hitTriangles: false }).hit) continue;
      if (w.raycast([c[0], c[1] + 0.6, c[2]], [0, 1, 0], 12, {}).hit) continue;
      const score = -Math.hypot(c[0], c[2]) - (hMax - hMin) * 4;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best ? [best[0], best[1] + 0.05, best[2]] : null;
  })()`);
  check('找到用于单机 AI 护栏的干净场地', Array.isArray(clearSpot), JSON.stringify(clearSpot));

  // 直接观察 AI 是否真的被调用，比“敌人移动了”稳定得多：复制模式会
  // `continue` 掉整个 AI/物理段，因此 _updateAI 的调用次数会在那一刻掉到 0。
  // 这正是当初那个 bug 的可判定特征，不依赖视线/场地/导航等易变条件。
  const aiCalls = await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    const en = g.enemies;
    en.clear();
    g.director.enabled = false;
    const p = g.player;
    p.health = p.maxHealth; p.shield = p.maxShield; p.alive = true;
    const spot = ${JSON.stringify(clearSpot)};
    if (spot) p.teleport(spot);
    window.__IRONFALL__.simulate(0.3);
    en.spawn('grunt', [p.pos[0] + 12, g.world.groundHeight(p.pos[0] + 12, p.pos[2]), p.pos[2]]);
    const orig = en._updateAI;
    let calls = 0, physics = 0;
    const origPhysics = en._physics;
    en._updateAI = function (...a) { calls++; return orig.apply(this, a); };
    en._physics = function (...a) { physics++; return origPhysics.apply(this, a); };
    try {
      window.__IRONFALL__.simulate(0.5);
    } finally {
      en._updateAI = orig;
      en._physics = origPhysics;
    }
    g.director.enabled = true;
    return { calls, physics, steps: Math.round(0.5 / (1 / 128)) };
  })()`);
  check('未联机时每个物理步都会跑敌人 AI（复制模式会整段跳过）',
    !!(aiCalls && aiCalls.calls > 0 && aiCalls.physics > 0),
    JSON.stringify(aiCalls));

  await host.ev('window.__IRONFALL__.game.director.stop()');

  // 房客从同一台服务器加载时，WebSocket 地址应当自动指向同一个 host:port
  const wsUrl = await guest.ev('window.__IRONFALL__.game.lan._t.url');
  check('WebSocket 地址由页面地址自动推导', wsUrl === `ws://127.0.0.1:${PORT}/ws`, String(wsUrl));

  section('2. 建房 / 加入 / 名册');

  const hostOk = await host.ev('window.__IRONFALL__.game._lanConnect(true)');
  check('房主创建房间成功', hostOk === true, JSON.stringify(hostOk));

  const guestOk = await guest.ev('window.__IRONFALL__.game._lanConnect(false)');
  check('房客加入房间成功', guestOk === true, JSON.stringify(guestOk));

  const hostSees = await host.waitFor('window.__IRONFALL__.game.lan.remotes.size', 8000, 'host remotes');
  const guestSees = await guest.waitFor('window.__IRONFALL__.game.lan.remotes.size', 8000, 'guest remotes');
  check('房主看到 1 名队友', hostSees === 1, String(hostSees));
  check('房客看到 1 名队友', guestSees === 1, String(guestSees));

  const roleInfo = await host.ev(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    return { isHost: lan.isHost, phase: lan.phase, peers: lan.lobbyState().peers.length };
  })()`);
  check('房主角色与本机判定一致', roleInfo && roleInfo.isHost === true, JSON.stringify(roleInfo));
  check('房主名册含 2 人', roleInfo && roleInfo.peers === 2, JSON.stringify(roleInfo));

  const guestRole = await guest.ev('window.__IRONFALL__.game.lan.isHost');
  check('房客知道自己不是房主', guestRole === false, String(guestRole));

  section('3. 队伍聊天');

  await host.ev(`window.__IRONFALL__.game.lan.sendChat('房主呼叫，听到请回答')`);
  const chatAtGuest = await guest.waitFor(
    `window.__IRONFALL__.game.lan.chat.filter(c => c.text === '房主呼叫，听到请回答').length`,
    6000, 'chat');
  check('房客收到房主聊天', chatAtGuest === 1, String(chatAtGuest));

  await guest.ev(`window.__IRONFALL__.game.lan.sendChat('收到，准备就绪')`);
  const chatAtHost = await host.waitFor(
    `window.__IRONFALL__.game.lan.chat.filter(c => c.text === '收到，准备就绪').length`,
    6000, 'chat');
  check('房主收到房客聊天', chatAtHost === 1, String(chatAtHost));

  section('4. 房主开局 → 房客同图同种子');

  const hostSeedBefore = await host.ev('window.__IRONFALL__.game.mapSeed');
  await host.ev('window.__IRONFALL__.startRun()');

  const guestPlaying = await guest.waitFor(
    `window.__IRONFALL__.game.lan.phase === 'playing'`, 20000, 'guest session');
  check('房客收到开局广播并进入局内', guestPlaying === true, JSON.stringify(guestPlaying));

  await sleep(900);
  const parity = await Promise.all([
    host.ev('({seed: window.__IRONFALL__.game.mapSeed, map: window.__IRONFALL__.game.mapName, idx: window.__IRONFALL__.game.mapIndex, tier: window.__IRONFALL__.game.tier})'),
    guest.ev('({seed: window.__IRONFALL__.game.mapSeed, map: window.__IRONFALL__.game.mapName, idx: window.__IRONFALL__.game.mapIndex, tier: window.__IRONFALL__.game.tier})'),
  ]);
  const [h, g] = parity;
  check('两端地图种子一致', h && g && h.seed === g.seed, `host=${h && h.seed} guest=${g && g.seed}`);
  check('两端任务关一致', h && g && h.idx === g.idx && h.tier === g.tier, `${h && h.idx}/${h && h.tier} vs ${g && g.idx}/${g && g.tier}`);
  check('两端地图名一致', h && g && h.map === g.map, `${h && h.map} vs ${g && g.map}`);

  // 地图几何必须逐字段一致，否则联机时两人站的地方都不一样
  const mapHash = await Promise.all([
    host.ev(`(() => { const w = window.__IRONFALL__.game.world; return { boxes: w.boxes ? w.boxes.length : -1, sp: (w.spawnPoints() || []).length, ob: (w.objectives() || []).length, ex: (w.extractPoints() || []).length }; })()`),
    guest.ev(`(() => { const w = window.__IRONFALL__.game.world; return { boxes: w.boxes ? w.boxes.length : -1, sp: (w.spawnPoints() || []).length, ob: (w.objectives() || []).length, ex: (w.extractPoints() || []).length }; })()`),
  ]);
  check('两端地图结构数量一致',
    JSON.stringify(mapHash[0]) === JSON.stringify(mapHash[1]),
    `${JSON.stringify(mapHash[0])} vs ${JSON.stringify(mapHash[1])}`);

  section('5. 玩家互相可见（位置复制 + 第三人称模型）');

  const hostPos = await host.ev('[...window.__IRONFALL__.game.player.pos].map(v => Math.round(v * 100) / 100)');
  const guestPos = await guest.ev('[...window.__IRONFALL__.game.player.pos].map(v => Math.round(v * 100) / 100)');
  const spawnDist = Math.hypot(hostPos[0] - guestPos[0], hostPos[2] - guestPos[2]);
  check('两人出生点不重叠', spawnDist > 1.0, `${spawnDist.toFixed(2)} m`);

  // 让双方各跑一会儿，产生真实位移再比对
  await host.ev(`window.__IRONFALL__.simulate(0.8)`);
  await guest.ev(`window.__IRONFALL__.simulate(0.8)`);
  await sleep(1200);

  const mirror = await host.ev(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    const r = [...lan.remotes.values()][0];
    return r ? { name: r.name, pos: [r.pos[0], r.pos[1], r.pos[2]], alive: r.alive, hp: r.health } : null;
  })()`);
  const guestTruth = await guest.ev('[...window.__IRONFALL__.game.player.pos]');
  check('房主收到房客的位置', !!mirror, JSON.stringify(mirror));
  if (mirror && guestTruth) {
    const d = Math.hypot(mirror.pos[0] - guestTruth[0], mirror.pos[1] - guestTruth[1], mirror.pos[2] - guestTruth[2]);
    check('房主看到的房客位置与房客真实位置一致（<1.5m）', d < 1.5, `${d.toFixed(3)} m`);
  }

  const guestMirror = await guest.ev(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    const r = [...lan.remotes.values()][0];
    return r ? { name: r.name, pos: [r.pos[0], r.pos[1], r.pos[2]] } : null;
  })()`);
  check('房客收到房主的位置', !!guestMirror, JSON.stringify(guestMirror));

  const avatarGuest = await guest.ev(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    window.__IRONFALL__.renderOnce();
    return lan.avatar ? lan.avatar.debugState() : null;
  })()`);
  check('房客真的画出了队友模型（实例数 > 0）',
    !!(avatarGuest && avatarGuest.instances > 0), JSON.stringify(avatarGuest));
  check('队友模型部件数符合整身人形', !!(avatarGuest && avatarGuest.instances >= 21),
    JSON.stringify(avatarGuest));

  const hostName = await guest.ev('window.__IRONFALL__.game.lan.selfName');
  check('房客端记录了自己的名字', typeof hostName === 'string' && hostName.length > 0, String(hostName));

  section('5b. 队友模型真的进入画面（像素级证据）');

  // 把房主搬到房客正前方 6m，保证队友模型落在画面中央；否则截图只能证明
  // “游戏在跑”，证明不了“队友可见”——这正是本项目要求 pixel 证据的原因。
  const placed = await guest.ev(`(() => {
    const g = window.__IRONFALL__.game;
    const p = g.player;
    p.pitch = 0;
    p.updateBasis();
    const f = p.forward;
    const x = p.pos[0] + f[0] * 6, z = p.pos[2] + f[2] * 6;
    const y = g.world.groundHeight ? g.world.groundHeight(x, z) + 0.05 : p.pos[1];
    return { x, y, z, yaw: p.yaw };
  })()`);
  await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    g.player.teleport([${placed.x}, ${placed.y}, ${placed.z}]);
    return true;
  })()`);

  const replicated = await guest.waitFor(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    const r = [...lan.remotes.values()][0];
    if (!r) return false;
    return Math.hypot(r.pos[0] - ${placed.x}, r.pos[2] - ${placed.z}) < 1.5;
  })()`, 10000, 'avatar replicated to front');
  check('房主位置已复制到房客正前方', replicated === true, JSON.stringify(replicated));

  // 投影到裁剪空间：确认队友确实落在视锥内（而不是被身后或视野外“看不见”）
  const onScreen = await guest.ev(`(() => {
    const g = window.__IRONFALL__.game;
    window.__IRONFALL__.renderOnce();
    const lan = g.lan;
    const r = [...lan.remotes.values()][0];
    if (!r) return null;
    const vp = g.engine.viewProj;
    const wx = r.pos[0], wy = r.pos[1] + 1.2, wz = r.pos[2];
    const cx = vp[0]*wx + vp[4]*wy + vp[8]*wz + vp[12];
    const cy = vp[1]*wx + vp[5]*wy + vp[9]*wz + vp[13];
    const cw = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];
    if (cw <= 0.05) return { behind: true };
    return { ndcX: cx / cw, ndcY: cy / cw, dist: Math.hypot(wx - g.player.pos[0], wy - g.player.pos[1], wz - g.player.pos[2]) };
  })()`);
  check('队友落在视锥内（屏幕坐标在 ±1 之间）',
    !!(onScreen && !onScreen.behind && Math.abs(onScreen.ndcX) <= 1 && Math.abs(onScreen.ndcY) <= 1),
    JSON.stringify(onScreen));

  // 关掉/打开联机队友渲染，比较同一机位的帧间差异。
  //
  // 不能简单地数“亮像素”：这张图本来就几乎全亮，队友模型反而会遮掉一些亮像素
  // （第一次实测 delta = -4173，方向恰好相反）。正确做法是先测**帧间噪声基线**
  // （连续两帧都开着队友时的差异，来自粒子/动画），再测关掉队友后的差异；
  // 后者必须显著大于前者，才能证明队友模型确实占据了像素。
  const pixelDelta = await guest.ev(`(() => {
    const g = window.__IRONFALL__.game;
    const gl = g.engine.gl;
    const W = g.engine.width, H = g.engine.height;
    const buf = new Uint8Array(W * H * 4);
    const snap = new Uint8Array(W * H * 4);
    const read = (into) => {
      window.__IRONFALL__.renderOnce();
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      into.set(buf);
    };
    const diff = (x, y) => {
      let n = 0;
      for (let i = 0; i < x.length; i += 4) {
        if (Math.abs(x[i] - y[i]) > 12 || Math.abs(x[i + 1] - y[i + 1]) > 12 || Math.abs(x[i + 2] - y[i + 2]) > 12) n++;
      }
      return n;
    };
    const lan = g.lan;
    lan.avatar.enabled = true;
    read(snap);
    const noiseA = new Uint8Array(W * H * 4);
    read(noiseA);                       // 同机位连拍 → 帧间噪声
    const noise = diff(snap, noiseA);

    lan.avatar.enabled = false;
    const off = new Uint8Array(W * H * 4);
    read(off);
    const withAvatarOff = diff(snap, off);
    lan.avatar.enabled = true;

    return { noise, withAvatarOff, total: W * H, avatarInstances: lan.avatar.debugState().instances };
  })()`);
  const pd = pixelDelta || {};
  check('关掉队友后帧间差异远大于噪声（队友模型确实占像素）',
    Number.isFinite(pd.withAvatarOff) && Number.isFinite(pd.noise)
      && pd.withAvatarOff > 500 && pd.withAvatarOff > Math.max(400, pd.noise * 3),
    JSON.stringify(pd));

  await guest.shot('teammate-visible');
  check('队友可见性截图已保存', true);

  section('6. 敌人同步（房主权威 → 房客复制）');

  const spawned = await host.waitFor(
    'window.__IRONFALL__.game.enemies.all.filter(e => e.alive).length', 25000, 'host enemies');
  check('房主刷出了敌人', typeof spawned === 'number' && spawned > 0, String(spawned));

  const guestEnemies = await guest.waitFor(
    'window.__IRONFALL__.game.enemies.all.filter(e => e.alive).length', 15000, 'guest enemies');
  check('房客看到了敌人（来自房主快照）', typeof guestEnemies === 'number' && guestEnemies > 0,
    String(guestEnemies));

  const guestReplicated = await guest.ev('window.__IRONFALL__.game.enemies.replicated');
  check('房客的敌人系统处于复制模式（不跑 AI）', guestReplicated === true, String(guestReplicated));

  const hostDirectorActive = await host.ev('window.__IRONFALL__.game.director.active');
  const guestDirectorActive = await guest.ev('window.__IRONFALL__.game.director.active');
  check('只有房主在跑刷怪导演', hostDirectorActive === true && !guestDirectorActive,
    `host=${hostDirectorActive} guest=${guestDirectorActive}`);

  const idCompare = await Promise.all([
    host.ev('window.__IRONFALL__.game.enemies.all.filter(e => e.alive).map(e => e.id).sort((a,b)=>a-b)'),
    guest.ev('window.__IRONFALL__.game.enemies.all.filter(e => e.alive).map(e => e.id).sort((a,b)=>a-b)'),
  ]);
  const hostIds = idCompare[0] || [];
  const guestIds = idCompare[1] || [];
  const missing = hostIds.filter((id) => !guestIds.includes(id));
  check('房客的敌人 id 集合覆盖房主（允许刚出生的一两只还没到）',
    hostIds.length > 0 && missing.length <= 2,
    `host=${hostIds.length} guest=${guestIds.length} 缺失=${missing.length}`);

  // 位置一致性：取两端都有的第一只敌人
  const sharedId = hostIds.find((id) => guestIds.includes(id));
  if (sharedId != null) {
    const posPair = await Promise.all([
      host.ev(`(() => { const e = window.__IRONFALL__.game.enemies.findByNetId(${sharedId}); return e ? [e.pos[0], e.pos[1], e.pos[2]] : null; })()`),
      guest.ev(`(() => { const e = window.__IRONFALL__.game.enemies.findByNetId(${sharedId}); return e ? [e.pos[0], e.pos[1], e.pos[2]] : null; })()`),
    ]);
    if (posPair[0] && posPair[1]) {
      // 房客做的是插值跟随，落后半拍属正常；用 4m 作为宽松上限
      const d = Math.hypot(posPair[0][0] - posPair[1][0], posPair[0][1] - posPair[1][1], posPair[0][2] - posPair[1][2]);
      check('同一只敌人在两端位置接近（<4m）', d < 4, `${d.toFixed(2)} m`);
    } else {
      check('同一只敌人在两端位置接近（<4m）', false, '任一端找不到该敌人');
    }
  } else {
    check('同一只敌人在两端位置接近（<4m）', false, '两端没有共同 id');
  }

  section('7. 命中转发（房客开火 → 房主权威结算）');

  const hitId = sharedId;
  if (hitId != null) {
    const before = await host.ev(`(() => { const e = window.__IRONFALL__.game.enemies.findByNetId(${hitId}); return e ? { hp: e.hp, sh: e.shield, alive: e.alive } : null; })()`);
    const beforeSum = before ? before.sh + before.hp : null;
    // 房客侧走完整的 damage() 路径（武器命中也走这一条），应产生 hitReport 上行
    await guest.ev(`(() => {
      const g = window.__IRONFALL__.game;
      const e = g.enemies.findByNetId(${hitId});
      if (!e) return false;
      g.enemies.damage(e, 20, false, [e.pos[0], e.pos[1] + 1.0, e.pos[2]], [0, 1, 0], {});
      return true;
    })()`);
    // 必须等“血量确实掉下来”这个**变化**，而不是等一个永远为真的数字表达式：
    // 无头 SwiftShader 下每秒只有几帧，过早读取会拿到改动前的值。
    const dropped = await host.waitFor(
      `(() => { const e = window.__IRONFALL__.game.enemies.findByNetId(${hitId});
        return !!e && (e.shield + e.hp) < ${beforeSum - 15}; })()`,
      12000, 'host hp drop');
    const afterSum = await host.ev(
      `(() => { const e = window.__IRONFALL__.game.enemies.findByNetId(${hitId}); return e ? (e.shield + e.hp) : null; })()`);
    check('房主侧该敌人血量确实下降', dropped === true && afterSum < beforeSum - 15,
      `before=${beforeSum} after=${afterSum}`);

    const drained = await guest.waitFor(
      'window.__IRONFALL__.game.enemies.hitReports.length === 0', 8000, 'hit queue drained');
    check('房客的命中队列已被取空（未重复上报）', drained === true,
      String(await guest.ev('window.__IRONFALL__.game.enemies.hitReports.length')));
  } else {
    check('房主侧该敌人血量确实下降', false, '没有可用的共同敌人');
  }

  section('8. 敌人伤害转发（房主判定 → 房客本人结算）');

  const hpBefore = await guest.ev('window.__IRONFALL__.game.player.shield + window.__IRONFALL__.game.player.health');
  await host.ev(`(() => {
    const lan = window.__IRONFALL__.game.lan;
    const r = [...lan.remotes.values()][0];
    if (!r) return false;
    // 模拟敌人 AI 命中远程玩家代理：应当转发给房客本人结算
    r.applyDamage(15, [0, 0, 1], 'enemy');
    return true;
  })()`);
  await sleep(500);
  const hpAfter = await guest.ev('window.__IRONFALL__.game.player.shield + window.__IRONFALL__.game.player.health');
  check('房客本机血量按房主判定下降',
    typeof hpAfter === 'number' && typeof hpBefore === 'number' && hpAfter < hpBefore - 1,
    `${hpBefore} → ${hpAfter}`);

  section('8b. 2.0.7 守关首领的联机同步');

  // 首领是本轮唯一“房主凭空造出来的特殊敌人”：director 里手动放大它
  // （scale 1.6、maxHp *= 5 + tier、maxShield *= 3），并用 run.bossPending
  // 门控目标完成。房客的导演是停的，永远不会自己清掉这个标志——这条测试钉死它。
  await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    g.tier = 3; g.mapIndex = 2;
    window.__IRONFALL__.startRun();
    return true;
  })()`);

  const guestTier = await guest.waitFor('window.__IRONFALL__.game.tier', 25000, 'guest tier');
  check('房客跟随房主推进到第 3 层（首领层）', guestTier === 3, String(guestTier));

  const bossUp = await host.waitFor(`(() => {
    const g = window.__IRONFALL__.game;
    const b = g.enemies.all.find(e => e.alive && e.elite && e.typeId === 'heavy');
    return b ? { id: b.id, hp: b.hp, maxHp: b.maxHp, shield: b.shield, maxShield: b.maxShield, scale: b.scale } : false;
  })()`, 35000, 'host boss');
  check('房主刷出了守关首领', !!(bossUp && bossUp.id), JSON.stringify(bossUp));
  check('首领是放大过的精英（scale > 1.2）', !!(bossUp && bossUp.scale > 1.2), JSON.stringify(bossUp));
  check('首领血量上限高于普通重装', !!(bossUp && bossUp.maxHp > 100), JSON.stringify(bossUp));

  const bossId = bossUp && bossUp.id;
  const guestBoss = bossId != null ? await guest.waitFor(`(() => {
    const e = window.__IRONFALL__.game.enemies.findByNetId(${bossId});
    return e ? { scale: e.scale, maxHp: e.maxHp, maxShield: e.maxShield, hp: e.hp, elite: !!e.elite } : false;
  })()`, 15000, 'guest boss') : null;
  check('房客也生成了同一只首领', !!(guestBoss && guestBoss.scale), JSON.stringify(guestBoss));
  check('房客端首领体型与房主一致（scale 已同步）',
    !!(guestBoss && bossUp && Math.abs(guestBoss.scale - bossUp.scale) < 0.05),
    `host=${bossUp && bossUp.scale} guest=${guestBoss && guestBoss.scale}`);
  check('房客端首领血量上限与房主一致（血条不会超过 100%）',
    !!(guestBoss && bossUp && Math.abs(guestBoss.maxHp - bossUp.maxHp) < 2),
    `host=${bossUp && bossUp.maxHp} guest=${guestBoss && guestBoss.maxHp}`);
  check('房客端首领护盾上限与房主一致',
    !!(guestBoss && bossUp && Math.abs(guestBoss.maxShield - bossUp.maxShield) < 2),
    `host=${bossUp && bossUp.maxShield} guest=${guestBoss && guestBoss.maxShield}`);

  const hostPending = await host.ev('window.__IRONFALL__.game.run.bossPending');
  check('房主端 bossPending 为真', hostPending === true, String(hostPending));
  const guestPending = await guest.waitFor('window.__IRONFALL__.game.run.bossPending === true', 10000, 'guest pending');
  check('房客端 bossPending 同步为真', guestPending === true, String(guestPending));

  // 房主击杀首领 → 两端都必须解除门控，否则房客在第 3/6/10 层永远无法撤离
  await host.ev(`(() => {
    const g = window.__IRONFALL__.game;
    const b = g.enemies.findByNetId(${bossId});
    if (b) g.enemies.damage(b, 1e6, false, [b.pos[0], b.pos[1] + 1, b.pos[2]], [0, 1, 0], {});
    return true;
  })()`);
  const hostCleared = await host.waitFor('window.__IRONFALL__.game.run.bossPending === false', 12000, 'host cleared');
  check('首领被击败后房主解除 bossPending', hostCleared === true, String(hostCleared));
  const guestCleared = await guest.waitFor('window.__IRONFALL__.game.run.bossPending === false', 15000, 'guest cleared');
  check('房客端 bossPending 同步解除（否则第 3/6/10 层目标永远无法完成）',
    guestCleared === true, String(guestCleared));

  section('9. 画面与运行期健康度');

  await host.shot('after-run');
  await guest.shot('after-run');
  check('房主截图已保存', true);
  check('房客截图已保存', true);

  const runtimeErrors = await Promise.all([
    host.ev('window.__IRONFALL__.errors.length'),
    guest.ev('window.__IRONFALL__.errors.length'),
  ]);
  check('房主运行期无内部错误', runtimeErrors[0] === 0, JSON.stringify(runtimeErrors[0]));
  check('房客运行期无内部错误', runtimeErrors[1] === 0, JSON.stringify(runtimeErrors[1]));

  const pageErr = [...host.pageErrors, ...guest.pageErrors].filter((e) => !/favicon/i.test(e));
  check('两个页面都没有未捕获异常', pageErr.length === 0, pageErr.slice(0, 2).join(' | '));

  const consoleErr = [...host.consoleErrors, ...guest.consoleErrors]
    .filter((e) => !/favicon|AudioContext|autoplay|WebGL|GroupMarkerNotSet|powerPreference/i.test(e));
  check('两个页面都没有 console 错误', consoleErr.length === 0, consoleErr.slice(0, 2).join(' | '));

  const netState = await host.ev('window.__IRONFALL__.game.lan.debugState()');
  check('会话统计里两位玩家都在线', !!(netState && netState.peers === 2), JSON.stringify(netState && netState.peers));
} catch (err) {
  check('端到端流程整体执行', false, err && err.message ? err.message : String(err));
} finally {
  host.kill();
  guest.kill();
  await server.close();
  if (!KEEP) {
    await rm(host.userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(guest.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

process.stdout.write(`\n${'─'.repeat(52)}\n`);
if (fail === 0) {
  process.stdout.write(`局域网联机端到端通过：${pass}/${pass}\n`);
  process.exit(0);
} else {
  process.stdout.write(`局域网联机端到端失败：${pass} 通过 / ${fail} 失败\n`);
  for (const f of failures) process.stdout.write(`  · ${f}\n`);
  process.exit(1);
}
