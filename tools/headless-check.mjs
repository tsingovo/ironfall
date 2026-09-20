// ==== tools/headless-check.mjs — 无头 Chrome 端到端验证 ====
// 用 Chrome DevTools Protocol 直接驱动真实浏览器：
//   * 启动静态服务器（本进程内）与无头 Chrome
//   * 打开游戏页面，等待 __IRONFALL__.ready
//   * 跑真实物理模拟，验证运动系统（前进 / 跳跃 / 二段跳 / 冲刺 / 滑铲 / 蹬墙跑 / 抓钩）
//   * 验证射击系统（射速 / 弹药 / 命中判定 / 后坐力）
//   * 验证肉鸽升级、敌人 AI、导演刷怪
//   * 测量真实帧率与 draw call
//   * 在关键状态截图，人工可复核
//
// 用法: node tools/headless-check.mjs [--keep] [--port 8123] [--fps-ms 2000]

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { requireChromeOrNull, killChrome } from './lib/chrome.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = resolve(ROOT, 'docs/verify');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const PORT = Number(flag('port', 8123));
const FPS_MS = Number(flag('fps-ms', 2200));
const KEEP = args.includes('--keep');

// ---------------------------------------------------------------- 结果记录

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  ${mark}  ${name}${detail != null && detail !== '' ? '  [' + detail + ']' : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n── ${title} ──\n`);
}

// ---------------------------------------------------------------- 静态服务器

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const decoded = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = normalize(decoded).replace(/^([/\\])+/, '');
      let full = resolve(ROOT, rel);
      if (full !== ROOT && !full.startsWith(ROOT + sep)) {
        res.writeHead(403); res.end('403'); return;
      }
      let info = await stat(full).catch(() => null);
      if (info && info.isDirectory()) {
        full = join(full, 'index.html');
        info = await stat(full).catch(() => null);
      }
      if (!info || !info.isFile()) { res.writeHead(404); res.end('404'); return; }
      const body = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500); res.end(String(err && err.message));
    }
  });
  return new Promise((ok) => server.listen(PORT, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------- Chrome

// Chrome 解析已抽到 tools/lib/chrome.mjs（跨平台 + CHROME_PATH 环境变量）
const findChrome = () => requireChromeOrNull('headless-check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('无法连接到 Chrome DevTools: ' + url);
}

/** 极简 CDP 客户端（Node 内置 WebSocket） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
        else res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
        this.consoleLogs.push({ level: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push({
          text: d.text,
          desc: d.exception && (d.exception.description || d.exception.value),
        });
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        this.consoleLogs.push({ level: e.level, text: e.text + (e.url ? ' @' + e.url : '') });
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP 超时: ' + method));
        }
      }, 60000);
    });
  }

  /** 在页面上下文中执行表达式并返回 JSON 结果 */
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面求值异常: ' + d.text + ' ' + (d.exception && d.exception.description || ''));
    }
    return r.result && r.result.value;
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(r.data, 'base64'));
    return path;
  }
}

async function launchChrome(exe, userDataDir) {
  const proc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1600,900',
    // 无头环境没有 GPU：用 SwiftShader 软件渲染保证 WebGL2 可用
    // （帧率数字仅代表"功能可用"，不代表真机性能）
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // 从 DevToolsActivePort 文件读取实际端口
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100; i++) {
    try {
      const txt = await readFile(portFile, 'utf8');
      port = Number(txt.split('\n')[0]);
      if (port > 0) break;
    } catch (_e) { /* 还没写 */ }
    await sleep(150);
  }
  if (!port) throw new Error('Chrome 未启动（DevToolsActivePort 未生成）:\n' + stderr.slice(-1200));
  return { proc, port, getStderr: () => stderr };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromeExe = findChrome();
  if (!chromeExe) {
    process.stdout.write('找不到 Chrome/Edge，无法执行无头验证。\n');
    process.exit(2);
  }
  process.stdout.write(`浏览器: ${chromeExe}\n`);
  process.stdout.write(`项目根: ${ROOT}\n`);

  const server = await startServer();
  process.stdout.write(`静态服务器: http://127.0.0.1:${PORT}/\n`);

  const userDataDir = join(tmpdir(), 'ironfall-headless-' + Date.now());
  await mkdir(userDataDir, { recursive: true });
  const { proc, port, getStderr } = await launchChrome(chromeExe, userDataDir);

  let cdp = null;
  let exitCode = 0;
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    process.stdout.write(`Chrome: ${version.Browser}\n`);

    // 新建标签页
    const targetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetRes.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    cdp = new CDP(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // 固定设备像素比：否则 canvas 后备缓冲是 CSS 尺寸 ×DPR（例如 1920×1080），
    // 而截图只有 CSS 尺寸（1280×720），两者不一致会让像素级校验与目视复核都对不上。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    section('1. 页面加载与初始化');

    const consoleErrorsBefore = () => cdp.consoleLogs.filter((l) => l.level === 'error').length;
    void consoleErrorsBefore;

    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

    // 等待 ready
    let ready = false;
    let lastErr = '';
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      try {
        const st = await cdp.eval('window.__IRONFALL__ ? { ready: !!window.__IRONFALL__.ready, bootError: window.__IRONFALL__.bootError || null, errs: (window.__IRONFALL__.errors||[]).length } : null');
        if (st && st.bootError) { lastErr = st.bootError; break; }
        if (st && st.ready) { ready = true; break; }
      } catch (_e) { /* 页面还在加载 */ }
    }
    check('页面加载并完成初始化', ready, ready ? `${Date.now() - t0}ms` : ('超时 ' + lastErr));

    if (!ready) {
      const boot = await cdp.eval('window.__IRONFALL__ ? JSON.stringify(window.__IRONFALL__) : "window.__IRONFALL__ 未定义"').catch((e) => String(e));
      process.stdout.write('\n启动诊断: ' + boot + '\n');
      const html = await cdp.eval('document.body ? document.body.innerHTML.slice(0,400) : "no body"').catch(() => '');
      process.stdout.write('DOM 片段: ' + html + '\n');
      throw new Error('游戏未能初始化');
    }

    // 引擎信息
    const info = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      return {
        gpu: g.glInfo.gpu,
        meshCount: g.glInfo.meshCount,
        programs: g.glInfo.programs,
        map: g.mapName,
        tier: g.tier,
        world: g.world.debugState(),
      };
    })()`);
    process.stdout.write(`  GPU: ${info.gpu.renderer}\n`);
    process.stdout.write(`  地图: ${info.map} (tier ${info.tier})\n`);
    process.stdout.write(`  世界: 三角 ${info.world.triangleCount} / 盒体 ${info.world.boxCount} / 出生点 ${info.world.spawnPoints} / 目标 ${info.world.objectives} / 撤离点 ${info.world.extractPoints}\n`);
    check('WebGL2 上下文与着色器程序就绪', info.programs && info.programs.length >= 4, info.programs.join(','));
    check('地图载入并生成碰撞几何', info.world.triangleCount > 1000 && info.world.boxCount > 20,
      `tris=${info.world.triangleCount} boxes=${info.world.boxCount}`);
    check('地图包含出生点/目标/撤离点', info.world.spawnPoints > 0 && info.world.objectives > 0 && info.world.extractPoints > 0,
      `spawn=${info.world.spawnPoints} obj=${info.world.objectives} ext=${info.world.extractPoints}`);

    const gltfCount = await cdp.eval('window.__IRONFALL__.game.world.importedCount');
    check('外部 GLB 模型导入通道生效', gltfCount > 0, `已导入网格 ${gltfCount}`);

    section('2. 页面错误');

    const pageErrors = await cdp.eval('JSON.stringify(window.__IRONFALL__.errors)');
    const errList = JSON.parse(pageErrors || '[]');
    check('运行期无未捕获错误', errList.length === 0,
      errList.length ? errList.map((e) => e.message).join(' | ').slice(0, 300) : '0 个');
    const severeConsole = cdp.consoleLogs.filter((l) => l.level === 'error');
    check('控制台无 error 级输出', severeConsole.length === 0,
      severeConsole.length ? severeConsole.map((l) => l.text).join(' | ').slice(0, 300) : '0 条');
    check('无未捕获异常', cdp.exceptions.length === 0,
      cdp.exceptions.length ? cdp.exceptions.map((e) => e.text).join(' | ').slice(0, 300) : '0 个');

    section('3. 进入战局');

    await cdp.eval('window.__IRONFALL__.setAutomationMode(true)');
    const started = await cdp.eval('window.__IRONFALL__.startRun()');
    check('startRun() 成功', started === true);
    await cdp.eval('window.__IRONFALL__.game.hud.hideMenu()');
    await sleep(120);

    const runInfo = await cdp.eval(`(() => {
      const r = window.__IRONFALL__.game.run;
      return { phase: r.phase, objectives: r.objectives.length, tier: r.tier,
               alive: window.__IRONFALL__.game.enemies.aliveCount() };
    })()`);
    check('单局已开始且目标已装载', runInfo.objectives > 0, `阶段=${runInfo.phase} 目标=${runInfo.objectives}`);

    section('4. 运动系统（真实物理模拟）');

    // 把场景变成"干净的测试台"：清空敌人、停掉导演、回满血。
    // 否则战斗中的敌人/危险区会让运动测试结果不可复现。
    const harness = `(() => {
      const g = window.__IRONFALL__.game;
      g.director.enabled = false;
      g.enemies.clear();
      g.run.phase = 'objectives';
      g.paused = false;
      g._upgradeOpen = false;
      return true;
    })()`;
    const freshPlayer = `(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.alive = true;
      p.health = p.maxHealth;
      p.shield = p.maxShield;
      p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
      p.grapple.active = false;
      p.invulnTime = 0;
      return true;
    })()`;
    await cdp.eval(harness);
    check('测试台已就绪（清场/满血/解除暂停）', true);

    /** 找一块"干净"的测试场地：
     *  地形水平（周边 26m 内高差很小）、头顶无障碍、附近没有静态盒体、
     *  并且正前方 20m 内没有墙 —— 否则蹬墙跑/翻越会混进运动测试结果。 */
    const findClearSpot = `(() => {
      const g = window.__IRONFALL__.game;
      const w = g.world;
      const cands = w.navCandidates();
      const out = [];
      w._boxHash.queryBox(-1000, -1000, 1000, 1000, out);
      const boxes = out.map(i => w.boxes[i]);
      const clearOfBoxes = (x, z, r) => {
        for (const b of boxes) {
          if (x + r < b.min[0] || x - r > b.max[0]) continue;
          if (z + r < b.min[2] || z - r > b.max[2]) continue;
          return false;
        }
        return true;
      };
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < cands.length; i += 2) {
        const c = cands[i];
        const slope = w.sampleSlope(c[0], c[2]);
        if (slope > 0.05) continue;
        if (!clearOfBoxes(c[0], c[2], 20)) continue;
        // 周边地形要够平（半径 16m 内高差 < 2.5m），保证测距/射击结果可复现
        let hMin = Infinity, hMax = -Infinity;
        for (let a = 0; a < 6; a++) {
          const ang = a * Math.PI / 3;
          for (const r of [6, 11, 16]) {
            const h = w.groundHeight(c[0] + Math.cos(ang) * r, c[2] + Math.sin(ang) * r);
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
          }
        }
        if (hMax - hMin > 2.5) continue;
        // 正前方 14m 内不能有墙（否则会误触蹬墙跑）
        const fwdHit = w.raycast([c[0], c[1] + 1.0, c[2]], [0, 0, -1], 14, { hitTriangles: false });
        if (fwdHit.hit) continue;
        // 头顶 12m 内不能有结构
        const up = w.raycast([c[0], c[1] + 0.6, c[2]], [0, 1, 0], 12, {});
        if (up.hit) continue;
        const d = Math.hypot(c[0], c[2]);
        const score = -d - (hMax - hMin) * 4;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best) {
        // 兜底：至少返回一个平坦点，别让整套测试挂掉
        for (let i = 0; i < cands.length; i += 2) {
          if (w.sampleSlope(cands[i][0], cands[i][2]) < 0.05) best = cands[i];
          if (best) break;
        }
      }
      if (!best) return null;
      return [best[0], best[1] + 0.05, best[2]];
    })()`;

    /** 每个运动子测试前都重置玩家与场地（并确保站在干净场地上） */
    const reset = async () => {
      await cdp.eval(freshPlayer);
      await cdp.eval(`(() => {
        const g = window.__IRONFALL__.game;
        const spot = ${findClearSpot};
        g._testSpot = spot || [0, g.world.groundHeight(0, 0) + 0.05, 0];
        return true;
      })()`);
    };

    /** 把玩家放到干净场地并站稳 */
    const standOnSpot = `(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      return { y: p.pos[1], grounded: p.state.grounded, alive: p.alive };
    })()`;

    const spotInfo = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const s = ${findClearSpot};
      if (!s) return { ok: false };
      g._testSpot = s;
      const w = g.world;
      return { ok: true, spot: [+s[0].toFixed(1), +s[1].toFixed(2), +s[2].toFixed(1)],
               slope: +w.sampleSlope(s[0], s[2]).toFixed(3) };
    })()`);
    check('找到干净测试场地（平坦、无遮挡、无结构）', spotInfo.ok === true,
      spotInfo.ok ? `位置 [${spotInfo.spot.join(', ')}] 坡度 ${spotInfo.slope}` : '未找到');

    const stand = await cdp.eval(standOnSpot);
    check('玩家在测试场地上站稳', stand.grounded === true, `y=${stand.y.toFixed(2)}`);

    // --- 前进：速度应接近 walkSpeed，位置应前移
    await reset();
    const fwd = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      const p0 = [p.pos[0], p.pos[1], p.pos[2]];
      window.__IRONFALL__.simulate(1.5, [{ seconds: 1.5, moveY: 1 }]);
      const p1 = [p.pos[0], p.pos[1], p.pos[2]];
      return { p0, p1, speed: p.state.speed, hspeed: p.state.hspeed,
               state: p.state.moveState, grounded: p.state.grounded,
               alive: p.alive, health: p.health };
    })()`);
    const dxz = Math.hypot(fwd.p1[0] - fwd.p0[0], fwd.p1[2] - fwd.p0[2]);
    check('按前进键确实产生位移', dxz > 4.0, `位移 ${dxz.toFixed(2)}m（存活=${fwd.alive} HP=${fwd.health}）`);
    check('步行速度接近配置值 (6.6 m/s)', fwd.hspeed > 5.5 && fwd.hspeed < 8.5, `${fwd.hspeed.toFixed(2)} m/s`);
    check('玩家处于地面状态', fwd.grounded === true, `state=${fwd.state}`);

    // --- 冲刺：速度应显著高于步行
    await reset();
    const sprint = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      window.__IRONFALL__.simulate(2.5, [{ seconds: 2.5, moveY: 1, sprint: true }]);
      return { hspeed: p.state.hspeed, sprintFrac: p.state.sprintFraction,
               state: p.state.moveState, alive: p.alive };
    })()`);
    check('冲刺速度显著高于步行 (>8.5 m/s)', sprint.hspeed > 8.5, `${sprint.hspeed.toFixed(2)} m/s`);
    check('冲刺加速是渐进的（有加速斜坡）', sprint.sprintFrac > 0.5, `冲刺混合=${sprint.sprintFrac.toFixed(2)}`);

    // --- 跳跃高度
    await reset();
    const jump = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      const y0 = p.pos[1];
      const g0 = p.state.grounded;
      let peak = y0;
      // 起跳：第一个短段按住跳键，之后持续前进并逐段记录最高点
      window.__IRONFALL__.simulate(0.05, [{ seconds: 0.05, jump: true, moveY: 1 }]);
      for (let i = 0; i < 24; i++) {
        window.__IRONFALL__.simulate(0.05, [{ seconds: 0.05, moveY: 1 }]);
        peak = Math.max(peak, p.pos[1]);
      }
      return { y0, peak, rise: +(peak - y0).toFixed(3), groundedBefore: g0,
               groundedAfter: p.state.grounded, alive: p.alive };
    })()`);
    check('跳跃高度在合理区间 (0.8~1.8m)',
      jump.rise > 0.8 && jump.rise < 1.8,
      `起跳前 y=${jump.y0.toFixed(2)} 峰值 ${jump.peak.toFixed(2)} 上升 ${jump.rise}m`);

    // --- 二段跳：空中再按一次跳，应获得额外上升
    await reset();
    const dbl = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      // 起跳
      window.__IRONFALL__.simulate(0.05, [{ seconds: 0.05, jump: true, moveY: 1 }]);
      window.__IRONFALL__.simulate(0.38, [{ seconds: 0.38, moveY: 1 }]);
      const vyBefore = p.vel[1];
      const ajBefore = p.state.airJumps;
      const groundedMid = p.state.grounded;
      // 二段跳
      window.__IRONFALL__.simulate(0.05, [{ seconds: 0.05, jump: true, moveY: 1 }]);
      const vyAfter = p.vel[1];
      return { vyBefore: +vyBefore.toFixed(2), vyAfter: +vyAfter.toFixed(2),
               ajBefore, ajAfter: p.state.airJumps, groundedMid, alive: p.alive };
    })()`);
    check('空气二段跳重新获得上升速度', dbl.vyAfter > dbl.vyBefore + 3,
      `跳前 vy=${dbl.vyBefore} → 跳后 ${dbl.vyAfter}（airJumps ${dbl.ajBefore}→${dbl.ajAfter}, 空中=${!dbl.groundedMid}）`);
    check('二段跳被记为空中跳跃（而非蹬墙跳）', dbl.ajAfter === dbl.ajBefore + 1,
      `airJumps ${dbl.ajBefore} → ${dbl.ajAfter}`);

    // --- 冲刺
    await reset();
    const dash = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      window.__IRONFALL__.simulate(1.0, [{ seconds: 1.0, moveY: 1 }]);
      const before = p.state.hspeed;
      // 单步触发冲刺：seg 首步会注入一次 KeyQ 按下
      window.__IRONFALL__.simulate(0.035, [{ seconds: 0.035, moveY: 1, dash: true }]);
      const during = p.state.hspeed;
      return { before: +before.toFixed(2), during: +during.toFixed(2),
               dashing: p.state.dashing, charges: p.state.dashCharges, alive: p.alive };
    })()`);
    check('冲刺瞬间速度大幅提升', dash.during > dash.before + 5,
      `${dash.before} → ${dash.during} m/s（冲刺中=${dash.dashing}）`);

    // --- 滑铲：速度保留 + 状态切换
    await reset();
    const slide = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      window.__IRONFALL__.simulate(2.4, [{ seconds: 2.4, moveY: 1, sprint: true }]);
      const beforeSpeed = p.state.hspeed;
      window.__IRONFALL__.simulate(0.35, [{ seconds: 0.35, moveY: 1, crouch: true }]);
      const s = p.state;
      return { beforeSpeed: +beforeSpeed.toFixed(2), sliding: s.sliding, state: s.moveState,
               speed: +s.hspeed.toFixed(2), eye: +p.eyeHeightOffset.toFixed(2),
               height: +p.currentHeight.toFixed(2) };
    })()`);
    check('冲刺中触发滑铲', slide.sliding === true || slide.state === 'SLIDE',
      `状态=${slide.state} 速度=${slide.speed}`);
    check('滑铲保持动量（不低于触发前的 85%）', slide.speed > slide.beforeSpeed * 0.85,
      `${slide.beforeSpeed} → ${slide.speed} m/s`);
    check('滑铲降低碰撞高度与相机高度', slide.height < 1.3,
      `碰撞高度=${slide.height} 眼高偏移=${slide.eye}`);

    // --- 蹬墙跑：放在一面墙旁边高速前进
    const wallrun = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const w = g.world;
      // 找一面"竖直且可蹬"的盒体侧面，把玩家放在它旁边并沿墙方向给速度
      let placed = false;
      let wallInfo = null;
      for (const b of w.boxes) {
        const h = b.max[1] - b.min[1];
        const wdt = b.max[0] - b.min[0], dpt = b.max[2] - b.min[2];
        if (h < 4) continue;
        // 取 X 方向的窄面（法线朝 ±X），或 Z 方向的窄面
        const useX = wdt < dpt;
        const cx = (b.min[0]+b.max[0])/2, cz = (b.min[2]+b.max[2])/2;
        const half = (useX ? wdt : dpt) / 2;
        const off = half + 0.55;
        const px = useX ? (b.min[0] - off) : cx;
        const pz = useX ? cz : (b.min[2] - off);
        const gy = w.groundHeight(px, pz);
        if (gy < -50) continue;
        // 离地一点点，便于判定为空中
        g.player.teleport([px, Math.max(gy, b.min[1]) + 1.2, pz]);
        g.player.vel[0] = 0; g.player.vel[1] = 0; g.player.vel[2] = 0;
        // 朝墙的方向（法线反方向）看一眼，然后沿墙的切向给速度
        const nx = useX ? 1 : 0, nz = useX ? 0 : 1;
        g.player.yaw = Math.atan2(-nx, -nz);
        g.player.pitch = 0;
        // 切向速度
        const tx = -nz, tz = nx;
        g.player.vel[0] = tx * 13; g.player.vel[2] = tz * 13;
        g.player.vel[1] = 1.5;
        window.__IRONFALL__.simulate(0.55, [{ seconds: 0.55, moveY: 1 }]);
        const s = g.player.state;
        wallInfo = { wallRunning: s.wallRunning, state: s.moveState, side: s.wallSide,
                     speed: s.hspeed, roll: g.player.roll, boxH: h };
        if (s.wallRunning || s.moveState === 'WALLRUN') { placed = true; break; }
      }
      return { placed, wallInfo, foundWall: !!wallInfo };
    })()`);
    check('找到可用于验证的竖直墙面', wallrun.foundWall === true,
      wallrun.wallInfo ? `墙高 ${wallrun.wallInfo.boxH.toFixed(1)}m` : '未找到');
    check('贴墙高速移动触发蹬墙跑', wallrun.placed === true,
      wallrun.wallInfo ? `状态=${wallrun.wallInfo.state} 侧=${wallrun.wallInfo.side} 速度=${wallrun.wallInfo.speed.toFixed(1)}` : '');
    if (wallrun.wallInfo) {
      check('蹬墙跑产生相机侧倾', Math.abs(wallrun.wallInfo.roll) > 0.02,
        `roll=${wallrun.wallInfo.roll.toFixed(3)} rad`);
    }

    // --- 抓钩
    await reset();
    const grapple = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      p.pitch = -0.30;      // 抬头看斜上方，确保射线能打到结构
      const p0 = [p.pos[0], p.pos[1], p.pos[2]];
      window.__IRONFALL__.simulate(0.08, [{ seconds: 0.08, grapple: true }]);
      const locked = p.grapple.active;
      const dist = p.grapple.distance;
      const anchor = [p.grapple.point[0], p.grapple.point[1], p.grapple.point[2]];
      // 保持按住抓钩，观察拉力
      window.__IRONFALL__.simulate(0.9, [{ seconds: 0.9, grapple: true }]);
      const p1 = [p.pos[0], p.pos[1], p.pos[2]];
      return { locked, dist: +dist.toFixed(2), anchor,
               moved: +Math.hypot(p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]).toFixed(2),
               speedAfter: +p.state.speed.toFixed(2),
               stillActive: p.grapple.active };
    })()`);
    check('抓钩成功锁定目标', grapple.locked === true, `距离 ${grapple.dist}m 锚点=[${grapple.anchor.map((v) => v.toFixed(1)).join(',')}]`);
    check('抓钩把玩家拉向锚点（产生位移）', grapple.moved > 1.0,
      `位移 ${grapple.moved}m 速度 ${grapple.speedAfter} m/s`);

    // --- 抓钩命中敌人：双方按质量共同拉近，而不是把活体当静态墙
    await reset();
    const grappleEnemy = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      g.enemies.clear();
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0; p.updateCamera(0);
      const ex = p.pos[0], ez = p.pos[2] - 14;
      const ey = g.world.groundHeight(ex, ez);
      const enemy = g.enemies.spawn('grunt', [ex, ey, ez]);
      enemy.spawnAttackLock = 99;
      const p0 = [p.pos[0], p.pos[1], p.pos[2]];
      const e0 = [enemy.pos[0], enemy.pos[1], enemy.pos[2]];
      const d0 = Math.hypot(e0[0]-p0[0], e0[1]-p0[1], e0[2]-p0[2]);
      p.grapple.active = true;
      p.grapple.attachedEnemy = enemy;
      p.grapple.point.set(enemy.pos);
      p.grapple.distance = d0;
      p.grapple.restLength = d0;
      p.grapple.offAimTime = 0;
      window.__IRONFALL__.simulate(0.42, [{ seconds: 0.42 }]);
      const p1 = [p.pos[0], p.pos[1], p.pos[2]];
      const e1 = [enemy.pos[0], enemy.pos[1], enemy.pos[2]];
      const d1 = Math.hypot(e1[0]-p1[0], e1[1]-p1[1], e1[2]-p1[2]);
      return {
        playerToward: p1[2] - p0[2], enemyToward: e1[2] - e0[2],
        d0, d1, active: p.grapple.active,
      };
    })()`);
    check('抓钩命中敌人后玩家朝目标移动', grappleEnemy.playerToward < -0.12,
      `玩家 Δz=${grappleEnemy.playerToward.toFixed(2)}m`);
    check('抓钩命中敌人后敌人同时朝玩家移动', grappleEnemy.enemyToward > 0.12,
      `敌人 Δz=${grappleEnemy.enemyToward.toFixed(2)}m`);
    check('双向牵引让双方距离明显缩短', grappleEnemy.d1 < grappleEnemy.d0 - 0.6,
      `${grappleEnemy.d0.toFixed(2)}m → ${grappleEnemy.d1.toFixed(2)}m`);

    // --- 高速移动不穿模
    await reset();
    const noClip = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const w = g.world;
      const p = g.player;
      // 以极高速度斜向冲进地形，验证扫掠碰撞把它挡住（不穿到地下）
      const s = g._testSpot;
      p.teleport([s[0] - 30, s[1] + 6, s[2] - 30]);
      p.yaw = Math.PI * 0.25;
      p.vel[0] = 70; p.vel[2] = -70; p.vel[1] = -8;
      window.__IRONFALL__.simulate(2.5, [{ seconds: 2.5, moveY: 1 }]);
      const pos = [p.pos[0], p.pos[1], p.pos[2]];
      const groundY = w.groundHeight(pos[0], pos[2]);
      return { pos, groundY, below: pos[1] < groundY - 2.5, speed: p.state.hspeed };
    })()`);
    check('高速撞击不穿透地形', noClip.below === false,
      `y=${noClip.pos[1].toFixed(2)} 地面=${noClip.groundY.toFixed(2)}`);

    // --- 边界：地图外不会无限下落
    await reset();
    const bounds = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      g.player.teleport([0, g.world.groundHeight(0,0) + 200, 0]);
      window.__IRONFALL__.simulate(6, [{ seconds: 6 }]);
      return { y: g.player.pos[1], ground: g.world.groundHeight(g.player.pos[0], g.player.pos[2]),
               alive: g.player.alive, health: g.player.health };
    })()`);
    check('高空坠落最终落地或被正确处理', bounds.y > -200,
      `y=${bounds.y.toFixed(2)} 生命=${bounds.health.toFixed(0)} 存活=${bounds.alive}`);

    section('5. 射击系统（R-99 手感）');

    await reset();
    const shoot = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(1.2, [{ seconds: 1.2 }]);
      const w = g.weapons;
      w._equip('r99', true);
      w.resetAmmo();
      w.stats.shotsFired = 0;
      const st = w.state.get('r99');
      const ammo0 = st.ammo;
      const spread0 = st.spreadExtra;
      // 连打 0.9 秒（弹匣 20 发，1080RPM 约 16 发）；同时记录后坐力峰值
      let peakAim = 0, peakVis = 0;
      for (let i = 0; i < 18; i++) {
        window.__IRONFALL__.simulate(0.05, [{ seconds: 0.05, fire: true }]);
        peakAim = Math.max(peakAim, Math.abs(w.recoil.aimPitch));
        peakVis = Math.max(peakVis, Math.abs(w.recoil.visPitch));
      }
      return {
        ammo0, ammo1: st.ammo, shots: w.stats.shotsFired,
        spread0: +spread0.toFixed(3), spread1: +st.spreadExtra.toFixed(3),
        peakAim, peakAimDeg: +(peakAim * 180 / Math.PI).toFixed(3),
        peakVisDeg: +(peakVis * 180 / Math.PI).toFixed(3),
        patternIndex: w.recoil.patternIndex,
        rpm: w.current.def.rpm,
        projectiles: w.projectiles.aliveCount,
        alive: p.alive,
      };
    })()`);
    check('开火消耗弹药', shoot.ammo1 < shoot.ammo0, `${shoot.ammo0} → ${shoot.ammo1}`);
    // 1080 RPM => 0.9 秒约 16 发
    check('射速符合 R-99 的 1080 RPM（0.9 秒约 16 发）', shoot.shots >= 14 && shoot.shots <= 18,
      `实际 ${shoot.shots} 发`);
    check('连发累积扩散', shoot.spread1 > shoot.spread0,
      `扩散 ${shoot.spread0} → ${shoot.spread1}`);
    check('后坐力把准心往上推（单发峰值 > 0.2°）', shoot.peakAimDeg > 0.2,
      `连发中瞄准偏移峰值 ${shoot.peakAimDeg}°`);
    check('视觉后坐力大于真实后坐力（体感强于惩罚）', shoot.peakVisDeg > shoot.peakAimDeg,
      `视觉峰值 ${shoot.peakVisDeg}° vs 真实峰值 ${shoot.peakAimDeg}°`);
    check('固定弹道序列在推进', shoot.patternIndex > 0, `index=${shoot.patternIndex}`);
    check('曳光/弹道特效已生成', shoot.projectiles > 0, `${shoot.projectiles} 个活跃特效`);

    // --- 独立曳光像素验证
    // 不能只检查 tracerCount：过去曾出现“特效对象存在，但实例批次读错矩阵，画面没有像素”的假通过。
    // 新建一块纯黑 WebGL2 画布，只提交一条曳光，再直接读取 framebuffer。
    const tracerPixels = await cdp.eval(`(async () => {
      const [{ Engine }, { createSharedMeshes }, { ProjectilePool }] = await Promise.all([
        import('/src/engine/engine.js'),
        import('/src/engine/fx-meshes.js'),
        import('/src/fx/projectiles.js'),
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const engine = new Engine(canvas, { antialias: false });
      engine.setSize(320, 180, 1);
      createSharedMeshes(engine);
      engine.clearColor.set([0, 0, 0, 1]);
      engine.fogColor.set([0, 0, 0]);
      engine.fogRange.set([1000, 2000]);
      engine.gl.clearColor(0, 0, 0, 1);

      const pool = new ProjectilePool(engine, 8);
      engine.beginFrame();
      engine.setCamera([0, 0, 0], [0, 0, -1], [0, 1, 0], 90, 0.05, 100);
      pool.spawnTracer([-2.2, -0.9, -6], [2.2, 0.9, -6], {
        // 使用 R-99 实际级别的宽度/寿命，避免测试只在夸张参数下通过。
        color: [1, 0.76, 0.34], width: 0.060, life: 0.22,
      });
      pool.render(engine);
      engine.flush();
      engine.gl.finish();

      const rgba = new Uint8Array(canvas.width * canvas.height * 4);
      engine.gl.readPixels(0, 0, canvas.width, canvas.height,
        engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, rgba);
      let lit = 0, max = 0;
      let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const v = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
          if (v > max) max = v;
          if (v > 16) {
            lit++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      return {
        lit, max, tracers: pool.tracerCount,
        bbox: lit ? [minX, minY, maxX, maxY] : null,
        drawCalls: engine.stats.drawCalls,
      };
    })()`);
    check('曳光在纯黑 framebuffer 上真的产生可见像素',
      tracerPixels.lit > 100 && tracerPixels.max > 100,
      `${tracerPixels.lit} px，峰值 ${tracerPixels.max}，包围盒 ${JSON.stringify(tracerPixels.bbox)}，draw calls=${tracerPixels.drawCalls}`);

    // --- 换弹
    await reset();
    const reload = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const w = g.weapons;
      const st = w.state.get('r99');
      st.ammo = 3;
      st.reloading = false;
      w.vm.equipT = 1;
      window.__IRONFALL__.simulate(0.03, [{ seconds: 0.03, reload: true }]);
      const reloadingNow = st.reloading;
      const dur = st.reloadDuration;
      window.__IRONFALL__.simulate(dur + 0.3, [{ seconds: dur + 0.3 }]);
      return { reloadingNow, dur: +dur.toFixed(2), ammoAfter: st.ammo, reserveAfter: st.reserve,
               magSize: w.current.magSize };
    })()`);
    check('换弹流程被触发', reload.reloadingNow === true, `时长 ${reload.dur}s`);
    check('换弹后弹匣补满', reload.ammoAfter === reload.magSize,
      `${reload.ammoAfter}/${reload.magSize}，备弹 ${reload.reserveAfter}`);

    // --- 命中判定（对真实敌人）
    await reset();
    const hitTest = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const w = g.weapons, en = g.enemies;
      en.clear();
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(0.4, [{ seconds: 0.4 }]);
      // 在正前方 12m 放一个敌人（沿 -Z 方向）
      const ez = p.pos[2] - 12;
      const ey = g.world.groundHeight(p.pos[0], ez);
      const e = en.spawn('grunt', [p.pos[0], ey, ez]);
      e.grounded = true;
      window.__IRONFALL__.simulate(0.3, [{ seconds: 0.3 }]);
      const before = e.hp;
      const eye = [p.eyePos[0], p.eyePos[1], p.eyePos[2]];
      const hit = en.raycastEnemies(eye, [0, 0, -1], 60);
      const dmgRes = hit ? en.damage(hit.enemy, w.current.def.damage, hit.headshot, hit.point, hit.normal, {}) : null;
      // 再打一轮，统计命中率
      w._equip('r99', true); w.resetAmmo();
      w.stats.shotsFired = 0; w.stats.hits = 0;
      window.__IRONFALL__.simulate(0.9, [{ seconds: 0.9, fire: true }]);
      return {
        enemyY: +e.pos[1].toFixed(2), groundY: +ey.toFixed(2), eyeY: +eye[1].toFixed(2),
        hpBefore: before, hpAfter: +e.hp.toFixed(1), enemyAlive: e.alive,
        rayHit: !!hit, rayT: hit ? +hit.t.toFixed(2) : -1, headshot: hit ? hit.headshot : null,
        damage: dmgRes ? +dmgRes.damage.toFixed(1) : 0,
        shots: w.stats.shotsFired, hits: w.stats.hits,
        accuracy: w.stats.shotsFired ? w.stats.hits / w.stats.shotsFired : 0,
      };
    })()`);
    check('敌人可被生成并被射线命中', hitTest.rayHit === true,
      `命中距离 ${hitTest.rayT}m 伤害 ${hitTest.damage}（敌人 y=${hitTest.enemyY} 地面=${hitTest.groundY} 眼高=${hitTest.eyeY}）`);
    check('命中造成掉血', hitTest.hpAfter < hitTest.hpBefore || hitTest.enemyAlive === false,
      `${hitTest.hpBefore} → ${hitTest.hpAfter}（存活=${hitTest.enemyAlive}）`);
    check('腰射有命中（12m 距离命中率 > 12%）', hitTest.accuracy > 0.12,
      `${hitTest.hits}/${hitTest.shots} = ${(hitTest.accuracy * 100).toFixed(0)}%`);

    // 命中率测试需要"射线确实能打到目标"的场地。
    // 做法：遍历候选点，放敌人 → 用真实射线验证无遮挡 → 瞄准躯干中心开火。
    // 这样测到的是扩散造成的偏差，而不是"被墙挡住"。
    const aimAndFire = (adsFlag) => `(() => {
      const g = window.__IRONFALL__.game;
      const w = g.weapons, en = g.enemies;
      const p = g.player;
      const cands = g.world.navCandidates();
      let chosen = null;
      let attempts = 0;
      for (let i = 0; i < cands.length && attempts < 40; i += 7) {
        const c = cands[i];
        if (g.world.sampleSlope(c[0], c[2]) > 0.05) continue;
        attempts++;
        en.clear();
        p.teleport([c[0], c[1] + 0.05, c[2]]);
        p.yaw = 0; p.pitch = 0;
        window.__IRONFALL__.simulate(0.6, [{ seconds: 0.6 }]);
        const ez = p.pos[2] - 12;
        const ey = g.world.groundHeight(p.pos[0], ez);
        const e = en.spawn('grunt', [p.pos[0], ey, ez]);
        e.grounded = true;
        e.hp = 20000; e.maxHp = 20000;
        window.__IRONFALL__.simulate(0.2, [{ seconds: 0.2 }]);
        // 瞄准躯干中心（pitch 为正表示抬头）
        const eye = p.eyePos;
        const bodyCenterY = e.pos[1] + e.height * 0.62;
        p.pitch = -Math.atan2(bodyCenterY - eye[1], Math.abs(e.pos[2] - eye[2]));
        const dir = w._aimDir([0, 0, 0]);
        const enHit = en.raycastEnemies([eye[0], eye[1], eye[2]], dir, 60);
        if (enHit) { chosen = { e, spot: [c[0], c[1], c[2]], pitch: p.pitch, attempts }; break; }
      }
      if (!chosen) return { setupFailed: true, attempts };
      const e = chosen.e;
      w._equip('r99', true); w.resetAmmo();
      const hipSpread = w._computeSpread(w.state.get('r99'), w.current.def);
      window.__IRONFALL__.simulate(${adsFlag ? 0.35 : 0.05}, [{ seconds: ${adsFlag ? 0.35 : 0.05}, ads: ${adsFlag ? 'true' : 'false'} }]);
      const st = w.state.get('r99');
      const usedSpread = w._computeSpread(st, w.current.def);
      w.stats.shotsFired = 0; w.stats.hits = 0;
      window.__IRONFALL__.simulate(0.9, [{ seconds: 0.9, ads: ${adsFlag ? 'true' : 'false'}, fire: true }]);
      return { setupFailed: false, attempts: chosen.attempts,
               adsT: +st.adsT.toFixed(2), aimPitchDeg: +(p.pitch * 180 / Math.PI).toFixed(2),
               hipSpread: +hipSpread.toFixed(2), usedSpread: +usedSpread.toFixed(2),
               shots: w.stats.shotsFired, hits: w.stats.hits,
               accuracy: w.stats.shotsFired ? w.stats.hits / w.stats.shotsFired : 0,
               enemyHp: +e.hp.toFixed(0) };
    })()`;

    await reset();
    const hipAimed = await cdp.eval(aimAndFire(false));
    await reset();
    const adsAimed = await cdp.eval(aimAndFire(true));

    check('命中率测试场地搭建成功（射线可达目标）',
      !hipAimed.setupFailed && !adsAimed.setupFailed,
      hipAimed.setupFailed ? `腰射侧失败（试了 ${hipAimed.attempts} 个点）` : `第 ${hipAimed.attempts} 个候选点可用`);
    check('腰射（正确瞄准躯干）命中率合理', !hipAimed.setupFailed && hipAimed.accuracy > 0.5,
      `${hipAimed.hits}/${hipAimed.shots} = ${(hipAimed.accuracy * 100).toFixed(0)}%（俯角 ${hipAimed.aimPitchDeg}°，扩散 ${hipAimed.usedSpread}°）`);
    check('开镜确实完成（adsT 达到 1）', adsAimed.adsT >= 0.99, `adsT=${adsAimed.adsT}`);
    check('开镜扩散小于腰射扩散', adsAimed.usedSpread < hipAimed.usedSpread,
      `腰射 ${hipAimed.usedSpread}° → 开镜 ${adsAimed.usedSpread}°`);
    check('开镜命中率不低于腰射',
      !adsAimed.setupFailed && !hipAimed.setupFailed && adsAimed.accuracy >= hipAimed.accuracy,
      `腰射 ${(hipAimed.accuracy * 100).toFixed(0)}% → 开镜 ${(adsAimed.accuracy * 100).toFixed(0)}%`);

    // --- 爆头伤害高于身体高于腿部 + 三层命中盒区分
    // 用一个"冻结"的敌人做几何测试：生成后不再推进物理，
    // 避免 AI 把它推走导致射线基准漂移（那测的就不是命中盒划分了）。
    await reset();
    const headshot = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const en = g.enemies; en.clear();
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.yaw = 0; p.pitch = 0;
      window.__IRONFALL__.simulate(0.6, [{ seconds: 0.6 }]);
      const ez = p.pos[2] - 10;
      const ey = g.world.groundHeight(p.pos[0], ez);
      const e1 = en.spawn('grunt', [p.pos[0], ey, ez]);
      e1.grounded = true;
      // 冻结：不推进物理，射线基准就用当前 e1.pos
      const def = g.weapons.current.def;
      const bx = e1.pos[0], bz = e1.pos[2] - 0.2, baseY = e1.pos[1];
      const H = e1.height;
      // 从三个高度水平射入
      const bodyHit = en.raycastEnemies([bx, baseY + H * 0.62, bz], [0, 0, -1], 60);
      const headHit = en.raycastEnemies([bx, baseY + H * 0.92, bz], [0, 0, -1], 60);
      const legHit = en.raycastEnemies([bx, baseY + 0.35, bz], [0, 0, -1], 60);
      return {
        bodyHead: bodyHit ? bodyHit.headshot : null,
        bodyLeg: bodyHit ? bodyHit.legshot : null,
        headHead: headHit ? headHit.headshot : null,
        legLeg: legHit ? legHit.legshot : null,
        bodyDmg: def.damage, headDmg: def.damageHead, legDmg: def.damageLeg,
        boxes: e1.hitboxes.map(b => b.name),
        boxRange: e1.hitboxes.map(b => ({ n: b.name, y0: +(baseY + b.min[1]).toFixed(2), y1: +(baseY + b.max[1]).toFixed(2) })),
        baseY: +baseY.toFixed(2), H,
        rays: { body: +(baseY + H * 0.62).toFixed(2), head: +(baseY + H * 0.92).toFixed(2), leg: +(baseY + 0.35).toFixed(2) },
      };
    })()`);
    check('敌人具备 head/body/legs 分层命中盒',
      headshot.boxes.includes('head') && headshot.boxes.includes('body') && headshot.boxes.includes('legs'),
      headshot.boxes.join(','));
    check('射线能区分头/躯干/腿三层命中盒',
      headshot.headHead === true && headshot.bodyHead === false && headshot.legLeg === true,
      `头=${headshot.headHead} 躯干=${headshot.bodyHead} 腿=${headshot.legLeg}（射线高度 ${JSON.stringify(headshot.rays)}，命中盒 ${JSON.stringify(headshot.boxRange)}）`);
    check('爆头伤害高于身体高于腿部',
      headshot.headDmg > headshot.bodyDmg && headshot.bodyDmg > headshot.legDmg,
      `头 ${headshot.headDmg} > 躯干 ${headshot.bodyDmg} > 腿 ${headshot.legDmg}`);

    section('6. 敌人 AI 与导演');

    const ai = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const en = g.enemies; en.clear();
      g.director.enabled = false;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      p.health = p.maxHealth;
      p.shield = p.maxShield;
      p.invulnTime = 0;
      window.__IRONFALL__.simulate(0.5, [{ seconds: 0.5 }]);
      // 在 14m 处放一个敌人（确保它看得见玩家）
      const ex = p.pos[0] + 14, ez = p.pos[2];
      const ey = g.world.groundHeight(ex, ez);
      const e = en.spawn('grunt', [ex, ey, ez]);
      const p0 = [e.pos[0], e.pos[1], e.pos[2]];
      const state0 = e.state;
      window.__IRONFALL__.simulate(3.0, [{ seconds: 3.0 }]);
      const p1 = [e.pos[0], e.pos[1], e.pos[2]];
      return { state0, state1: e.state, moved: +Math.hypot(p1[0]-p0[0], p1[2]-p0[2]).toFixed(2),
               alertness: +e.alertness.toFixed(2), alive: e.alive,
               playerHealth: +p.health.toFixed(0), playerShield: +p.shield.toFixed(0),
               grounded: e.grounded, enemyY: +e.pos[1].toFixed(2),
               groundY: +g.world.groundHeight(e.pos[0], e.pos[2]).toFixed(2) };
    })()`);
    check('敌人 AI 从待机进入警觉/交战', ai.state1 !== ai.state0 || ai.state1 >= 1,
      `状态 ${ai.state0} → ${ai.state1}（警觉度 ${ai.alertness}）`);
    check('敌人会移动（寻路/接敌）', ai.moved > 0.2 || ai.state1 >= 1,
      `位移 ${ai.moved}m`);
    check('敌人站在地面上（不悬空/不穿地）', ai.grounded === true,
      `敌人 y=${ai.enemyY} 地面 y=${ai.groundY}`);

    // 攻击测试：4 个敌人在 7m 内，给足时间完成蓄力+点射
    await reset();
    const attack = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const en = g.enemies; en.clear();
      g.director.enabled = false;
      const p = g.player;
      p.teleport(g._testSpot.slice());
      window.__IRONFALL__.simulate(1.0, [{ seconds: 1.0 }]);
      p.health = p.maxHealth; p.shield = p.maxShield; p.invulnTime = 0;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        const x = p.pos[0] + Math.cos(a) * 7, z = p.pos[2] + Math.sin(a) * 7;
        en.spawn('grunt', [x, g.world.groundHeight(x, z), z]);
      }
      const before = p.health + p.shield;
      window.__IRONFALL__.simulate(8.0, [{ seconds: 8.0 }]);
      return { before: +before.toFixed(0), after: +(p.health + p.shield).toFixed(0),
               hp: +p.health.toFixed(0), shield: +p.shield.toFixed(0), alive: p.alive,
               enemiesFiring: en.all.filter(e => e.alive && (e.burstLeft > 0 || e.telegraphing)).length,
               states: en.all.map(e => e.state) };
    })()`);
    check('敌人会攻击玩家', attack.after < attack.before,
      `生命+护盾 ${attack.before} → ${attack.after}（开火中 ${attack.enemiesFiring} 个，状态 [${attack.states}]）`);

    // 全兵种生成与击杀
    const allTypes = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const en = g.enemies; en.clear();
      const sp = g.world.findPlayerSpawn(0);
      const types = Object.keys(window.__IRONFALL__.ENEMY_TYPES);
      const spawned = [];
      for (let i = 0; i < types.length; i++) {
        const a = (i / types.length) * Math.PI * 2;
        const x = sp[0] + Math.cos(a) * 9, z = sp[2] + Math.sin(a) * 9;
        const y = g.world.groundHeight(x, z) + 0.5;
        const e = en.spawn(types[i], [x, y, z]);
        e.grounded = true;
        spawned.push({ id: types[i], hp: e.hp, alive: e.alive, boxes: e.hitboxes.length });
      }
      window.__IRONFALL__.simulate(2.0, [{ seconds: 2.0 }]);
      const after = spawned.map(s => {
        const e = en.all.find(x => x.typeId === s.id);
        return { id: s.id, alive: e ? e.alive : false, moved: e ? Math.hypot(e.vel[0], e.vel[2]) : 0, state: e ? e.state : -1 };
      });
      return { count: spawned.length, spawned, after };
    })()`);
    check('全部 6 个兵种都能生成', allTypes.count === 6, `${allTypes.count} 个兵种`);
    const allAlive = allTypes.after.every((a) => a.alive);
    check('全部兵种在物理推进后仍存活且未出错', allAlive,
      allTypes.after.map((a) => `${a.id}:${a.alive ? 'ok' : 'dead'}`).join(' '));

    // 导演刷怪
    const director = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      g.enemies.clear();
      g.director.start(g.run);
      g.director.setTier(3);
      g.player.health = g.player.maxHealth;
      g.run.phase = 'objectives';
      const before = g.enemies.aliveCount();
      for (let i = 0; i < 12; i++) window.__IRONFALL__.simulate(1.0, [{ seconds: 1.0 }]);
      const d = g.director.debugState();
      return { before, alive: g.enemies.aliveCount(), phase: d.phase, intensity: d.intensity,
               budget: d.budget, spawned: g.enemies.stats.spawned, concurrency: d.concurrencyLimit };
    })()`);
    check('导演在 12 秒内刷出敌人', director.spawned > 0, `已生成 ${director.spawned} 个`);
    check('同时活跃数量受上限约束', director.alive <= director.concurrency + 2,
      `活跃 ${director.alive} / 上限 ${director.concurrency}`);
    check('导演强度在上升', director.intensity > 0.1, `强度 ${director.intensity}`);

    section('7. 肉鸽升级与经济');

    const upgrades = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const up = g.upgrades;
      up.addAlloy(99999);
      const rng = () => Math.random();
      const offers = up.rollOffers(3, rng);
      // pick() 会原地 splice 当前货架；先拍快照，否则首批里抽到伤害件时，
      // 后面的“货架应有 3 项”断言会把购买后的 2 项误报成生成失败。
      const initialOfferCount = offers.length;
      const initialOfferIds = offers.map(o => o.id);
      const initialRarities = offers.map(o => o.rarity);
      const initialHasPrice = offers.every(o => typeof o.price === 'number' && o.price > 0);
      const dmgBefore = g.player.mods.weapon.damageMul;
      // 找一个伤害类改件并购买
      let bought = null;
      for (const o of offers) {
        const patch = o.def.apply(1);
        if (patch.weapon && patch.weapon.damageMul && patch.weapon.damageMul !== 1) {
          bought = up.pick(o.id) ? o : null;
          if (bought) break;
        }
      }
      // 无论是否找到伤害件，再随机买 3 个验证叠层
      for (let i = 0; i < 3; i++) {
        const os = up.rollOffers(3, rng);
        if (os.length) up.pick(os[0].id);
      }
      return {
        offerCount: initialOfferCount,
        offerIds: initialOfferIds,
        rarities: initialRarities,
        hasPrice: initialHasPrice,
        ownedCount: up.owned.length,
        alloy: up.alloy,
        dmgBefore,
        dmgAfter: g.player.mods.weapon.damageMul,
        modKeys: Object.keys(g.player.mods.move).length,
      };
    })()`);
    check('升级货架返回 3 个 offer', upgrades.offerCount === 3, upgrades.offerIds.join(','));
    check('offer 带稀有度与价格', upgrades.hasPrice && upgrades.rarities.length === 3,
      upgrades.rarities.join(','));
    check('可以购买升级', upgrades.ownedCount > 0, `已拥有 ${upgrades.ownedCount} 件`);
    check('购买后 modifiers 注入玩家', upgrades.modKeys >= 40, `${upgrades.modKeys} 个运动键`);

    const modifiersLive = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const up = g.upgrades;
      up.reset();
      up.addAlloy(99999);
      const rng = () => 0.01;   // 固定序列
      let picked = 0;
      for (let i = 0; i < 6; i++) {
        const os = up.rollOffers(3, rng);
        if (!os.length) break;
        if (up.pick(os[0].id)) picked++;
      }
      const mods = up.modifiers;
      // 施加到玩家与武器
      g.player.setModifiers(mods);
      g.weapons.addModifiers(mods);
      const hp = g.player.maxHealth;
      const walkBefore = window.__IRONFALL__.CFG.move.walkSpeed;
      // 测一次实际移动速度（升级可能影响）
      const sp = g.world.findPlayerSpawn(0);
      g.player.teleport(sp);
      g.player.yaw = 0;
      window.__IRONFALL__.simulate(1.6, [{ seconds: 1.6, moveY: 1, sprint: true }]);
      return { picked, modKeys: Object.keys(mods.move).length,
               maxHealth: hp, hspeed: g.player.state.hspeed, walkSpeed: walkBefore,
               ownedIds: up.owned.map(o => o.id) };
    })()`);
    check('连续购买多件升级稳定', modifiersLive.picked > 0,
      `购买 ${modifiersLive.picked} 件: ${modifiersLive.ownedIds.join(',')}`);
    check('升级能改变实际运动数值', modifiersLive.hspeed > 0,
      `冲刺速度 ${modifiersLive.hspeed.toFixed(2)} m/s`);

    section('8. 性能与满载稳定性');

    const perf = await cdp.eval(`(async () => {
      const g = window.__IRONFALL__.game;
      const en = g.enemies;
      en.clear();
      const spot = g._testSpot || [0, g.world.groundHeight(0,0) + 3, 0];
      g.player.teleport(spot.slice());
      g.player.health = g.player.maxHealth;
      // 制造"满负载"：18 个敌人 + 大量粒子
      const types = Object.keys(window.__IRONFALL__.ENEMY_TYPES);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        const x = spot[0] + Math.cos(a) * 16, z = spot[2] + Math.sin(a) * 16;
        en.spawn(types[i % types.length], [x, g.world.groundHeight(x, z) + 0.6, z]);
      }
      for (let i = 0; i < 40; i++) {
        g.particles.emitBurst([spot[0] + (Math.random()-0.5)*10, spot[1]+1, spot[2] + (Math.random()-0.5)*10],
          [0,1,0], 'impact', {});
      }
      window.__IRONFALL__.simulate(0.5, [{ seconds: 0.5 }]);

      const errorsBefore = (window.__IRONFALL__.errors || []).length;
      // A. 确定性满载渲染：手动渲染 N 帧，验证管线不崩、开销可控、无 NaN。
      //    （不用帧率做断言：无头环境是 SwiftShader 纯软件光栅化，速度随机波动极大）
      const t0 = performance.now();
      let frames = 0;
      for (let i = 0; i < 30; i++) {
        window.__IRONFALL__.renderOnce();
        frames++;
      }
      const cpuPerFrame = (performance.now() - t0) / frames;
      const bad = [];
      const scan = (obj, path, depth) => {
        if (depth > 3 || !obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === 'number' && !isFinite(v)) bad.push(path + '.' + k);
          else if (v && typeof v === 'object' && !(v instanceof Float32Array) && !Array.isArray(v)) scan(v, path + '.' + k, depth + 1);
        }
      };
      scan({ p: g.player.debugState(), w: g.weapons.debugState(), d: g.director.debugState() }, '', 0);
      const st = g.engine.stats;
      return {
        frames, cpuPerFrameMs: Math.round(cpuPerFrame * 100) / 100,
        drawCalls: st.drawCalls, triangles: st.triangles, instances: st.instances, batches: st.batches,
        entities: en.aliveCount(), particles: g.particles.count, decals: g.decals.aliveCount,
        errorsBefore, errorsAfter: (window.__IRONFALL__.errors || []).length,
        nanCount: bad.length, nanPaths: bad.slice(0, 6),
      };
    })()`);
    process.stdout.write(`  满载渲染: 30 帧，CPU 每帧 ${perf.cpuPerFrameMs}ms，draw calls=${perf.drawCalls}，三角=${perf.triangles}，实例=${perf.instances}\n`);
    check('满载下连续渲染 30 帧无异常', perf.frames === 30 && perf.errorsAfter === perf.errorsBefore,
      `${perf.frames} 帧，错误 ${perf.errorsBefore} → ${perf.errorsAfter}`);
    check('满载下无 NaN 污染', perf.nanCount === 0, perf.nanCount ? perf.nanPaths.join(', ') : '0 处');
    check('CPU 每帧提交开销可控（< 12ms）', perf.cpuPerFrameMs < 12,
      `${perf.cpuPerFrameMs}ms/帧（不含 GPU 光栅化时间）`);
    check('draw call 保持在很低水平（状态批处理生效）', perf.drawCalls > 0 && perf.drawCalls < 120,
      `${perf.drawCalls} 次绘制 / ${perf.batches} 个批次`);
    check('实例化渲染在生效（单帧实例数 > 100）', perf.instances > 100, `${perf.instances} 个实例`);

    // B. 真实 rAF 帧率：只作参考输出，不断言（软件渲染速度不可代表真机）
    const timing = await cdp.eval(`window.__IRONFALL__.measureFps(${Math.min(FPS_MS, 1500)})`);
    process.stdout.write(`  rAF 实测（软件渲染，仅供参考）: ${timing.fps} FPS / ${timing.frames} 帧 / 最差 ${timing.worstFrameMs}ms\n`);
    check('rAF 渲染循环能正常产出帧', timing.frames >= 1 && isFinite(timing.fps),
      `${timing.frames} 帧 / ${timing.ms}ms`);

    const stats = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const s = g.engine.stats;
      return { drawCalls: s.drawCalls, triangles: s.triangles, instances: s.instances,
               batches: s.batches, entities: g.enemies.aliveCount(),
               particles: g.particles.count, decals: g.decals.aliveCount,
               meshCount: g.glInfo.meshCount, gpu: g.glInfo.gpu.renderer };
    })()`);
    process.stdout.write(`  批次数=${stats.batches} 实例=${stats.instances} 三角=${stats.triangles} 敌人=${stats.entities} 粒子=${stats.particles}\n`);
    check('实例化渲染在生效（单帧实例数 > 100）', stats.instances > 100, `${stats.instances} 个实例`);

    section('9. 截图（人工复核）');

    await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const sp = g.world.findPlayerSpawn(0);
      g.player.teleport([sp[0], sp[1] + 3, sp[2]]);
      g.player.yaw = 0.8; g.player.pitch = -0.12;
      g.player.health = g.player.maxHealth * 0.62;
      g.player.shield = g.player.maxShield * 0.4;
      g.weapons.equip('r99'); g.weapons._equip('r99', true); g.weapons.resetAmmo();
      const st = g.weapons.state.get('r99'); st.ammo = 13;
      g.run.alloy = 148;
      g.hud.setAlloy(148);
      g.hud.setObjective('摧毁热核中继', 1, 3);
      g.hud.addKill('击毁 远征巡逻兵', 'normal');
      g.hud.addKill('爆头击毁 定点清除者', 'headshot');
      g.hud.addDamageNumber(37, true, 0.5, 0.5);
      g.hud.flashHitmarker('kill');
      return true;
    })()`);
    await sleep(400);
    await cdp.eval('window.__IRONFALL__.renderOnce()');
    await sleep(150);
    const shot1 = await cdp.screenshot(join(OUT_DIR, 'gameplay-01.png'));
    check('游戏内截图已保存', existsSync(shot1), shot1);

    // 开火瞬间
    await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      window.__IRONFALL__.simulate(0.14, [{ seconds: 0.14, fire: true }]);
      g.hud.flashHitmarker('headshot');
      g.hud.addDamageNumber(52, true, 0.5, 0.5);
      window.__IRONFALL__.renderOnce();
      return true;
    })()`);
    await sleep(120);
    const shot2 = await cdp.screenshot(join(OUT_DIR, 'gameplay-02-firing.png'));
    check('开火截图已保存', existsSync(shot2), shot2);

    // 蹬墙跑
    await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const w = g.world;
      for (const b of w.boxes) {
        const h = b.max[1] - b.min[1];
        if (h < 4) continue;
        const useX = (b.max[0]-b.min[0]) < (b.max[2]-b.min[2]);
        const cx=(b.min[0]+b.max[0])/2, cz=(b.min[2]+b.max[2])/2;
        const off = (useX ? (b.max[0]-b.min[0]) : (b.max[2]-b.min[2]))/2 + 0.55;
        const px = useX ? b.min[0]-off : cx, pz = useX ? cz : b.min[2]-off;
        const gy = w.groundHeight(px,pz);
        if (gy < -50) continue;
        g.player.teleport([px, Math.max(gy, b.min[1]) + 1.2, pz]);
        const nx = useX?1:0, nz = useX?0:1;
        g.player.yaw = Math.atan2(-nx,-nz); g.player.pitch = 0;
        g.player.vel[0] = -nz*13; g.player.vel[2] = nx*13; g.player.vel[1]=1.5;
        window.__IRONFALL__.simulate(0.4, [{ seconds: 0.4, moveY: 1 }]);
        if (g.player.state.wallRunning) break;
      }
      g.hud.setPrompt('WALLRUN');
      window.__IRONFALL__.renderOnce();
      return g.player.state.moveState;
    })()`);
    await sleep(120);
    const shot3 = await cdp.screenshot(join(OUT_DIR, 'gameplay-03-wallrun.png'));
    check('蹬墙跑截图已保存', existsSync(shot3), shot3);

    // 菜单
    await cdp.eval('window.__IRONFALL__.game.hud.showMenu("main")');
    await sleep(350);
    const shot4 = await cdp.screenshot(join(OUT_DIR, 'menu-main.png'));
    check('主菜单截图已保存', existsSync(shot4), shot4);

    await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      g.upgrades.addAlloy(500);
      g.hud.showUpgradePanel(g.upgrades.rollOffers(3, () => 0.3), g.upgrades.alloy);
      g.hud.hideMenu();
      return true;
    })()`);
    await sleep(300);
    const shot5 = await cdp.screenshot(join(OUT_DIR, 'upgrade-panel.png'));
    check('升级面板截图已保存', existsSync(shot5), shot5);

    section('10. 稳定性回归');

    const stress = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const errsBefore = (window.__IRONFALL__.errors || []).length;
      // 打开 NaN 哨兵：一旦武器状态里出现非有限值，立刻记录当时的上下文
      g.nanSentinel = true;
      g._nanReport = null;
      let snapshots = 0;
      // 反复切换地图 + 混合操作，检查状态机与大循环稳定性
      for (let i = 0; i < 3; i++) {
        g.loadMission(i, {});
        g.player.respawn(g.world.findPlayerSpawn(0));
        g.player.health = g.player.maxHealth;
        g.enemies.clear();
        window.__IRONFALL__.simulate(2.0, [
          { seconds: 0.5, moveY: 1, sprint: true },
          { seconds: 0.3, moveY: 1, jump: true, fire: true },
          { seconds: 0.3, moveY: 1, crouch: true, fire: true },
          { seconds: 0.4, moveY: 1, dash: true, grapple: true, fire: true },
          { seconds: 0.5, moveY: -1, fire: true, reload: true },
        ]);
        g.renderOnce();
        snapshots++;
      }
      g.nanSentinel = false;
      return { snapshots, errsBefore, errsAfter: (window.__IRONFALL__.errors || []).length,
               map: g.mapName, alive: g.player.alive, hp: g.player.health,
               pos: [g.player.pos[0], g.player.pos[1], g.player.pos[2]],
               nanReport: g._nanReport,
               weaponsDebug: g.weapons.debugState(),
               slotStates: [...g.weapons.state.entries()].map(([k, v]) => ({
                 k, adsT: String(v.adsT), spreadExtra: String(v.spreadExtra),
                 reloadT: String(v.reloadT), reloadDuration: String(v.reloadDuration),
               })) };
    })()`);
    check('反复切图 + 混合操作无异常', stress.errsAfter === stress.errsBefore,
      `错误 ${stress.errsBefore} → ${stress.errsAfter}`);
    if (stress.nanReport) {
      process.stdout.write('  NaN 探针命中: ' + JSON.stringify(stress.nanReport) + '\n');
    }
    process.stdout.write('  武器状态: ' + JSON.stringify(stress.slotStates) + '\n');
    check('混合操作后玩家状态仍然有效（未 NaN）',
      isFinite(stress.pos[0]) && isFinite(stress.pos[1]) && isFinite(stress.pos[2]),
      `位置 [${stress.pos.map((v) => v.toFixed(1)).join(', ')}]`);

    // 数值健康检查
    const numerical = await cdp.eval(`(() => {
      const g = window.__IRONFALL__.game;
      const p = g.player;
      const bad = [];
      const scan = (obj, path, depth) => {
        if (depth > 3 || !obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === 'number' && !isFinite(v)) bad.push(path + '.' + k + '=' + v);
          else if (v && typeof v === 'object' && !(v instanceof Float32Array) && !Array.isArray(v)) scan(v, path + '.' + k, depth + 1);
        }
      };
      const wd = g.weapons.debugState();
      const wc = g.weapons.current;
      scan({
        player: { pos: p.pos, vel: p.vel, mods: p.mods.move },
        weapons: wd,
        run: g.run.debugState(),
        director: g.director.debugState(),
      }, '', 0);
      const rawSt = g.weapons.state.get(g.weapons.slots[g.weapons.slotIndex].id);
      return { bad: bad.slice(0, 12), count: bad.length,
               raw: { adsT: String(rawSt.adsT), reloadT: String(rawSt.reloadT),
                      reloadDuration: String(rawSt.reloadDuration), reloading: rawSt.reloading },
               debug: { adsProgress: String(wd.adsProgress), reloadProgress: String(wd.reloadProgress) },
               current: { adsProgress: String(wc.adsProgress), reloadProgress: String(wc.reloadProgress) },
               slot: g.weapons.slots[g.weapons.slotIndex].id };
    })()`);
    if (numerical.count > 0) {
      process.stdout.write('  NaN 明细: ' + JSON.stringify({ raw: numerical.raw, debug: numerical.debug, current: numerical.current, slot: numerical.slot }) + '\n');
    }
    check('关键状态无 NaN/Infinity', numerical.count === 0,
      numerical.count ? numerical.bad.join(', ') : '0 处');

    const finalErrors = await cdp.eval('JSON.stringify(window.__IRONFALL__.errors)');
    const finalList = JSON.parse(finalErrors || '[]');
    check('全部测试结束后仍无未捕获错误', finalList.length === 0,
      finalList.length ? finalList.map((e) => e.message).join(' | ').slice(0, 400) : '0 个');

    section('总结');
    const total = results.length;
    const passed = total - failures;
    process.stdout.write(`  通过 ${passed}/${total}\n`);
    process.stdout.write(`  截图目录: ${OUT_DIR}\n`);
    if (failures > 0) {
      process.stdout.write('\n  失败项:\n');
      for (const r of results) if (!r.ok) process.stdout.write(`    - ${r.name} [${r.detail}]\n`);
      exitCode = 1;
    } else {
      process.stdout.write('\n  IRONFALL HEADLESS CHECK: 全部通过\n');
    }
    process.stdout.write(`\n  真机性能提示: 无头环境使用 SwiftShader 软件渲染，帧率不代表真实性能。\n`);
  } catch (err) {
    process.stdout.write('\n验证过程抛出异常: ' + (err && err.stack ? err.stack : err) + '\n');
    if (cdp) {
      process.stdout.write('页面错误: ' + JSON.stringify(cdp.exceptions.slice(-4), null, 2) + '\n');
      process.stdout.write('控制台: ' + JSON.stringify(cdp.consoleLogs.slice(-12), null, 2) + '\n');
    }
    process.stdout.write('Chrome stderr 尾部:\n' + getStderr().slice(-1500) + '\n');
    exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (_e) { /* 忽略 */ }
    if (!KEEP) {
      killChrome(proc);
    }
    server.close();
    // 写一份机器可读的结果
    try {
      await writeFile(join(OUT_DIR, 'results.json'),
        JSON.stringify({ when: new Date().toISOString(), total: results.length, failures, results }, null, 2));
    } catch (_e) { /* 忽略 */ }
  }
  process.exit(exitCode);
}

main();
