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
//
// 目录结构与开发仓库**刻意保持一致**：根目录有 开始游戏.cmd，tools/ 下有
// launch-app.mjs / serve-single.mjs。这样发布包和本地开发环境是同一套启动代码，
// 行为完全一致 —— 独立 App 窗口（--app），不会受 Ctrl+W 等标签页快捷键干扰。
//
// 唯一的区别：游戏本体是构建好的单文件 IRONFALL.html（开发仓库里是 index.html + src/）。

const README_TXT = `IRONFALL · 钢铁远征  v${pkgVersion}
================================================

【启动】
解压后双击「开始游戏.cmd」。首次运行若没有 Node.js，脚本会把便携运行环境下载到
%LOCALAPPDATA%\\IRONFALL\\runtime。游戏随后在独立、无边框、无地址栏的全屏窗口运行。

需要：Windows 10/11、Chrome 或 Edge、WebGL2。首次补齐运行环境时需要联网，之后可离线。

【游戏内联机】
主菜单 → 局域网联机 → 创建房间，自动启动 18200 服务。
房主填写完整 HTTP/HTTPS 穿透地址，按需选公开 .crt 证书，点击导出邀请发给朋友。
朋友选择邀请 JSON，点击确认导入并连接。无需额外 CMD；穿透客户端仍需房主运行。

【核心操作】
WASD 移动；Shift 疾跑；Ctrl/C 滑铲；Space 跳跃/滑铲跳；左 Alt Dash；Q 抓钩
鼠标左键开火；右键瞄准；R 换弹；1/2/3/4 切武器；B 哨兵整匣充能
5 治疗（长按轮盘）；Tab 背包；E 交互/拾取；V 近战；M 地图；Esc 设置/返回

【2.0】
· 十关战役：成功撤离解锁下一关，主菜单可选择已解锁任务
· 八种敌人、七把枪、额外枪械世界掉落与真实换装
· 6×4 背包：单击使用，拖动装备/整理，右键或拖出丢弃
· 配件 I/II/III、高级替换、卸下回包、鼠标悬停显示真实数值
· 撤离物资进入局外仓库并在下次部署带入；阵亡丢失
· 十类永久局外改件，使用远征点数购买并真实生效
· Apex 风格滑铲跳、Titanfall 2 风格墙跑、双方牵引抓钩
· 四种无限治疗道具，均有读条、减速、打断、动作与三阶段音效

Esc 在游玩中打开设置并暂停，菜单中关闭并恢复。独立窗口不调用网页 Fullscreen API，
不会因 Esc 小窗化；未锁鼠标时返回游戏 1 秒后自动重试。

存档位于 IRONFALL 专用浏览器配置的 localStorage；2.0 自动迁移旧版数据。
源码与完整说明：https://github.com/tsingovo/ironfall
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
  const launcher = await readFile(join(ROOT, 'tools/launcher-release.cmd'));
  const launchApp = await readFile(join(ROOT, 'tools/launch-app.mjs'));
  const serveSingle = await readFile(join(ROOT, 'tools/serve-single.mjs'));
  const releaseNotes = existsSync(join(DIST, 'RELEASE_NOTES.md'))
    ? await readFile(join(DIST, 'RELEASE_NOTES.md')) : Buffer.from('IRONFALL 2.0', 'utf8');
  const enc = (s) => Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8');

  const files = [
    { name: '开始游戏.cmd', data: enc(launcher.toString('utf8')) },
    { name: 'IRONFALL.html', data: html },
    { name: 'index.html', data: html },
    { name: 'tools/lan-server.mjs', data: await readFile(join(ROOT, 'tools/lan-server.mjs')) },
    { name: '使用说明.txt', data: enc(README_TXT) },
    { name: 'LICENSE', data: license },
    { name: 'RELEASE_NOTES.md', data: releaseNotes },
    { name: 'tools/launch-app.mjs', data: launchApp },
    { name: 'tools/serve-single.mjs', data: serveSingle },
    { name: 'tools/friend-bridge.mjs', data: await readFile(join(ROOT, 'tools/friend-bridge.mjs')) },
    { name: 'tools/local-room-control.mjs', data: await readFile(join(ROOT, 'tools/local-room-control.mjs')) },
    { name: 'tools/room-invite.mjs', data: await readFile(join(ROOT, 'tools/room-invite.mjs')) },
  ];

  // Host-specific package: public certificate only; never include a private key.
  const friend = process.argv.includes('--friend');
  if (friend) {
    files.push(
      { name: 'tools/friend-server.crt', data: await readFile(join(DIST, 'friend-server.crt')) },
      { name: 'tools/friend-server.json', data: await readFile(join(DIST, 'friend-server.json')) },
      { name: '连接朋友房间.cmd', data: enc(launcher.toString('utf8').replace(
        '"%NODE%" "%~dp0tools\\launch-app.mjs" --single "%~dp0IRONFALL.html"',
        '"%NODE%" "%~dp0tools\\friend-bridge.mjs"')) },
      { name: '朋友联机说明.txt', data: await readFile(join(DIST, 'FRIEND_README.txt')) },
    );
  }

  const zip = makeZip(files);
  const out = join(DIST, `IRONFALL-${pkgVersion}-${friend ? 'friend' : 'offline'}.zip`);
  await writeFile(out, zip);

  const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
  console.log(`IRONFALL 发布包 v${pkgVersion}`);
  for (const f of files) console.log(`  + ${f.name}  (${(f.data.length / 1024).toFixed(1)} KB)`);
  console.log(`  产物: ${out}  (${mb(zip.length)})`);
  console.log(friend ? '  朋友请双击「连接朋友房间.cmd」，进入大厅后加入房间，不填写公网地址。'
    : '  解压后双击「开始游戏.cmd」：自动备好运行环境 → 独立 App 窗口启动。');
}

main().catch((e) => { console.error('打包失败:', e && e.message ? e.message : e); process.exit(1); });
