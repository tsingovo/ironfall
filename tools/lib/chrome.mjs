// ==== tools/lib/chrome.mjs — 跨平台定位 Chrome / Edge ====
//
// 发布到 GitHub 后，别人的机器上 Chrome 路径各不相同。
// 这里统一做解析，优先级：CHROME_PATH 环境变量 → 各平台常见安装位置。
// 找不到时抛出一个带操作指引的错误，而不是让 spawn 抛 ENOENT。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

/** 无头 Chrome 的通用启动参数 */
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
    ...(extra || []),
  ];
}

export default { findChrome, requireChrome, headlessArgs };
