// Fixed-target HTTPS/WSS bridge. Trust only the host-supplied public certificate;
// never disables TLS verification or installs a system/browser root certificate.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function createFriendBridge({ endpoint, ca, html, allowedOrigin }) {
  const target = new URL(endpoint);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash)
    throw new Error('连接目标必须是无凭据的 HTTP/HTTPS 地址');
  if (ca && target.protocol !== 'https:') throw new Error('自定义证书仅适用于 HTTPS');
  const base = target.pathname.replace(/\/$/, '');
  const sockets = new Set();
  let origin;
  const trusted = { ca, rejectUnauthorized: true, timeout: 12000 };
  function request(path, headers, onResponse) {
    const req = (target.protocol === 'https:' ? https : http).request(new URL(base + path, target.origin), { ...trusted, headers }, onResponse);
    req.on('timeout', () => req.destroy(new Error('穿透连接超时')));
    return req;
  }
  const server = http.createServer((req, res) => {
    if (req.headers.host !== origin?.host) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (allowedOrigin && req.headers.origin === allowedOrigin) res.setHeader('access-control-allow-origin', allowedOrigin);
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html); return;
    }
    if (path !== '/lan/status') { res.writeHead(404); res.end(); return; }
    const upstream = request(path, {}, (remote) => {
      res.writeHead(remote.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      remote.pipe(res);
    });
    upstream.on('error', (e) => {
      console.error('服务器验证/连接失败:', e.code || '', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.code || e.message }));
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, client, head) => {
    if (req.headers.host !== origin?.host || req.url !== '/ws' ||
        (!req.headers.origin || (req.headers.origin !== origin?.origin && req.headers.origin !== allowedOrigin)) || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !req.headers['sec-websocket-key']) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = request('/ws', {
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': req.headers['sec-websocket-key'],
      'sec-websocket-version': '13', origin: target.origin,
    }, (remote) => {
      remote.resume();
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.on('upgrade', (remote, socket, remoteHead) => {
      if (client.destroyed) { socket.destroy(); return; }
      socket.setTimeout(0);
      const headers = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < remote.rawHeaders.length; i += 2)
        headers.push(`${remote.rawHeaders[i]}: ${remote.rawHeaders[i + 1]}`);
      client.write(headers.join('\r\n') + '\r\n\r\n');
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) socket.write(head);
      socket.on('error', () => client.destroy());
      client.on('error', () => socket.destroy());
      client.on('close', () => socket.destroy());
      socket.on('close', () => client.destroy());
      client.pipe(socket); socket.pipe(client);
    });
    upstream.on('error', (e) => {
      console.error('WSS 连接失败:', e.code || '', e.message);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.end();
  });
  return {
    listen: () => new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => {
        origin = new URL(`http://127.0.0.1:${server.address().port}`);
        res(origin);
      });
    }),
    close: () => new Promise((res) => { for (const s of sockets) s.destroy(); server.close(res); }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = dirname(here);
    const config = JSON.parse(await readFile(join(here, 'friend-server.json'), 'utf8'));
    const bridge = createFriendBridge({ endpoint: config.endpoint,
      ca: await readFile(join(here, 'friend-server.crt')),
      html: await readFile(join(root, 'IRONFALL.html')) });
    const url = await bridge.listen();
    const status = await fetch(new URL('/lan/status', url), { signal: AbortSignal.timeout(15000) });
    const state = await status.json();
    if (!status.ok || !state.lan || !state.ok) {
      await bridge.close(); throw new Error('房主服务未就绪: ' + (state.error || status.status));
    }
    console.log('证书验证成功，已连接房主：' + config.endpoint);
    console.log('保持此窗口开启。进入游戏后点“局域网联机”→“加入房间”，无需填写公网地址。');
    const app = spawn(process.execPath, [join(here, 'launch-app.mjs')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, IRONFALL_PORT: url.port },
    });
    app.on('error', (e) => { console.error(e); bridge.close(); });
    app.on('exit', (code) => { if (code) bridge.close(); });
    process.on('SIGINT', () => bridge.close().then(() => process.exit(0)));
    process.on('SIGTERM', () => bridge.close().then(() => process.exit(0)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
