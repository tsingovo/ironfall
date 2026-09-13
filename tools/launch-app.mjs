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
const port = Number(process.env.IRONFALL_PORT || 18080);
const url = `http://127.0.0.1:${port}/?standalone=1`;

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

const profile = join(process.env.LOCALAPPDATA || root, 'IRONFALL', 'app-profile');
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
  // 不使用 --kiosk / 浏览器 Fullscreen API：它们都会优先吃掉 Esc 并退出全屏。
  // app + start-maximized 是无地址栏的独立游戏窗口，Esc 能稳定交给指针锁/游戏菜单。
  '--start-maximized',
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
  const escaped = profile.replaceAll("'", "''");
  const script = [
    `$needle = '${escaped}'`,
    "$targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "  ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and",
    '  $_.CommandLine -and $_.CommandLine.Contains($needle)',
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
 * 更新无需重启服务器。进程很轻量，只监听 127.0.0.1:18080。
 */
function probeServer() {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        reachable: true,
        ironfall: res.statusCode === 200 && Buffer.concat(chunks).toString('utf8').includes('<title>IRONFALL'),
      }));
    });
    req.on('error', () => resolve({ reachable: false, ironfall: false }));
    req.setTimeout(700, () => { req.destroy(); resolve({ reachable: false, ironfall: false }); });
  });
}

async function ensureServer() {
  const existing = await probeServer();
  if (existing.ironfall) {
    log('正在复用 IRONFALL 本地服务器…');
    return;
  }
  if (existing.reachable) throw new Error(`端口 ${port} 已被其他程序占用`);

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
      if (state.ironfall) return;
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
    if (state.ironfall) return;
    if (state.reachable) throw new Error(`端口 ${port} 被其他程序占用`);
  }
  throw new Error('本地游戏服务器启动超时');
}

try {
  await ensureServer();
  stopStaleDedicatedBrowser();
  log(`正在打开独立游戏窗口：${browser}`);
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
