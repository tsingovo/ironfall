// ==== tools/test-lan-server.mjs — 局域网服务器（WebSocket 帧 + 房间中继）自测 ====
// 纯 Node，无需浏览器。用法: node tools/test-lan-server.mjs

import { createLanServer, encodeFrame, decodeFrame, wsAccept, sanitizeName } from './lan-server.mjs';
import { parseServerAddress, DEFAULT_SERVER_PORT } from '../src/net/protocol.js';

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

function section(title) {
  process.stdout.write(`\n── ${title} ──\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到 predicate 成立或超时 */
async function waitFor(predicate, timeoutMs = 2500, label = 'condition') {
  const started = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await sleep(15);
  }
}

/** 把客户端 → 服务端的帧按 RFC 6455 加掩码，用于测试解码器 */
function maskFrame(opcode, payload, fin = true) {
  const body = Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i & 3];
  let header;
  const len = body.length;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  return Buffer.concat([header, mask, masked]);
}

// ---------------------------------------------------------------- 1. 帧编解码

section('1. WebSocket 帧编解码');

check('wsAccept 结果符合 RFC 6455 示例',
  wsAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  wsAccept('dGhlIHNhbXBsZSBub25jZQ=='));

{
  const small = encodeFrame(0x1, Buffer.from('hello'));
  check('短帧头部长度 2', small.length === 2 + 5 && small[0] === 0x81 && small[1] === 5);
  const decoded = decodeFrame(maskFrame(0x1, 'hello'));
  check('掩码短帧解码正确', decoded && !decoded.error && decoded.payload.toString('utf8') === 'hello');
}
{
  const mid = Buffer.alloc(300, 0x41);
  const enc = encodeFrame(0x1, mid);
  check('126–65535 帧用 16 位长度', enc[1] === 126 && enc.readUInt16BE(2) === 300 && enc.length === 4 + 300);
  const dec = decodeFrame(maskFrame(0x1, mid));
  check('16 位长度帧解码长度正确', dec && dec.payload.length === 300);
}
{
  const big = Buffer.alloc(70000, 0x42);
  const enc = encodeFrame(0x1, big);
  check('大于 65535 帧用 64 位长度', enc[1] === 127 && enc.readUInt32BE(2) === 0 && enc.readUInt32BE(6) === 70000);
  const dec = decodeFrame(maskFrame(0x1, big));
  check('64 位长度帧解码长度正确', dec && dec.payload.length === 70000);
}
{
  const dec = decodeFrame(maskFrame(0x1, 'a').subarray(0, 3));
  check('不完整帧返回 null 等待更多数据', dec === null);
}
{
  // 未加掩码的客户端帧必须被拒绝
  const raw = Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi')]);
  const dec = decodeFrame(raw);
  check('拒绝缺少掩码的客户端帧', !!(dec && dec.error), dec && dec.error);
}
{
  const dec = decodeFrame(Buffer.concat([Buffer.from([0x91, 0x80]), Buffer.from([0, 0, 0, 0])]));
  check('拒绝分片的控制帧', !!(dec && dec.error), dec && dec.error);
}
{
  check('sanitizeName 去控制字符并截断', sanitizeName('  a\u0001b  ') === 'ab' && sanitizeName('x'.repeat(40)).length === 16);
}

// ---------------------------------------------------------------- 1b. 直连地址解析

section('1b. 服务器地址解析（公网直连）');

{
  const eq = (name, input, expect, opts) => {
    const r = parseServerAddress(input, opts);
    const got = r.ok
      ? { host: r.host, port: r.port, room: r.room, secure: r.secure, ws: r.wsUrl, http: r.httpUrl }
      : { error: r.error };
    check(name, JSON.stringify(got) === JSON.stringify(expect), `得到 ${JSON.stringify(got)}`);
  };

  eq('裸 IP 补默认端口',
    '1.2.3.4',
    { host: '1.2.3.4', port: DEFAULT_SERVER_PORT, room: '', secure: false,
      ws: `ws://1.2.3.4:${DEFAULT_SERVER_PORT}/ws`, http: `http://1.2.3.4:${DEFAULT_SERVER_PORT}` });

  eq('IP:端口',
    '192.168.1.5:19000',
    { host: '192.168.1.5', port: 19000, room: '', secure: false,
      ws: 'ws://192.168.1.5:19000/ws', http: 'http://192.168.1.5:19000' });

  eq('域名',
    'game.example.com',
    { host: 'game.example.com', port: DEFAULT_SERVER_PORT, room: '', secure: false,
      ws: `ws://game.example.com:${DEFAULT_SERVER_PORT}/ws`,
      http: `http://game.example.com:${DEFAULT_SERVER_PORT}` });

  eq('显式 ws:// 且带 /ws 路径不重复追加',
    'ws://1.2.3.4:18200/ws',
    { host: '1.2.3.4', port: 18200, room: '', secure: false,
      ws: 'ws://1.2.3.4:18200/ws', http: 'http://1.2.3.4:18200' });

  eq('https 升级为 wss 并保留子路径',
    'https://example.com/ironfall',
    { host: 'example.com', port: DEFAULT_SERVER_PORT, room: '', secure: true,
      ws: `wss://example.com:${DEFAULT_SERVER_PORT}/ironfall/ws`,
      http: `https://example.com:${DEFAULT_SERVER_PORT}/ironfall` });

  eq('# 后缀指定房间',
    '1.2.3.4:18200#raiders',
    { host: '1.2.3.4', port: 18200, room: 'raiders', secure: false,
      ws: 'ws://1.2.3.4:18200/ws', http: 'http://1.2.3.4:18200' });

  eq('IPv6 字面量',
    '[fe80::1]:18200',
    { host: 'fe80::1', port: 18200, room: '', secure: false,
      ws: 'ws://[fe80::1]:18200/ws', http: 'http://[fe80::1]:18200' });

  eq('HTTPS 页面里裸地址默认走 wss',
    'game.example.com',
    { host: 'game.example.com', port: DEFAULT_SERVER_PORT, room: '', secure: true,
      ws: `wss://game.example.com:${DEFAULT_SERVER_PORT}/ws`,
      http: `https://game.example.com:${DEFAULT_SERVER_PORT}` },
    { secure: true });

  {
    // HTTPS 页面里没写协议的裸地址：默认按 wss 试（对方可能真有 TLS），
    // 只在结果上标一个风险位，让连接失败时能补一句可读的提示。
    const r = parseServerAddress('1.2.3.4:18200', { secure: true });
    check('HTTPS 页面里裸地址默认走 wss 并标出混内容风险',
      r.ok === true && r.secure === true && r.mixedContentRisk === true
        && r.wsUrl.startsWith('wss://'), JSON.stringify(r));
  }
  {
    const r = parseServerAddress('ws://1.2.3.4:18200', { secure: true });
    check('HTTPS 页面里显式 ws:// 被明确拒绝并给出可读原因',
      r.ok === false && r.mixedContent === true && /HTTPS/.test(r.error), JSON.stringify(r));
  }
  {
    const forced = parseServerAddress('wss://1.2.3.4:18200', { secure: true });
    check('显式 wss 在 HTTPS 页面下放行且无风险位',
      forced.ok === true && forced.mixedContentRisk === false, JSON.stringify(forced));
  }
  {
    const cases = [
      ['', '空输入'], ['   ', '空白输入'], [':18200', '只有端口'], ['1.2.3.4:0', '端口 0'],
      ['1.2.3.4:99999', '端口越界'], ['1.2.3.4:abc', '端口非数字'], ['[fe80::1', 'IPv6 缺 ]'],
      ['1.2.3.4:', '冒号后为空'], ['http://', '只有协议'],
    ];
    const bad = cases.filter(([input]) => parseServerAddress(input).ok !== false);
    check('非法地址全部被拒', bad.length === 0, bad.map(([i, n]) => `${n}(${i})`).join(', '));
  }
  {
    // 不带方括号的 IPv6 也应当被认出来，而不是当成 host:port 切开
    const r = parseServerAddress('fe80::1');
    check('无方括号 IPv6 也按字面量处理',
      r.ok === true && r.host === 'fe80::1' && r.wsUrl.startsWith('ws://[fe80::1]:'), JSON.stringify(r));
  }
}

// ---------------------------------------------------------------- 2. 房间与中继

section('2. 房间、房主与消息中继');

const PORT = 18973 + Math.floor(Math.random() * 200);
const server = createLanServer({ port: PORT, host: '127.0.0.1' });
const address = await server.listen();
check('服务器监听成功', !!address && address.port === PORT, JSON.stringify(address));

const clients = [];
function connect(name, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const state = { ws, name, messages: [], inbox: [], byType: new Map(), closed: false, closeCode: 0 };
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      state.messages.push(msg);
      if (msg && msg.t) {
        if (!state.byType.has(msg.t)) state.byType.set(msg.t, []);
        state.byType.get(msg.t).push(msg);
      }
    });
    ws.addEventListener('close', (ev) => { state.closed = true; state.closeCode = ev.code; });
    ws.addEventListener('error', () => { /* 断言由超时兜底 */ });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        t: 'hello',
        name,
        version: opts.version === undefined ? 'test' : opts.version,
        room: opts.room || 'r1',
      }));
      resolvePromise(state);
    });
    setTimeout(() => reject(new Error('连接超时: ' + name)), 3000);
  });
}

