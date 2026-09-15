// ==== tools/serve.mjs — 零依赖静态服务器 ====
// 用法: node tools/serve.mjs [port]
// 默认 8080。仅服务 ironfall 目录，绑定 127.0.0.1。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalRoomControl } from './local-room-control.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = '127.0.0.1';

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

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(root, rel);
  // 阻止目录穿越
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

const control = createLocalRoomControl();
const server = createServer(async (req, res) => {
  if (await control.handle(req, res)) return;
  const started = Date.now();
  let status = 200;
  try {
    let target = safeJoin(ROOT, req.url || '/');
    if (!target) {
      status = 403;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 越界访问');
      return;
    }
    let info = await stat(target).catch(() => null);
    if (info && info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info || !info.isFile()) {
      status = 404;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 未找到: ' + req.url);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // 开发期禁用缓存，改完刷新即生效
      'cache-control': 'no-store, must-revalidate',
      // 允许 SharedArrayBuffer / 高精度计时（未来可能用到）
      'cross-origin-opener-policy': 'same-origin',
    });
    res.end(body);
  } catch (err) {
    status = 500;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 ' + (err && err.message));
  } finally {
    if (process.env.IRONFALL_LOG) {
      process.stdout.write(`${status} ${req.method} ${req.url} ${Date.now() - started}ms\n`);
    }
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`IRONFALL 静态服务器已启动: http://${HOST}:${PORT}/\n`);
  process.stdout.write(`根目录: ${ROOT}\n`);
  process.stdout.write('按 Ctrl+C 停止\n');
});

process.on('SIGINT', async () => {
  await control.close();
  process.stdout.write('\n正在关闭…\n');
  server.close(() => process.exit(0));
});
