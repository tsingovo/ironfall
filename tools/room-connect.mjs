import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { createFriendBridge } from './friend-bridge.mjs';
import { validateInvite } from './room-invite.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (s) => (await prompt.question(s)).trim();
const unquote = (s) => s.replace(/^"|"$/g, '');
let bridge;
try {
  const mode = process.argv[2] || 'join';
  if (mode === 'create') {
    console.log('生成可分享的房间文件：仅包含地址、房间名和可选公开证书，不包含私钥。');
    let address = await ask('穿透/服务器地址（例如 https://域名:端口，TCP 填 http://域名:端口）：');
    if (!address.includes('://')) address = 'http://' + address;
    const room = (await ask('房间名（回车 default，房主和队友必须相同）：')) || 'default';
    console.log('使用受信任 HTTPS 或普通 TCP 时证书路径可留空。Sakura 自动 HTTPS 的公开证书在启动器“设置→高级设置→打开工作目录→FrpcWorkingDirectory”里。');
    const certPath = unquote(await ask('公开 .crt 文件完整路径（绝不能选 .key）：'));
    const certificate = certPath ? await readFile(certPath, 'utf8') : '';
    const invite = validateInvite({ format: 'ironfall-room-v1', endpoint: address, room, certificate });
    const out = join(root, '房间邀请.ironfall-room.json');
    await writeFile(out, JSON.stringify(invite, null, 2), { flag: 'wx' });
    console.log('已生成：' + out + '\n把此文件发给朋友，双方使用通用版“导入房间.cmd”。已有同名文件请先改名保存，再重新导出。');
    if (invite.fingerprint) console.log('证书指纹（可通过可信聊天核对）：' + invite.fingerprint);
  } else {
    const path = unquote(process.argv[3] || await ask('拖入房主发来的 .ironfall-room.json 文件，然后回车：'));
    const info = await stat(path);
    if (info.size > 65536) throw new Error('房间文件超过 64 KB');
    const invite = validateInvite(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')));
    console.log(`目标：${invite.endpoint}\n房间：${invite.room}`);
    if (invite.fingerprint) console.log('仅信任此房主提供的证书：' + invite.fingerprint + '\n请与房主核对指纹；不会安装系统证书，不会关闭 TLS 校验。');
    else console.log(invite.endpoint.startsWith('https:') ? '使用系统默认可信证书校验。' : '此连接为明文 HTTP/WS，仅用于你信任的游戏服务器。');
    if ((await ask('确认该邀请来自你信任的房主？输入 YES 连接：')).toUpperCase() !== 'YES') throw new Error('已取消');
    bridge = createFriendBridge({ endpoint: invite.endpoint, ca: invite.certificate || undefined,
      html: await readFile(join(root, 'IRONFALL.html')) });
    const url = await bridge.listen();
    const response = await fetch(new URL('/lan/status', url), { signal: AbortSignal.timeout(15000) });
    const status = await response.json();
    if (!response.ok || !status.ok || !status.lan) throw new Error('服务器未就绪：' + (status.error || response.status));
    console.log('连接成功。保持此窗口开启；进入联机大厅加入房间。房主也可导入同一文件创建房间。');
    const app = spawn(process.execPath, [join(root, 'tools/launch-app.mjs')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, IRONFALL_PORT: url.port, IRONFALL_ROOM: invite.room },
    });
    app.on('error', e => { console.error(e.message); bridge.close(); });
    app.on('exit', code => { if (code) bridge.close(); });
    process.on('SIGINT', () => bridge.close().then(() => process.exit(0)));
    process.on('SIGTERM', () => bridge.close().then(() => process.exit(0)));
  }
} catch (e) {
  console.error('房间操作失败：' + e.message);
  if (bridge) await bridge.close();
  process.exitCode = 1;
} finally { prompt.close(); }
