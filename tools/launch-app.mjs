// IRONFALL 独立窗口启动器：本地静态服务器 + Chromium app 模式。
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const logFile = join(root, 'launch.log');
// 2.0 使用独立端口，绝不能复用 1.x 在 18080 上残留的单文件服务器。
// 旧服务器返回同样的 <title>，此前仅按标题探测会让新版启动器打开旧游戏。
let port = Number(process.env.IRONFALL_PORT || 18240);
const roomQuery = process.env.IRONFALL_ROOM ? `&room=${encodeURIComponent(process.env.IRONFALL_ROOM)}` : '';
let url = `http://127.0.0.1:${port}/?standalone=1${roomQuery}`;

function log(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`;
  console.log(message);
  try { appendFileSync(logFile, line + '\n', 'utf8'); } catch (_e) { /* 日志失败不能阻止启动 */ }
}

const candidates = [
  process.env.IRONFALL_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const browser = candidates.find(existsSync);
if (!browser) {
  console.error('未找到 Chrome/Edge。可设置 IRONFALL_BROWSER 指向浏览器 exe。');
  process.exit(2);
}

// 隔离 1.x 的 Service Worker / local cache / 残留 Chromium 进程；meta 存档仍在
// 2.0 专属配置内持续保存，后续 2.x 热修不会再更换此目录。
const profile = join(process.env.LOCALAPPDATA || root, 'IRONFALL', 'app-profile-v2');
const browserArgs = [
  `--app=${url}`,
  `--user-data-dir=${profile}`,
  '--new-window',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--disable-background-mode',
  '--disable-extensions',
  '--disable-features=OverscrollHistoryNavigation,Translate',
  // Kiosk 使用无标题栏的游戏窗口，可从系统层消除 Alt+Space 左上角窗口菜单；
  // 普通网页的 preventDefault 无权拦截这个 Windows 系统快捷键。
  // 游戏本身不调用 Fullscreen API，因此 Esc 仍交给页面的暂停/设置状态机。
  '--kiosk',
  '--start-fullscreen',
  '--disable-pinch',
];

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ root, port, url, browser, profile, browserArgs }, null, 2));
  process.exit(0);
}

mkdirSync(profile, { recursive: true });

/**
 * 只清理使用 IRONFALL 专属 user-data-dir 的 Chrome/Edge。
 *
 * 固定 profile 里若残留后台/隐藏 Chromium，新启动命令会把窗口请求交给该进程后
 * 自己立刻退出，用户看到的就是“CMD 一闪而过但游戏没出现”。每次启动前重启这组
 * 专属进程，既保证窗口真的出现，也绝不会碰用户日常浏览器配置与标签页。
 */
function stopStaleDedicatedBrowser() {
  if (process.platform !== 'win32') return;
  const escaped = join(process.env.LOCALAPPDATA || root, 'IRONFALL').replaceAll("'", "''");
  const script = [
    `$needle = '--user-data-dir="?' + [regex]::Escape('${escaped}') + '\\\\app-profile(?:-v[0-9]+)?(?:"|\\s|$)'`,
    "$targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "  ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and",
    '  $_.CommandLine -and $_.CommandLine -match $needle',
    '})',
    'if ($targets.Count -gt 0) {',
    '  $targets | Sort-Object ProcessId -Descending | ForEach-Object {',
    '    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue',
    '  }',
    '  Start-Sleep -Milliseconds 450',
    '}',
    '$targets.Count',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  });
  const count = Number(String(result.stdout || '').trim().split(/\s+/).pop()) || 0;
  if (count > 0) log(`已关闭 ${count} 个 IRONFALL 专属残留浏览器进程。`);
  if (result.error) log(`清理残留进程时收到警告：${result.error.message}`);
}

/**
 * Chrome 在同一 user-data-dir 已有进程时，会把新窗口交给旧进程，然后让本次
 * spawn 出来的短命进程立即退出。旧启动器把这个“正常交接”误认为游戏已关闭，
 * 随即杀掉静态服务器，于是用户双击后只得到空白/没有窗口。
 *
 * 现在服务器独立常驻并可被后续双击复用；它按请求实时读取文件且禁用缓存，代码
 * 更新无需重启服务器。若内容版本不匹配，启动器会保留旧进程并自动换空闲端口。
 */
function getText(target) {
  return new Promise((resolve) => {
    const req = http.get(target, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ reachable: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ reachable: false, status: 0, text: '' }));
    req.setTimeout(700, () => { req.destroy(); resolve({ reachable: false, status: 0, text: '' }); });
  });
}

async function probeServer(candidatePort = port) {
  const base = `http://127.0.0.1:${candidatePort}`;
  const rootPage = await getText(`${base}/?standalone=1`);
  if (!rootPage.reachable) return { reachable: false, ironfall: false, currentBuild: false };
  const ironfall = rootPage.status === 200 && rootPage.text.includes('<title>IRONFALL');
  let currentBuild = ironfall && rootPage.text.includes('IRONFALL // BUILD 2.1.6');
  // 开发目录的 index.html 不内联 HUD，因此再检查源码；发布包的单文件在上一步即可识别。
  if (ironfall && !currentBuild) {
    const hudSource = await getText(`${base}/src/ui/hud.js`);
    currentBuild = hudSource.status === 200 && hudSource.text.includes('IRONFALL // BUILD 2.1.6');
  }
  return { reachable: true, ironfall, currentBuild };
}

