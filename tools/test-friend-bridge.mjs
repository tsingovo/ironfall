// Opt-in live check against the host-specific dist config. Uses an isolated room.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFriendBridge } from './friend-bridge.mjs';

function peer(base, room) {
  let socket;
  const messages = [];
  const waiters = new Set();
  const req = http.request(new URL('/ws', base), { headers: {
    host: base.host, origin: base.origin, connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13',
  } });
  function send(message) {
    const data = Buffer.from(JSON.stringify(message));
    assert(data.length < 126);
    const mask = randomBytes(4);
    const out = Buffer.alloc(6 + data.length);
    out[0] = 0x81; out[1] = 0x80 | data.length; mask.copy(out, 2);
    for (let i = 0; i < data.length; i++) out[6 + i] = data[i] ^ mask[i % 4];
    socket.write(out);
  }
  req.on('upgrade', (_, s, head) => {
    socket = s;
    let buf = Buffer.alloc(0);
    function parse(chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 15;
        let len = buf[1] & 127, start = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); start = 4; }
        if (len === 127) throw new Error('unexpected giant frame');
        if (buf.length < start + len) return;
        const payload = buf.subarray(start, start + len);
        buf = buf.subarray(start + len);
        if (opcode === 1) {
          messages.push(JSON.parse(payload));
          for (const f of waiters) f();
        }
      }
    }
    s.on('data', parse); s.on('error', () => {});
    if (head.length) parse(head);
    send({ t: 'hello', name: 'bridge-check', room, version: '1' });
  });
  let error;
  req.on('error', e => { error = e; });
  req.on('response', r => { error = new Error('upgrade HTTP ' + r.statusCode); r.resume(); });
  req.end();
  return {
    send,
    wait: (fn) => new Promise((resolve, reject) => {
      const check = () => {
        const msg = messages.find(fn);
        if (msg) { clearTimeout(timer); waiters.delete(check); resolve(msg); }
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(error || new Error('WS wait timeout')); }, 15000);
      waiters.add(check); check();
    }),
    close: () => { socket?.destroy(); req.destroy(); },
  };
}

const config = JSON.parse(await readFile('dist/friend-server.json', 'utf8'));
const bridge = createFriendBridge({ ...config, ca: await readFile('dist/friend-server.crt'), html: '<title>test</title>' });
const base = await bridge.listen();
const clients = [];
try {
  const status = await (await fetch(new URL('/lan/status', base))).json();
  assert.equal(status.lan, true);
  const room = 'check-' + randomBytes(5).toString('hex');
  const a = peer(base, room); clients.push(a);
  const first = await a.wait(m => m.t === 'welcome');
  const b = peer(base, room); clients.push(b);
  const second = await b.wait(m => m.t === 'welcome');
  assert.notEqual(first.selfId, second.selfId);
  assert.equal(first.room, second.room);
  a.send({ t: 'chat', text: 'bridge-round-trip' });
  await b.wait(m => m.t === 'chat' && m.text === 'bridge-round-trip');
  console.log('PASS: strict TLS, tunnel HTTP status, two WS peers join same isolated room, chat forwarded');
} finally {
  for (const c of clients) c.close();
  await bridge.close();
}
