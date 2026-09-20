// ==== tools/lib/chrome.mjs — 跨平台定位 Chrome / Edge ====
//
// 发布到 GitHub 后，别人的机器上 Chrome 路径各不相同。
// 这里统一做解析，优先级：CHROME_PATH 环境变量 → 各平台常见安装位置。
// 找不到时抛出一个带操作指引的错误，而不是让 spawn 抛 ENOENT。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 返回可用的浏览器可执行文件路径；找不到返回 null */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch (_e) { /* 忽略不可访问的路径 */ }
  }
  return null;
}

/**
 * 拿到浏览器路径，或抛出带指引的错误。
 * 测试脚本应当在最前面调用它，这样失败信息对人有用。
 */
export function requireChrome(scriptName) {
  const p = findChrome();
  if (!p) {
    throw new Error(
      `[${scriptName || 'ironfall'}] 找不到 Chrome/Edge 可执行文件。\n` +
      '这些自测需要真实浏览器来跑（无头模式）。解决办法：\n' +
      '  · 安装 Google Chrome，或\n' +
      '  · 设置环境变量 CHROME_PATH 指向浏览器可执行文件，例如：\n' +
      '      Windows:  set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
      '      macOS/Linux: export CHROME_PATH=/usr/bin/google-chrome\n'
    );
  }
  return p;
}

/** 同 findChrome，但名字更直白地表示"可能返回 null"（自测可自行决定降级策略） */
export function requireChromeOrNull() {
  return findChrome();
}

/**
 * 图形后端参数：**优先用真实 GPU，而不是软件渲染**。
 *
 * 背景（用户反馈「测试把我电脑卡死 / 能用 GPU 吗」）：
 *   测试脚本原先硬编码 `--use-angle=swiftshader`，那是**纯 CPU 软件光栅化**，
 *   整个游戏循环（渲染 + 上万三角 + 怪物 AI）全压在 CPU 上，测试期间能把
 *   24 核的机器吃满。而这台机器有 RTX 4070 —— 实测无头 Chrome **完全能用**：
 *       swiftshader → ANGLE (SwiftShader Device)          ← CPU
 *       d3d11       → ANGLE (NVIDIA RTX 4070 ... D3D11)   ← GPU ✅
 *   既然有 GPU 就不该用 CPU 渲染。
 *
 * 这里不指定 `--use-angle`，交给 Chrome 自动选（实测在 Windows 上会选到
 * D3D11 + 真实 GPU）；只有在需要强制软件渲染时才显式传 swiftshader。
 * 需要兼容"没有 GPU 的机器"时，用 IRONFALL_SOFTWARE_GL=1 强制回退。
 */
export function glArgs() {
  if (process.env.IRONFALL_SOFTWARE_GL === '1') {
    // 显式要求软件渲染（CI / 无 GPU 环境）
    return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  }
  // 默认交给 Chrome 自动探测：有 GPU 就用 GPU。
  // --enable-gpu 让无头也启用 GPU 合成；它在新版里已默认开启，这里显式声明意图。
  return ['--enable-gpu'];
}

/**
 * 无头 Chrome 的通用启动参数。
 */
export function headlessArgs(userDataDir, extra) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    // 图形后端：优先真实 GPU（见 glArgs 的说明），不再无脑用软件渲染
    ...glArgs(),
    // 固定 1x 缩放，避免高 DPI 放大渲染量
    '--force-device-scale-factor=1',
    ...(extra || []),
  ];
}

/**
 * 结束一个无头 Chrome 进程**及其整棵子进程树**。
 *
 * 为什么不能只用 `proc.kill()`：Chrome 是多进程架构（主进程 + GPU + renderer +
 * utility…），而 Windows 上 `proc.kill()` 只终止直接子进程，其余子进程会变成
 * 孤儿继续驻留 —— 每个还占着 100~200MB 内存。实测连续跑几个测试后会积累到
 * 十几个 Chrome 进程、上 GB 内存，在任务管理器里非常显眼。
 *
 * Windows 用 taskkill /T /F 连整棵树一起结束；其它平台进程组语义正常，
 * 直接用 SIGKILL 即可。
 */
export function killChrome(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (_e) {
    // 兜底：至少把直接子进程杀掉
    try { proc.kill(); } catch (_e2) { /* 忽略 */ }
  }
}

export default { findChrome, requireChrome, headlessArgs, killChrome };
