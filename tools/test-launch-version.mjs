// 验证 2.x 启动器不会复用占据默认端口的旧版 IRONFALL。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function findPair() {
  for (let base = 19320; base < 19480; base += 2) {
    const a = http.createServer();
    const b = http.createServer();
    try {
      await listen(a, base);
      await listen(b, base + 1);
      await close(a);
      await close(b);
      return base;
    } catch (_e) {
      try { await close(a); } catch (_ignored) { /* already closed */ }
      try { await close(b); } catch (_ignored) { /* already closed */ }
    }
  }
  throw new Error('没有找到用于启动器测试的连续空闲端口');
}

function runLauncher(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'launch-app.mjs'), '--ensure-only'], {
      cwd: root,
      env: { ...process.env, IRONFALL_PORT: String(port), IRONFALL_BROWSER: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const base = await findPair();
const oldServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>IRONFALL</title><div>IRONFALL // BUILD 1.9</div>');
});
const currentServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>IRONFALL</title><div>IRONFALL // BUILD 2.1.1</div>');
});

try {
  await listen(oldServer, base);
  await listen(currentServer, base + 1);
  const result = await runLauncher(base);
  const combined = `${result.stdout}\n${result.stderr}`;
  const passed = result.code === 0
    && combined.includes(`检测到旧版 IRONFALL 实例（端口 ${base}）`)
    && combined.includes(`版本握手完成：http://127.0.0.1:${base + 1}/?standalone=1`);
  if (!passed) {
    console.error(combined);
    throw new Error(`启动器旧实例隔离测试失败（退出码 ${result.code}）`);
  }
  console.log(`PASS：旧版占用 ${base} 时，新版正确复用 ${base + 1}，未打开 GUI。`);
} finally {
  await close(oldServer);
  await close(currentServer);
}