function last(state, type) {
  const arr = state.byType.get(type);
  return arr && arr.length ? arr[arr.length - 1] : null;
}

try {
  const a = await connect('主机甲');
  const welcomeA = await waitFor(() => last(a, 'welcome'), 2500, 'A welcome');
  check('第一位加入者成为房主', welcomeA.isHost === true && welcomeA.hostId === welcomeA.selfId);
  check('welcome 带房间 id 与上限', welcomeA.room === 'r1' && welcomeA.maxPeers === 4);
  clients.push(a);

  const b = await connect('乙');
  const welcomeB = await waitFor(() => last(b, 'welcome'), 2500, 'B welcome');
  clients.push(b);
  check('第二位加入者不是房主', welcomeB.isHost === false && welcomeB.hostId === welcomeA.selfId);
  check('welcome 名册含两名玩家', welcomeB.peers.length === 2, JSON.stringify(welcomeB.peers.map((p) => p.name)));

  const rosterA = await waitFor(() => {
    const r = last(a, 'roster');
    return r && r.peers.length === 2 ? r : null;
  }, 2500, 'A 收到两人名册');
  check('房主收到成员变更名册', rosterA.peers.filter((p) => p.isHost).length === 1);

  // 游戏消息中继：A → B（且不回给 A 自己）
  a.ws.send(JSON.stringify({ t: 'game', data: { k: 'snapshot', v: 7 } }));
  const relayed = await waitFor(() => last(b, 'game'), 2500, 'B 收到 game');
  check('游戏消息带发送者转发到其他成员', relayed.from === welcomeA.selfId && relayed.data.v === 7);
  await sleep(120);
  check('游戏消息不回传给发送者', last(a, 'game') === null);

  // 聊天广播
  b.ws.send(JSON.stringify({ t: 'chat', text: '你好' }));
  const chat = await waitFor(() => last(a, 'chat'), 2500, 'A 收到 chat');
  check('聊天广播带名字与文本', chat.text === '你好' && chat.name === '乙');

  // ping/pong 往返
  a.ws.send(JSON.stringify({ t: 'ping', id: 42 }));
  const pong = await waitFor(() => last(a, 'pong'), 2500, 'pong');
  check('ping 收到 pong 且 id 一致', pong.id === 42 && Number.isFinite(pong.time));

  // 房主离开 → 房主转移
  a.ws.close(1000, 'bye');
  await waitFor(() => a.closed, 2500, 'A 关闭');
  const rosterAfter = await waitFor(() => {
    const r = last(b, 'roster');
    return r && r.peers.length === 1 ? r : null;
  }, 2500, 'B 收到单人新名册');
  check('房主离开后房主转移给剩余成员', rosterAfter.hostId === welcomeB.selfId
    && rosterAfter.peers[0].isHost === true);
  const leftEvent = last(b, 'peer_left');
  check('剩余成员收到 peer_left', !!leftEvent && leftEvent.id === welcomeA.selfId);

  // 房间满员
  const extra = [];
  for (let i = 0; i < 3; i++) extra.push(await connect('路人' + i));
  clients.push(...extra);
  await sleep(150);
  const overflow = await connect('多余');
  clients.push(overflow);
  const err = await waitFor(() => last(overflow, 'error'), 2500, '满员错误');
  check('房间满员时拒绝第 5 位玩家', err.code === 'room_full', JSON.stringify(err));

  // HTTP 状态端点
  const status = await fetch(`http://127.0.0.1:${PORT}/lan/status`).then((r) => r.json());
  check('/lan/status 返回局域网标志', status.ok === true && status.lan === true && Array.isArray(status.rooms));

  // 静态站点
  const page = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  check('静态站点返回 index.html', page.includes('<title>IRONFALL'));
  const js = await fetch(`http://127.0.0.1:${PORT}/src/main.js`);
  check('静态站点返回游戏源码', js.status === 200
    && String(js.headers.get('content-type')).includes('javascript'));
  const missing = await fetch(`http://127.0.0.1:${PORT}/nope.js`);
  check('未知文件返回 404', missing.status === 404);

  // 目录穿越防护
  const traversal = await fetch(`http://127.0.0.1:${PORT}/../package.json`).then((r) => r.status).catch(() => 0);
  check('拒绝目录穿越', traversal === 404 || traversal === 403, String(traversal));

  // 大消息（模拟快照）聚合帧
  if (!b.closed) {    const payload = { t: 'game', data: { k: 'big', blob: 'x'.repeat(70000) } };
    b.ws.send(JSON.stringify(payload));
    const big = await waitFor(() => (last(extra[0], 'game') || {}), 3000, '聚合帧转发');
    const got = await waitFor(() => {
      const g = last(extra[0], 'game');
      return g && g.data && g.data.k === 'big' ? g : null;
    }, 3000, '大消息转发');
    void big;
    check('70 KB 消息完整转发', got.data.blob.length === 70000);
  }

  // 协议版本闸门：公网直连时客户端版本可能不一致，必须在握手阶段就明确拒绝，
  // 而不是让它连上之后“什么都不同步”。
  const otherRoom = await connect('异版本', { version: '999', room: 'r2' });
  clients.push(otherRoom);
  const okWelcome = await waitFor(() => last(otherRoom, 'welcome'), 2500, 'r2 welcome');
  check('新房间的第一个客户端定下版本并正常入房', !!okWelcome);

  const mismatch = await connect('旧版本', { version: '0.9', room: 'r2' });
  clients.push(mismatch);
  const verr = await waitFor(() => last(mismatch, 'error'), 2500, 'version mismatch');
  check('版本不一致被服务器拒绝', verr.code === 'version_mismatch', JSON.stringify(verr));
  check('拒绝原因里带上了两边的版本号',
    /999/.test(verr.message) && /0\.9/.test(verr.message), verr.message);
  await waitFor(() => mismatch.closed, 2500, 'mismatch closed');
  check('被拒客户端连接已关闭且关闭码可识别', mismatch.closeCode === 4002, String(mismatch.closeCode));
} catch (err) {
  check('房间测试整体执行', false, err && err.message);
} finally {
  for (const c of clients) { try { c.ws.close(); } catch (_e) { /* 忽略 */ } }
  await server.close();
}

// ---------------------------------------------------------------- 汇总

process.stdout.write(`\n${'─'.repeat(52)}\n`);
if (fail === 0) {
  process.stdout.write(`局域网服务器自测通过：${pass}/${pass}\n`);
  process.exit(0);
} else {
  process.stdout.write(`局域网服务器自测失败：${pass} 通过 / ${fail} 失败\n`);
  for (const f of failures) process.stdout.write(`  · ${f}\n`);
  process.exit(1);
}
