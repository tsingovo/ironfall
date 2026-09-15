import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalRoomControl } from './local-room-control.mjs';

// Ephemeral ports: never touch a player's live 18200 room.
const control = createLocalRoomControl({ hostPort: 0 });
const server = http.createServer(async (req, res) => {
  if (!await control.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const post = (route, data, source = origin) => fetch(origin + '/__room/' + route, {
  method: 'POST', headers: { origin: source, 'content-type': 'application/json' }, body: JSON.stringify(data),
});
try {
  assert.equal((await post('host', {}, 'https://evil.example')).status, 403);
  assert.equal((await fetch(origin + '/__room/host')).status, 403);
  const hosted = await (await post('host', { room: '朋友' })).json();
  assert.ok(hosted.address.endsWith('#朋友'));
  const again = await (await post('host', { room: '朋友' })).json();
  assert.equal(again.address, hosted.address);
  const invite = { format: 'ironfall-room-v1', endpoint: hosted.address.split('#')[0], room: '朋友' };
  assert.equal((await post('export', { ...invite, certificate: 'PRIVATE KEY' })).status, 400);
  assert.equal((await post('export', invite)).status, 200);
  const joined = await (await post('join', invite)).json();
  assert.ok(joined.address, JSON.stringify(joined));
  const base = joined.address.split('#')[0];
  const status = await fetch(base + '/lan/status', { headers: { origin } });
  assert.equal(status.headers.get('access-control-allow-origin'), origin);
  assert.equal((await status.json()).lan, true);
  const upgrade = source => new Promise((resolve, reject) => {
    const req = http.get(base + '/ws', { headers: { origin: source, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(await upgrade(origin), 101);
  assert.equal(await upgrade('https://evil.example'), 403);
  console.log('PASS local room: automatic host, reuse, invite export/import, page-origin WebSocket, CORS, unauthorized rejection');
} finally {
  await control.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
