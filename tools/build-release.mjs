// ==== tools/build-release.mjs — 组装可下载的发布包 ====
//
// 产出 dist/IRONFALL-<version>-offline.zip，内含：
//   IRONFALL.html        单文件游戏本体（双击即玩，无需 Node / 服务器 / 联网）
//   开始游戏.cmd          双击用默认浏览器打开游戏（等价于双击 html）
//   使用说明.txt          给玩家看的简短说明
//   LICENSE               MIT
//
// 依赖 tools/build-standalone.mjs 先生成 dist/IRONFALL.html。
//
// 用法: node tools/build-standalone.mjs && node tools/build-release.mjs [version]

import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const HTML = join(DIST, 'IRONFALL.html');

const pkgVersion = process.argv[2] || '1.0.0';

// ---------------------------------------------------------------- 最小 ZIP 写入器
// 零依赖：手写 ZIP（store/deflate），避免为了打包引入第三方库。

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @param {{name:string, data:Buffer}[]} files */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    // 只有压缩确实更小才用 deflate
    const useDeflate = deflated.length < raw.length;
    const stored = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(1 << 11, 6);      // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x2821, 12);      // date（固定值，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(1 << 11, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------- 发布包内容

const LAUNCHER = `@echo off
setlocal
cd /d "%~dp0"

rem IRONFALL · 钢铁远征 —— 双击即玩
rem 用系统默认浏览器打开单文件游戏本体，不需要 Node、不需要联网。

set "GAME=%~dp0IRONFALL.html"
if not exist "%GAME%" (
  echo.
  echo 找不到 IRONFALL.html，请确认它和本文件在同一个文件夹里。
  echo.
  pause
  exit /b 1
)

echo 正在用默认浏览器启动 IRONFALL ...
start "" "%GAME%"
exit /b 0
`;

const README_TXT = `IRONFALL · 钢铁远征  v${pkgVersion}
工业星际远征背景的第一人称射击 Roguelike
================================================

【怎么玩】

  双击「开始游戏.cmd」，或者直接双击「IRONFALL.html」。

  不需要安装 Node.js，不需要联网，不需要任何配置。
  游戏是一个单文件网页（IRONFALL.html），在浏览器里跑。

【需要什么】

  · 一个较新的浏览器：Chrome / Edge（推荐，需要 WebGL2），
    Firefox 也可。
  · 独立显卡或较新的集成显卡，建议 1080p 以上分辨率。

【第一次进入】

  1. 首屏是开始界面 → 按 1 或点「开始远征」
  2. 画面中央出现「点击进入战场」→ 点一下画面
     （浏览器要求必须点一下才能锁定鼠标，这是安全限制）
  3. 鼠标锁定后即可自由转视角，系统光标会隐藏，屏幕上只剩准心

【基本操作】

  W A S D      移动
  Shift        疾跑
  Space        跳跃 / 二段跳（贴墙时按住可转成墙爬）
  Ctrl / C     蹲伏 / 滑铲
  Q            冲刺
  鼠标右键 / E  抓钩
  鼠标左键 / 中键  开火 / 开镜
  R / G        换弹 / 切枪
  F            互动（补给站、撤离点）
  Esc          菜单（不暂停游戏，视角仍可自由转动）
  Tab          直接打开设置
  F3           调试面板（帧率 / draw call）

  更多键位见游戏内「操作说明」。

【关于 Ctrl+W】

  Ctrl+W / Ctrl+T / F11 是浏览器保留快捷键，网页无权拦截。
  游戏开始时会自动进入全屏，全屏下浏览器不再把它当成关闭标签页。
  如果仍担心误触，建议用 Chrome 的「安装为应用」把 IRONFALL.html
  装成独立窗口（地址栏右侧图标 → 安装），那样没有标签栏。

【存档】

  进度保存在浏览器的本地存储里（跟具体浏览器和文件位置绑定）。
  换浏览器或移动文件位置会读不到旧存档。

【这是什么】

  纯 WebGL2 + 原生 ES Modules 实现，零第三方依赖、零构建步骤。
  运动手感参照 Apex Legends 并进一步强化（蹬墙跑、墙爬、抓钩摆荡、
  滑铲下坡加速、连跳），武器手感参照 R-99。

  源码与文档：https://github.com/tsingovo/ironfall
  许可：MIT
`;

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!existsSync(HTML)) {
    console.error('找不到 dist/IRONFALL.html，请先运行：node tools/build-standalone.mjs');
    process.exit(1);
  }

  const html = await readFile(HTML);
  const license = existsSync(join(ROOT, 'LICENSE')) ? await readFile(join(ROOT, 'LICENSE')) : Buffer.from('MIT');
  const enc = (s) => Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8');

  const files = [
    { name: 'IRONFALL.html', data: html },
    { name: '开始游戏.cmd', data: enc(LAUNCHER) },
    { name: '使用说明.txt', data: enc(README_TXT) },
    { name: 'LICENSE', data: license },
  ];

  const zip = makeZip(files);
  const out = join(DIST, `IRONFALL-${pkgVersion}-offline.zip`);
  await writeFile(out, zip);

  const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
  console.log(`IRONFALL 发布包 v${pkgVersion}`);
  for (const f of files) console.log(`  + ${f.name}  (${(f.data.length / 1024).toFixed(0)} KB)`);
  console.log(`  产物: dist/IRONFALL-${pkgVersion}-offline.zip  (${mb(zip.length)})`);
  console.log('  解压后双击「开始游戏.cmd」即玩。');
}

main().catch((e) => { console.error('打包失败:', e && e.message ? e.message : e); process.exit(1); });
