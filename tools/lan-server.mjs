// ==== tools/lan-server.mjs — 零依赖局域网服务器（静态站点 + WebSocket 房间中继）====
//
// 与 tools/serve.mjs 的区别：绑定 0.0.0.0 让同网段其他机器能访问，并在同一个
// 端口上提供 /ws 的 WebSocket 升级端点。
//
// 设计取舍：本服务器**不做游戏模拟**，只做三件事
//   1. 提供静态站点（同 serve.mjs，禁用缓存）；
//   2. 维护房间成员表，选出一个 host（第一位加入者）；
//   3. 在房间内转发游戏消息。
// 真正的权威模拟跑在 host 的浏览器里（listen server），这样网络层不需要把
// world/enemies/player 的全部逻辑再搬到 Node 里重写一遍。
//
// 用法:
//   node tools/lan-server.mjs [port] [--open] [--host 0.0.0.0]
// 默认端口 18200；--open 会顺便打开本机的无边框游戏窗口。

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- 常量

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 4 * 1024 * 1024;     // 单帧上限 4 MiB（快照远小于此）
const MAX_BUFFERED = 512 * 1024;       // 发送队列超过此值就丢弃“可丢”消息
const MAX_PEERS_PER_ROOM = 4;
const HEARTBEAT_MS = 5000;
const PEER_TIMEOUT_MS = 20000;
const MAX_NAME_LEN = 16;
const DEFAULT_PORT = 18200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- WebSocket 帧编解码

/** 计算 Sec-WebSocket-Accept */
export function wsAccept(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/**
 * 编码一个服务端 → 客户端的帧（服务端帧不加掩码）。
 * @param {number} opcode 0x1 文本 / 0x2 二进制 / 0x8 关闭 / 0x9 ping / 0xA pong
 * @param {Buffer} payload
 */
export function encodeFrame(opcode, payload) {
  const body = payload || Buffer.alloc(0);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body], header.length + len);
}

/**
 * 解析缓冲区里的第一帧。
 * @returns {null|{fin:boolean,opcode:number,payload:Buffer,rest:Buffer,error?:string,code?:number}}
 */
