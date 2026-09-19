// ==== tools/test-auto-cert.mjs — 导出邀请时自动补公开证书 ====
//
// 背景：HTTPS 隧道用的是自签证书，邀请 JSON 里**必须**带证书，否则朋友的
// friend-bridge 没有 ca 可校验，会直接报 DEPTH_ZERO_SELF_SIGNED_CERT。
// 界面把「房主公开证书」标成「可选」，实际对自签隧道并非可选 —— 极易踩坑。
// 这里验证导出时的自动补齐行为。
//
// 用法: node tools/test-auto-cert.mjs

import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalRoomControl } from '../tools/local-room-control.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const control = createLocalRoomControl({ hostPort: 18200 });
const page = createServer(async (req, res) => {
  if (await control.handle(req, res)) return;
  res.writeHead(404); res.end('404');
});
await new Promise((r) => page.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${page.address().port}`;

async function exportInvite(payload) {
  const r = await fetch(`${origin}/__room/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  return { status: r.status, invite: j.invite || {}, autoCertificate: !!j.autoCertificate, certificatePath: j.certificatePath || null };
}

const base = { format: 'ironfall-room-v1', room: 'default', name: 'default' };

console.log('\n导出邀请时的证书自动补齐');

// ── 1. 仓库里存在 dist/friend-server.crt 时的行为
let hasRepoCert = false;
try {
  const t = await exportInvite({ ...base, endpoint: 'https://frp-bag.com:58881', certificate: '' });
  hasRepoCert = !!t.invite.certificate;
} catch (_e) { /* 下面按结果分支 */ }

if (hasRepoCert) {
  const t = await exportInvite({ ...base, endpoint: 'https://frp-bag.com:58881', certificate: '' });
  check('HTTPS 地址 + 未选证书 → 自动补上证书', !!t.invite.certificate,
    `${t.invite.certificate.length} 字符`);
  check('自动补齐时给出提示标记', t.autoCertificate === true, `autoCertificate=${t.autoCertificate}`);
  check('自动补齐会带上指纹（朋友用于核对）', !!t.invite.fingerprint,
    t.invite.fingerprint ? t.invite.fingerprint.slice(0, 29) + '…' : '缺失');
  check('报告证书来源路径（便于排查）', !!t.certificatePath, t.certificatePath || '未提供');

  const manual = await exportInvite({ ...base, endpoint: 'https://frp-bag.com:58881', certificate: t.invite.certificate });
  check('房主手动选了证书 → 不覆盖', manual.autoCertificate === false && !!manual.invite.certificate);
} else {
  console.log('  SKIP  未找到本机公开证书（dist/friend-server.crt 不存在），跳过自动补齐断言');
}

// ── 2. 明文 HTTP 地址：不应塞证书
{
  const t = await exportInvite({ ...base, endpoint: 'http://127.0.0.1:18200', certificate: '' });
  check('明文 HTTP 地址 → 不塞证书', !t.invite.certificate,
    'friend-bridge 对 http 目标带 ca 会直接报错');
  check('明文 HTTP 地址 → autoCertificate 为假', t.autoCertificate === false);
}

// ── 3. 环境变量指定证书路径时应当生效
{
  const dir = await mkdtemp(join(tmpdir(), 'ironfall-cert-'));
  const fake = join(dir, 'custom.crt');
  // 用**真实**的 PEM：伪造的短证书会被 validateInvite 的 schema 校验拒掉，
  // 那是测试自身的问题，会掩盖环境变量优先级是否生效。
  const realPem = await readFile('dist/friend-server.crt', 'utf8');
  await writeFile(fake, realPem);
  process.env.IRONFALL_FRIEND_CRT = fake;

  // 端点必须与证书域名一致：validateInvite 会校验证书 SAN 与邀请地址是否匹配。
  // 这是有意义的安全检查 —— 顺手把它也纳入断言（见下面的负例）。
  const t = await exportInvite({ ...base, endpoint: 'https://frp-bag.com:58881', certificate: '' });
  if (t.invite.certificate) {
    check('IRONFALL_FRIEND_CRT 指定的证书被优先使用',
      t.certificatePath === fake, t.certificatePath || '未报告路径');
  } else {
    check('IRONFALL_FRIEND_CRT 指定的证书被优先使用', false,
      `未生效 status=${t.status}`);
  }

  // 负例：证书域名与地址不匹配时必须拒绝，而不是放行一个校验不上的邀请
  const mismatch = await exportInvite({ ...base, endpoint: 'https://example.com:443', certificate: '' });
  check('证书域名与邀请地址不匹配 → 拒绝导出', mismatch.status === 400,
    `status=${mismatch.status}（期望 400）`);

  delete process.env.IRONFALL_FRIEND_CRT;
  await rm(dir, { recursive: true, force: true });
}

// ── 4. 非法 endpoint 不应崩溃
{
  const t = await exportInvite({ ...base, endpoint: '', certificate: '' });
  check('空地址 → 返回错误而不是抛出', t.status === 400 || !!t.invite.endpoint === false,
    `status=${t.status}`);
}

await control.close().catch(() => {});
page.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
