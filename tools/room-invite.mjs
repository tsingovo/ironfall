// Portable invitation contains endpoint + public certificate, never executable code or keys.
import { X509Certificate } from 'node:crypto';

export function validateInvite(input) {
  if (!input || input.format !== 'ironfall-room-v1') throw new Error('不是 IRONFALL 房间文件');
  const endpoint = new URL(String(input.endpoint || ''));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) throw new Error('地址必须是无密码、无查询参数的 HTTP/HTTPS 地址');
  const room = String(input.room || 'default');
  if (!/^[\w\u4e00-\u9fa5-]{1,32}$/.test(room)) throw new Error('房间名限 1–32 个中英文、数字、下划线或连字符');
  const certificate = String(input.certificate || '');
  let fingerprint = '';
  if (certificate) {
    if (endpoint.protocol !== 'https:') throw new Error('HTTP 不使用证书');
    if (certificate.length > 32768 || /PRIVATE KEY/.test(certificate)) throw new Error('不能导入私钥或超大证书');
    const cert = new X509Certificate(certificate);
    const now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw new Error('证书尚未生效或已过期');
    const host = endpoint.hostname.replace(/^\[|\]$/g, '');
    const matches = cert.checkHost(host) || (/^[\d.]+$|:/.test(host) && cert.checkIP(host));
    if (!matches) throw new Error('证书域名与邀请地址不匹配');
    fingerprint = cert.fingerprint256;
  }
  return { format: 'ironfall-room-v1', endpoint: endpoint.href.replace(/\/$/, ''), room,
    name: String(input.name || room).slice(0, 64), certificate, fingerprint };
}