export function decodeFrame(buf) {
  if (!buf || buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (rsv !== 0) return { error: 'RSV 位非零', code: 1002, rest: buf };
  if (opcode >= 0x8) {
    if (!fin) return { error: '控制帧不得分片', code: 1002, rest: buf };
    if (len > 125) return { error: '控制帧过长', code: 1002, rest: buf };
  }
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    if (hi !== 0) return { error: '帧超过 4 GiB', code: 1009, rest: buf };
    len = lo;
    off += 8;
  }
  if (len > MAX_FRAME) return { error: '帧超过上限', code: 1009, rest: buf };
  // RFC 6455：客户端 → 服务端的帧必须加掩码
  if (!masked) return { error: '客户端帧缺少掩码', code: 1002, rest: buf };
  if (buf.length < off + 4 + len) return null;

  const mask = buf.subarray(off, off + 4);
  off += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
  off += len;
  return { fin, opcode, payload, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- WebSocket 连接

export class WsSocket {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id || randomUUID();
    this.open = true;
    this.closed = false;
    this.onMessage = null;     // (string|Buffer, isBinary) => void
    this.onClose = null;       // (code, reason) => void
    this.lastSeen = Date.now();
    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._fragParts = null;
    this._fragBytes = 0;
    this._closeSent = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish(1006, 'socket error'));
    socket.on('close', () => this._finish(1006, 'socket closed'));
  }

  get bufferedAmount() {
    try { return this.socket.writableLength || 0; } catch (_e) { return 0; }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    if (this._buf.length > MAX_FRAME + 1024) {
      this.close(1009, '缓冲区溢出');
      return;
    }
    for (;;) {
      const frame = decodeFrame(this._buf);
      if (frame === null) return;
      this._buf = frame.rest;
      if (frame.error) { this.close(frame.code || 1002, frame.error); return; }
      if (!this._handleFrame(frame)) return;
      if (this.closed) return;
    }
  }

  /** @returns {boolean} 是否继续解析后续帧 */
  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === 0x8) {                      // close
      this._finish(1000, 'peer close');
      if (!this._closeSent) this._raw(0x8, payload.subarray(0, 2));
      try { this.socket.end(); } catch (_e) { /* 忽略 */ }
      return false;
    }
    if (opcode === 0x9) { this._raw(0xA, payload); return true; }   // ping → pong
    if (opcode === 0xA) return true;                                 // pong
    if (opcode === 0x0) {                                            // continuation
      if (!this._fragParts) { this.close(1002, '意外的续帧'); return false; }
      this._fragBytes += payload.length;
      if (this._fragBytes > MAX_FRAME) { this.close(1009, '分片过大'); return false; }
      this._fragParts.push(payload);
      if (fin) this._deliverFragmented();
      return true;
    }
    if (opcode !== 0x1 && opcode !== 0x2) { this.close(1002, '未知 opcode'); return false; }
    if (this._fragParts) { this.close(1002, '分片期间收到新数据帧'); return false; }
    if (!fin) {
      this._fragOp = opcode;
      this._fragParts = [payload];
      this._fragBytes = payload.length;
      return true;
    }
    this._deliver(opcode, payload);
    return true;
  }

  _deliverFragmented() {
    const op = this._fragOp;
    const whole = Buffer.concat(this._fragParts, this._fragBytes);
    this._fragParts = null;
    this._fragOp = 0;
    this._fragBytes = 0;
    this._deliver(op, whole);
  }

  _deliver(opcode, payload) {
    if (!this.onMessage) return;
    const isBinary = opcode === 0x2;
    this.onMessage(isBinary ? payload : payload.toString('utf8'), isBinary);
  }

  _raw(opcode, payload) {
    if (!this.open) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch (_e) {
      this._finish(1006, '写入失败');
      return false;
    }
  }

  sendText(text, opts) {
    if (!this.open) return false;
    const droppable = !!(opts && opts.droppable);
    if (droppable && this.bufferedAmount > MAX_BUFFERED) return false;
    return this._raw(0x1, Buffer.from(String(text), 'utf8'));
  }

  sendJson(obj, opts) {
    return this.sendText(JSON.stringify(obj), opts);
  }

  ping() {
    return this._raw(0x9, Buffer.alloc(0));
  }

  close(code, reason) {
    if (this.closed) return;
    this._closeSent = true;
    const text = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + text.length);
    payload.writeUInt16BE(code || 1000, 0);
    text.copy(payload, 2);
    this._raw(0x8, payload);
    this._finish(code || 1000, reason || '');
    try { this.socket.end(); } catch (_e) { /* 忽略 */ }
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      try { cb(code || 1000, reason || ''); } catch (_e) { /* 忽略 */ }
    }
  }

  destroy() {
    this._finish(1006, 'destroy');
    try { this.socket.destroy(); } catch (_e) { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------- HTTP 升级握手

/**
 * 处理 /ws 升级。返回 false 表示这不是一个合法的 WebSocket 请求（已回复错误）。
 */
export function upgradeToWebSocket(req, socket, head, handlers) {
  const key = req.headers['sec-websocket-key'];
  const version = Number(req.headers['sec-websocket-version']);
  if (!key || version !== 13) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(key)}`,
    '\r\n',
  ].join('\r\n'));
  socket.setNoDelay(true);
  const ws = new WsSocket(socket);
  if (head && head.length) ws._onData(head);
  if (handlers && handlers.onOpen) handlers.onOpen(ws, req);
  return ws;
}

// ---------------------------------------------------------------- 房间

export class Room {
  constructor(id) {
    this.id = id;
    this.peers = new Map();     // id -> peer
    this.hostId = null;
    this.createdAt = Date.now();
  }

  get size() { return this.peers.size; }

  add(peer) {
    this.peers.set(peer.id, peer);
    peer.room = this;
    if (!this.hostId || !this.peers.has(this.hostId)) this.hostId = peer.id;
    peer.isHost = peer.id === this.hostId;
  }

  remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    this.peers.delete(id);
    if (this.hostId === id) {
      // 房主离开：把房主让给最早加入的剩余成员，而不是让房间失去权威。
      const rest = [...this.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      this.hostId = rest.length ? rest[0].id : null;
      if (rest.length) rest[0].isHost = true;
    }
    for (const p of this.peers.values()) p.isHost = p.id === this.hostId;
    return peer;
  }

  roster() {
    return [...this.peers.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.id === this.hostId,
        ready: !!p.ready,
        inGame: !!p.inGame,
        ping: p.ping || 0,
        joinedAt: p.joinedAt,
      }));
  }

  broadcast(msg, exceptId, opts) {
    const text = JSON.stringify(msg);
    for (const p of this.peers.values()) {
      if (exceptId && p.id === exceptId) continue;
      p.ws.sendText(text, opts);
    }
  }

  sendRoster() {
    this.broadcast({ t: 'roster', hostId: this.hostId, peers: this.roster() });
  }
}

// ---------------------------------------------------------------- 服务器

export function sanitizeName(raw, fallback) {
  let name = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (!name) name = fallback || '玩家';
  if (name.length > MAX_NAME_LEN) name = name.slice(0, MAX_NAME_LEN);
  return name;
}

export function createLanServer(opts = {}) {
  const port = Number(opts.port || DEFAULT_PORT);
  const host = opts.host || '0.0.0.0';
  const rooms = new Map();
  const allPeers = new Set();
  let nextPlayerNumber = 1;
  let nextPeerId = 1;

  function peerId() {
    // 短 id：既好读又足够避免同房间冲突
    return 'p' + (nextPeerId++).toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function roomFor(id) {
    let room = rooms.get(id);
    if (!room) { room = new Room(id); rooms.set(id, room); }
    return room;
  }

  function cleanupRoom(room) {
    if (room.size === 0) rooms.delete(room.id);
  }

  function handleHello(peer, msg) {
    if (peer.joined) {
      peer.ws.sendJson({ t: 'error', code: 'already_joined', message: '已经在房间中' });
      return;
    }
    const roomId = String(msg.room || 'default').slice(0, 32) || 'default';
    const room = roomFor(roomId);
    if (room.size >= MAX_PEERS_PER_ROOM) {
      peer.ws.sendJson({ t: 'error', code: 'room_full', message: `房间已满（上限 ${MAX_PEERS_PER_ROOM} 人）` });
      peer.ws.close(4000, 'room full');
      return;
    }

    // 协议版本闸门。局域网里大家用的是同一份代码，公网直连却不是：一个旧客户端
    // 连上来后能握手成功，但字段对不上，表现是“连上了但什么都不同步”，极难排查。
    // 这里直接按房间内第一个人定版，不一致就明确拒绝。
    const version = String(msg.version || '');
    const existing = [...room.peers.values()].find((p) => p.version);
    if (existing && version && existing.version !== version) {
      peer.ws.sendJson({
        t: 'error',
        code: 'version_mismatch',
        message: `协议版本不一致：服务器上是 v${existing.version}，你是 v${version}。请把游戏更新到同一版本。`,
      });
      peer.ws.close(4002, 'protocol version mismatch');
      if (opts.log) opts.log(`拒绝 ${msg.name || '未知玩家'}：协议 v${version} ≠ 房间 v${existing.version}`);
      return;
    }

    const sameName = [...room.peers.values()].some((p) => p.name === sanitizeName(msg.name, ''));
    peer.id = peerId();
    peer.name = sanitizeName(msg.name, `玩家${nextPlayerNumber}`);
    if (sameName) peer.name = peer.name.slice(0, MAX_NAME_LEN - 2) + '·2';
    nextPlayerNumber++;
    peer.version = version;
    peer.joined = true;
    peer.joinedAt = Date.now();
    room.add(peer);

    peer.ws.sendJson({
      t: 'welcome',
      selfId: peer.id,
      room: room.id,
      hostId: room.hostId,
      isHost: peer.id === room.hostId,
      maxPeers: MAX_PEERS_PER_ROOM,
      peers: room.roster(),
      serverTime: Date.now(),
    });
    room.sendRoster();
    if (opts.log) opts.log(`加入 ${peer.name}（${peer.id}）→ 房间 ${room.id}，共 ${room.size} 人`);
  }

  function handleMessage(peer, raw, isBinary) {
    if (isBinary) return;   // 协议当前只用文本 JSON；二进制帧直接忽略
    let msg;
    try { msg = JSON.parse(raw); } catch (_e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const type = msg.t;

    if (type === 'hello') { handleHello(peer, msg); return; }

    const room = peer.room;
    if (!peer.joined || !room) {
      peer.ws.sendJson({ t: 'error', code: 'not_joined', message: '请先发送 hello' });
      return;
    }

    switch (type) {
      case 'game':
        // 游戏消息对服务器不透明；带上发送者与时间戳后转发给房间其他人。
        room.broadcast({
          t: 'game',
          from: peer.id,
          name: peer.name,
          data: msg.data,
        }, peer.id, { droppable: msg.droppable !== false });
        break;
      case 'chat':
        room.broadcast({
          t: 'chat',
          from: peer.id,
          name: peer.name,
          text: String(msg.text == null ? '' : msg.text).slice(0, 200),
          time: Date.now(),
        });
        break;
      case 'ping':
        peer.ws.sendJson({ t: 'pong', id: msg.id, time: Date.now() });
        break;
      case 'state':
        peer.ready = !!msg.ready;
        if (typeof msg.inGame === 'boolean') peer.inGame = msg.inGame;
        if (Number.isFinite(msg.ping)) peer.ping = Math.max(0, Math.round(msg.ping));
        room.sendRoster();
        break;
      case 'claim_host': {
        // 只有房主位空出来时才允许抢占，避免两个 host 同时广播权威快照。
        if (!room.hostId || !room.peers.has(room.hostId)) {
          room.hostId = peer.id;
          for (const p of room.peers.values()) p.isHost = p.id === room.hostId;
          room.sendRoster();
        }
        break;
      }
      case 'bye':
        peer.ws.close(1000, 'bye');
        break;
      default:
        break;
    }
  }

  function handleClose(peer) {
    allPeers.delete(peer);
    const room = peer.room;
    if (!room) return;
    room.remove(peer.id);
    if (opts.log && peer.joined) opts.log(`离开 ${peer.name}（${peer.id}）；剩余 ${room.size} 人`);
    if (room.size > 0) {
      room.broadcast({ t: 'peer_left', id: peer.id, name: peer.name });
      room.sendRoster();
    } else {
      cleanupRoom(room);
    }
    peer.room = null;
  }

  const httpServer = createServer(async (req, res) => {
    const url = req.url || '/';
    const path = url.split('?')[0];

    // 供客户端探测“当前页面由局域网服务器提供”
    if (path === '/lan/status') {
      const body = JSON.stringify({
        ok: true,
        lan: true,
        port,
        rooms: [...rooms.values()].map((r) => ({ id: r.id, size: r.size, hostId: r.hostId })),
        peers: allPeers.size,
        time: Date.now(),
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(body);
      return;
    }

    try {
      const target = safeJoin(ROOT, path);
      if (!target) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('403 越界访问');
        return;
      }
      let info = await stat(target).catch(() => null);
      let file = target;
      if (info && info.isDirectory()) {
        file = join(target, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 未找到: ' + url);
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 ' + (err && err.message));
    }
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    if (path !== '/ws' && path !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const peer = {
      id: null,
      name: null,
      ws: null,
      room: null,
      isHost: false,
      ready: false,
      inGame: false,
      ping: 0,
      joined: false,
      joinedAt: Date.now(),
      version: '',
    };
    const ws = upgradeToWebSocket(req, socket, head, {});
    if (!ws) return;
    peer.ws = ws;
    ws.id = 'sock' + nextPeerId;
    allPeers.add(peer);
    ws.onMessage = (text, isBinary) => handleMessage(peer, text, isBinary);
    ws.onClose = () => handleClose(peer);
  });

  // 心跳：清掉半开连接（拔网线/休眠），否则房间里会留下永远不动的人。
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const peer of [...allPeers]) {
      if (!peer.ws || peer.ws.closed) continue;
      if (now - peer.ws.lastSeen > PEER_TIMEOUT_MS) {
        peer.ws.close(4001, '心跳超时');
        continue;
      }
      peer.ws.ping();
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  return {
    httpServer,
    rooms,
    peers: allPeers,
    port,
    host,
    listen() {
      return new Promise((resolvePromise, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', reject);
          resolvePromise(httpServer.address());
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const peer of [...allPeers]) peer.ws.destroy();
      allPeers.clear();
      rooms.clear();
      return new Promise((r) => httpServer.close(() => r()));
    },
    stats() {
      return {
        rooms: [...rooms.values()].map((r) => ({ id: r.id, size: r.size, hostId: r.hostId })),
        peers: allPeers.size,
      };
    },
  };
}

function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (_e) { return null; }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

// ---------------------------------------------------------------- 本机局域网地址

export function lanAddresses(port) {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ iface: name, address: info.address, url: `http://${info.address}:${port}/` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function isMain() {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (_e) { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const flagIndex = argv.findIndex((a) => /^\d+$/.test(a));
  const port = flagIndex >= 0 ? Number(argv[flagIndex]) : Number(process.env.IRONFALL_LAN_PORT || DEFAULT_PORT);
  const hostIdx = argv.indexOf('--host');
  const host = hostIdx >= 0 ? String(argv[hostIdx + 1] || '0.0.0.0') : '0.0.0.0';
  const wantOpen = argv.includes('--open');

  const server = createLanServer({
    port,
    host,
    log: (m) => process.stdout.write(`[LAN] ${m}\n`),
  });

  try {
    await server.listen();
  } catch (err) {
    process.stderr.write(`局域网服务器启动失败：${err && err.message}\n`);
    process.exit(1);
  }

  process.stdout.write('IRONFALL 局域网服务器已启动\n');
  process.stdout.write(`  本机:   http://127.0.0.1:${port}/\n`);
  const addrs = lanAddresses(port);
  if (addrs.length === 0) {
    process.stdout.write('  局域网: 未检测到可用的局域网 IPv4 地址\n');
  } else {
    for (const a of addrs) process.stdout.write(`  局域网: ${a.url}   （${a.iface}）\n`);
  }
  process.stdout.write('把上面的“局域网”地址发给同网段的朋友，他们用 Chrome/Edge 打开即可加入。\n');
  process.stdout.write('按 Ctrl+C 停止\n');

  if (wantOpen) {
    const { spawn } = await import('node:child_process');
    const launcher = join(ROOT, 'tools', 'launch-app.mjs');
    const child = spawn(process.execPath, [launcher], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, IRONFALL_PORT: String(port) },
    });
    child.unref();
  }

  const shutdown = () => {
    process.stdout.write('\n正在关闭…\n');
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
