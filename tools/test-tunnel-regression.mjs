import assert from 'node:assert/strict';
import { parseServerAddress } from '../src/net/protocol.js';
import { NetTransport } from '../src/net/transport.js';
assert.equal(parseServerAddress('https://tunnel.example').port, 443);
assert.equal(parseServerAddress('http://tunnel.example').port, 80);
assert.equal(parseServerAddress('tunnel.example:23456').port, 23456);
assert.equal(parseServerAddress('https://tunnel.example/game').wsUrl, 'wss://tunnel.example:443/game/ws');
const sockets = [];
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; sockets.push(this); }
  close() { this.readyState = 3; }
  send() {}
};
const t = new NetTransport({ url: 'ws://example/ws', timeoutMs: 20, autoReconnect: false });
await assert.rejects(t.connect(), /超时/);
assert.equal(sockets[0].readyState, 3);
const first = t.connect().catch(e => e.message);
const second = t.connect().catch(e => e.message);
assert.equal(await first, '重新连接');
sockets[1].onclose({ code: 1006 });
assert.equal(t._ws, sockets[2]);
t.disconnect('退出');
assert.equal(await second, '退出');
assert.equal(t._connectTimer, 0);
console.log('PASS: tunnel ports, connection timeout, stale socket isolation, cancellation');
