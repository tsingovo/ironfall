// Local-only control API. Remote websites/tunnels cannot create servers or trust certificates.
import { createLanServer } from './lan-server.mjs';
import { createFriendBridge } from './friend-bridge.mjs';
import { validateInvite } from './room-invite.mjs';

export function createLocalRoomControl({ hostPort = 18200 } = {}) {
  let hosted = null, bridge = null, busy = false;
  let hostedPort = hostPort;
  async function handle(req, res) {
    if (!req.url?.startsWith('/__room/')) return false;
    const host = String(req.headers.host || '');
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!local || !/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin !== 'http://' + host ||
        req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {
      reply(403, { error: '仅允许本机游戏页面操作联机服务' }); return true;
    }
    if (busy) { reply(409, { error: '正在处理上一次操作，请稍候' }); return true; }
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('邀请文件不得超过 64 KB'); }
      const data = JSON.parse(body || '{}');
      if (req.url === '/__room/host') {
        const room = validateInvite({ format: 'ironfall-room-v1', endpoint: 'http://127.0.0.1:18200', room: data.room }).room;
        if (!hosted) {
          const next = createLanServer({ port: hostPort, host: '0.0.0.0' });
          try { hostedPort = (await next.listen()).port; hosted = next; }
          catch (e) {
            await next.close().catch(() => {});
            if (e.code !== 'EADDRINUSE') throw e;
            const r = await fetch(`http://127.0.0.1:${hostPort}/lan/status`, { signal: AbortSignal.timeout(2000) });
            const s = await r.json();
            if (!s.ok || !s.lan) throw new Error('18200 被非联机服务占用，请先关闭旧服务');
          }
        }
        reply(200, { address: `http://127.0.0.1:${hostedPort}#` + room });
      } else if (req.url === '/__room/export') {
        reply(200, { invite: validateInvite(data) });
      } else if (req.url === '/__room/join') {
        const invite = validateInvite(data);
        const next = createFriendBridge({ endpoint: invite.endpoint, ca: invite.certificate || undefined,
          html: '', allowedOrigin: req.headers.origin });
        try {
          const url = await next.listen();
          const r = await fetch(new URL('/lan/status', url), { signal: AbortSignal.timeout(15000) });
          const s = await r.json();
          if (!r.ok || !s.ok || !s.lan) throw new Error('服务器验证/连接失败：' + (s.error || r.status));
          if (bridge) await bridge.close();
          bridge = next;
          reply(200, { address: url.origin + '#' + invite.room });
        } catch (e) { await next.close(); throw e; }
      } else reply(404, { error: '未知操作' });
    } catch (e) { reply(400, { error: e.message }); }
    finally { busy = false; }
    return true;
  }
  return { handle, async close() { if (bridge) await bridge.close(); if (hosted) await hosted.close(); } };
}
