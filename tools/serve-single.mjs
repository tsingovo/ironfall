// ==== tools/serve-single.mjs — 只服务单个 HTML 的极简服务器（发布包用）====
//
// 用途：发布包里游戏被构建成单个 IRONFALL.html（所有模块、样式、模型都已内联），
// 不需要静态目录服务。但**仍然必须走 HTTP** —— 原因是：
//   · ES Modules 在 file:// 下会被浏览器 CORS 拦死
//   · `--app` 模式（独立窗口，避开 Ctrl+W 等标签页快捷键）对 file:// 无效
//
// 任何路径的请求都返回同一个 HTML（单文件游戏没有子资源）。
//
// 用法: node tools/serve-single.mjs <html路径> <端口>

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalRoomControl } from './local-room-control.mjs';

const file = process.argv[2];
const port = Number(process.argv[3] || 18080);

if (!file) {
  console.error('用法: node tools/serve-single.mjs <html路径> [端口]');
  process.exit(2);
}

const abs = resolve(file);
let body;
try {
  body = await readFile(abs);
} catch (e) {
  console.error(`无法读取 ${abs}: ${e.message}`);
  process.exit(3);
}

const control = createLocalRoomControl();
const server = createServer(async (req, res) => {
  if (await control.handle(req, res)) return;
  // 健康探测（launcher 用它判断服务器是否就绪）
  if (req.url === '/__ironfall_ping') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('IRONFALL');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用`);
    process.exit(4);
  }
  console.error(e.message);
  process.exit(5);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`IRONFALL serving ${abs} on http://127.0.0.1:${port}/`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await control.close(); server.close(() => process.exit(0)); });
}
