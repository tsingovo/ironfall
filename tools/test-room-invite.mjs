import assert from 'node:assert/strict';
import http from 'node:http';
import { validateInvite } from './room-invite.mjs';
import { createFriendBridge } from './friend-bridge.mjs';
import { createLanServer } from './lan-server.mjs';

const v = (patch) => validateInvite({ format: 'ironfall-room-v1', endpoint: 'http://example.com:12345', ...patch });
assert.equal(v({}).room, 'default');
assert.equal(v({ room: '朋友-2' }).room, '朋友-2');
assert.equal(v({endpoint:'https://example.com:12345'}).endpoint,'https://example.com:12345');
assert.throws(() => v({endpoint:'http://user:password@example.com'}));
assert.throws(() => v({endpoint:'file:///C:/test'}));
assert.throws(() => v({room:'bad/room'}));
assert.throws(() => v({endpoint:'https://example.com',certificate:'-----BEGIN PRIVATE KEY-----'}));
assert.throws(() => v({certificate:'bad certificate'}));
const server = createLanServer({ port: 0, host: '127.0.0.1' });
const address = await server.listen();
const bridge = createFriendBridge({endpoint:`http://127.0.0.1:${address.port}`,html:'<title>test</title>'});
try {
  const base = await bridge.listen();
  const state = await (await fetch(new URL('/lan/status',base))).json();
  assert.equal(state.ok,true); assert.equal(state.lan,true);
  assert.equal((await fetch(new URL('/tools/friend-server.crt',base))).status,404);
  const blocked = await new Promise((resolve, reject) => {
    http.get(base, { headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(blocked,403);
  console.log('PASS: portable invite validation, strict schema, local HTTP relay, private-path/Host protection');
} finally { await bridge.close(); await server.close(); }