async function ensureServer() {
  const existing = await probeServer();
  if (existing.currentBuild) {
    log(`正在复用 IRONFALL 2.x 本地服务器（端口 ${port}）…`);
    return;
  }
  if (existing.reachable) {
    const oldPort = port;
    let found = 0;
    for (let candidate = oldPort + 1; candidate <= oldPort + 30; candidate++) {
      const state = await probeServer(candidate);
      if (!state.reachable) { found = candidate; break; }
      if (state.currentBuild) { found = candidate; break; }
    }
    if (!found) throw new Error(`端口 ${oldPort}—${oldPort + 30} 均被占用`);
    port = found;
    url = `http://127.0.0.1:${port}/?standalone=1${roomQuery}`;
    browserArgs[0] = `--app=${url}`;
    const reason = existing.ironfall ? '检测到旧版 IRONFALL 实例' : '默认端口被其他程序占用';
    log(`${reason}（端口 ${oldPort}），本次从当前目录启动新服务器，端口 ${port}。旧游戏窗口将关闭。`);
    const replacement = await probeServer(port);
    if (replacement.currentBuild) return;
  }

  // --single <html>：发布包模式。游戏是单个 HTML，用极简服务器直接吐它。
  // 仍然走 HTTP 的原因：ES Modules 在 file:// 下会被 CORS 拦，
  // 而且 --app 独立窗口模式对 file:// 无效。
  const singleIdx = process.argv.indexOf('--single');
  const singleFile = singleIdx >= 0 ? process.argv[singleIdx + 1] : null;

  if (singleFile) {
    log('正在启动 IRONFALL 本地服务器（单文件模式）…');
    const server = spawn(process.execPath, [join(here, 'serve-single.mjs'), singleFile, String(port)], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    server.unref();
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = await probeServer();
      if (state.currentBuild) return;
      if (state.reachable) throw new Error(`端口 ${port} 被其他程序占用`);
    }
    throw new Error('本地游戏服务器启动超时');
  }

  log('正在启动 IRONFALL 本地服务器…');
  const server = spawn(process.execPath, [join(here, 'serve.mjs'), String(port)], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  server.unref();
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await probeServer();
    if (state.currentBuild) return;
    if (state.reachable) throw new Error(`端口 ${port} 被其他程序占用`);
  }
  throw new Error('本地游戏服务器启动超时');
}

try {
  await ensureServer();
  // 专项回归测试/运维探测：完成版本握手与端口选择后退出，不打开 GUI。
  // 正常双击启动路径不带此参数，行为不受影响。
  if (process.argv.includes('--ensure-only')) {
    log(`版本握手完成：${url}`);
    process.exit(0);
  }
  stopStaleDedicatedBrowser();
  log(`正在打开无边框独立游戏窗口：${browser}`);
  const app = spawn(browser, browserArgs, {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  let launchError = null;
  app.once('error', (err) => { launchError = err; });
  app.unref();
  // 重启过专属 profile 后，本次进程不应再被隐藏旧进程接管；仍留出时间捕获启动错误。
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (launchError) throw launchError;
  log(`IRONFALL 已启动（PID ${app.pid || '未知'}）。`);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  console.error(message);
  try { appendFileSync(logFile, `[${new Date().toISOString()}] 启动失败：${message}\n`, 'utf8'); } catch (_e) { /**/ }
  process.exitCode = 1;
}
