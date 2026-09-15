// ==== net/protocol.js — 局域网协议：消息种类、位标志与紧凑编解码 ====
//
// 只 import core/*，不依赖任何游戏系统，因此可以在 Node 里单独导入做契约测试。
// 符号表（武器 id、移动状态、敌人兵种）由调用方通过 createCodec() 注入，
// 避免 net/* 反向依赖 weapons.js / enemies.js。

export const NET_VERSION = '2';
export const PROTOCOL_VERSION = 2;

/** 服务器的默认端口（与 tools/lan-server.mjs 的 DEFAULT_PORT 保持一致） */
export const DEFAULT_SERVER_PORT = 18200;

/**
 * 解析玩家手输的服务器地址。
 *
 * 支持这些写法（端口省略时用 18200）：
 *   1.2.3.4              192.168.1.5:18200        game.example.com
 *   ws://1.2.3.4:18200   wss://example.com        https://example.com/ironfall
 *   1.2.3.4:18200#raiders        ← # 后面是房间名
 *   [fe80::1]:18200              ← IPv6 字面量
 *
 * 路径被当作 HTTP 基准路径：`https://x.com/ironfall` → ws 走
 * `wss://x.com/ironfall/ws`、状态查询走 `https://x.com/ironfall/lan/status`。
 * 这样反代挂在子路径下也能用（前提是反代把前缀剥掉再转发给 lan-server）。
 *
 * @param {string} input 玩家输入的原文
 * @param {{secure?:boolean}} opts secure = 当前页面是否 HTTPS（决定默认协议）
 */
export function parseServerAddress(input, opts = {}) {
  const pageIsSecure = !!opts.secure;
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '请输入服务器地址' };

  let room = '';
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    room = raw.slice(hash + 1).trim().replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 32);
    raw = raw.slice(0, hash).trim();
  }

  let explicitProto = '';
  const protoMatch = /^(wss?|https?):\/\//i.exec(raw);
  if (protoMatch) {
    explicitProto = protoMatch[1].toLowerCase();
    raw = raw.slice(protoMatch[0].length);
  }

  // 路径部分：留作 HTTP 基准，WS 端点在其后追加 /ws
  let basePath = '';
  const slash = raw.indexOf('/');
  if (slash >= 0) {
    basePath = raw.slice(slash).replace(/\/+$/, '');
    if (basePath === '/ws') basePath = '';
    else basePath = basePath.replace(/\/ws$/, '');
    raw = raw.slice(0, slash);
  }

  let host = raw;
  let portStr = '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return { ok: false, error: 'IPv6 地址缺少 “]”' };
    const rest = host.slice(end + 1);
    host = host.slice(1, end);
    if (rest.startsWith(':')) portStr = rest.slice(1);
  } else {
    const first = host.indexOf(':');
    const last = host.lastIndexOf(':');
    // 只有一个冒号才是 host:port；多个冒号视为不带方括号的 IPv6 字面量
    if (first > 0 && first === last) {
      portStr = host.slice(last + 1).trim();
      if (portStr === '') return { ok: false, error: '冒号后没有端口号' };
      host = host.slice(0, last);
    }
  }
  host = host.trim();
  if (!host || host.startsWith(':') || host.endsWith(':')) {
    return { ok: false, error: '地址缺少主机名' };
  }
  const isV6 = host.includes(':');
  const hostOk = isV6 ? /^[0-9A-Fa-f:.]+$/.test(host) : /^[A-Za-z0-9._-]+$/.test(host);
  if (!hostOk) return { ok: false, error: `主机名不合法：${host}` };

  // 端口只在“确实写了”的时候校验。写成 `port = Number(x) || DEFAULT` 会让
  // 显式的 `:0` 静默变成默认端口，玩家输错了却连到别的地方去。
  // 完整穿透 URL 必须沿用标准 HTTP/TLS 端口，不能擅自追加内网端口。
  let port = explicitProto
    ? (explicitProto === 'https' || explicitProto === 'wss' ? 443 : 80)
    : DEFAULT_SERVER_PORT;
  if (portStr !== '') {
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `端口不合法：${portStr}` };
    }
  }

  const secure = explicitProto
    ? (explicitProto === 'wss' || explicitProto === 'https')
    : pageIsSecure;
  // 混合内容：HTTPS 页面里浏览器会直接掐断明文 ws://。
  // 显式写了 ws:// 是明确的错误，直接拒绝；只是没写协议的（默认按 wss 试）
  // 无法在这里判定，标一个风险位，连接失败时再补提示。
  if (pageIsSecure && explicitProto && !secure) {
    return {
      ok: false,
      error: '当前页面是 HTTPS，浏览器不允许连接明文 ws:// 服务器。请改用 wss:// 或 https:// 访问本页面。',
      mixedContent: true,
    };
  }

  const hostPort = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const scheme = secure ? 'wss:' : 'ws:';
  const httpScheme = secure ? 'https:' : 'http:';
  return {
    ok: true,
    host,
    port,
    room,
    secure,
    basePath,
    // HTTPS 页面 + 没写协议：默认按 wss 试（服务器可能真有 TLS），
    // 但如果连不上，八成就是对方只有明文。让调用方能在失败时补这句提示。
    mixedContentRisk: pageIsSecure && !explicitProto,
    wsUrl: `${scheme}//${hostPort}${basePath}/ws`,
    httpUrl: `${httpScheme}//${hostPort}${basePath}`,
    label: `${host}:${port}${basePath}${room ? '#' + room : ''}`,
  };
}

/** 服务器 → 客户端的信封类型（由 tools/lan-server.mjs 产生） */
export const SRV = Object.freeze({
  WELCOME: 'welcome',
  ROSTER: 'roster',
  PEER_LEFT: 'peer_left',
  CHAT: 'chat',
  PONG: 'pong',
  ERROR: 'error',
  GAME: 'game',
});

/** 游戏层消息种类（放在信封的 data.k 里） */
export const MSG = Object.freeze({
  SHOT: 'shot',
  HELLO: 'hi',            // 房客 → 房主：握手，报告自己的名字与能力
  SESSION: 'sess',        // 房主 → 全体：本局配置（地图种子、任务、名单）
  PLAYER: 'ps',           // 每个 peer → 全体：自身玩家状态（30 Hz）
  PLAYER_INFO: 'pi',      // 每个 peer → 全体：不常变的资料（上限、武器表、队色）
  ENEMY: 'es',            // 房主 → 房客：敌人快照
  ENEMY_FULL: 'ef',       // 房主 → 房客：全量敌人列表（加入/重连时）
  WORLD_EVENT: 'ev',      // 房主 → 全体：离散世界事件（死亡、掉落、目标、提示）
  HIT: 'hit',             // 房客 → 房主：命中申报
  DAMAGE: 'dmg',          // 房主 → 单个房客：对“你的玩家”造成的伤害
  LOOT_TAKE: 'lt',        // 房客 → 房主：请求拾取世界掉落
  RUN: 'run',             // 房主 → 房客：单局阶段/目标状态
  CHAT: 'chat',           // 任意 → 全体：局内文字
  PING: 'png',            // 任意 → 全体：延迟与位置标记
  BYE: 'bye',
});

/** 玩家状态位标志 */
export const FLAG = Object.freeze({
  ALIVE: 1 << 0,
  GROUNDED: 1 << 1,
  CROUCHING: 1 << 2,
  SLIDING: 1 << 3,
  ADS: 1 << 4,
  RELOADING: 1 << 5,
  FIRING: 1 << 6,
  GRAPPLE: 1 << 7,
  SPRINTING: 1 << 8,
});

/** 世界事件种类 */
export const EV = Object.freeze({
  ENEMY_SPAWN: 'spawn',
  ENEMY_DEATH: 'death',
  ENEMY_HIT: 'hit',
  PLAYER_DEATH: 'pdeath',
  PLAYER_RESPAWN: 'prespawn',
  OBJECTIVE: 'obj',
  TOAST: 'toast',
  DROP: 'drop',
  RUN_END: 'rend',
  SESSION_END: 'send',
});

/** player.state.moveState 的固定顺序（顺序即协议，不能随意调整） */
export const MOVE_STATES = Object.freeze([
  'AIR', 'GROUNDED', 'SLIDE', 'WALLRUN', 'GRAPPLE', 'MANTLE', 'DASH',
]);

const MOVE_INDEX = new Map(MOVE_STATES.map((s, i) => [s, i]));

/** 位置保留 2 位小数（1 cm），角度保留 4 位（约 0.006°） */
export function q2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
export function q4(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}
export function q1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** 玩家状态元组的字段数（协议的一部分） */
export const PLAYER_TUPLE = 16;

/**
 * 建一套编解码器。tables 由调用方从活系统里取：
 *   { weapons: [id...], enemyTypes: [typeId...] }
 */
export function createCodec(tables = {}) {
  const weaponIds = Array.isArray(tables.weapons) ? tables.weapons.slice() : [];
  const enemyTypeIds = Array.isArray(tables.enemyTypes) ? tables.enemyTypes.slice() : [];
  const weaponIndex = new Map(weaponIds.map((id, i) => [id, i]));
  const enemyTypeIndex = new Map(enemyTypeIds.map((id, i) => [id, i]));

  function weaponSlot(id) {
    const i = weaponIndex.get(id);
    return i === undefined ? -1 : i;
  }
  function weaponIdOf(slot) {
    return weaponIds[slot] || null;
  }
  function enemyTypeSlot(id) {
    const i = enemyTypeIndex.get(id);
    return i === undefined ? -1 : i;
  }
  function enemyTypeOf(slot) {
    return enemyTypeIds[slot] || null;
  }

  /**
   * 编码本地玩家状态。写入 out（长度 >= PLAYER_TUPLE）并返回 out。
   * 热路径零分配：out 由调用方复用。
   */
  function encodePlayer(player, weapons, out) {
    const s = player.state || {};
    let flags = 0;
    if (player.alive !== false) flags |= FLAG.ALIVE;
    if (s.grounded) flags |= FLAG.GROUNDED;
    if (s.crouching) flags |= FLAG.CROUCHING;
    if (s.sliding) flags |= FLAG.SLIDING;
    if (s.sprinting) flags |= FLAG.SPRINTING;
    const wstate = weapons && weapons.current ? weapons.current : null;
    if (wstate) {
      if (wstate.adsT > 0.5) flags |= FLAG.ADS;
      if (wstate.reloading) flags |= FLAG.RELOADING;
    }
    // WeaponSystem.current 是只读快照，没有“正在扣扳机”字段；扣扳机状态保存在
    // 系统自身的 _triggerHeld 上（见 weapons.js 的 update()）。
    if (weapons && weapons._triggerHeld) flags |= FLAG.FIRING;
    if (s.grappleActive || (player.grapple && player.grapple.active)) flags |= FLAG.GRAPPLE;

    out[0] = q2(player.pos[0]);
    out[1] = q2(player.pos[1]);
    out[2] = q2(player.pos[2]);
    out[3] = q4(player.yaw);
    out[4] = q4(player.pitch);
    out[5] = q2(player.vel[0]);
    out[6] = q2(player.vel[1]);
    out[7] = q2(player.vel[2]);
    out[8] = q1(player.health);
    out[9] = q1(player.shield);
    out[10] = MOVE_INDEX.get(s.moveState) || 0;
    out[11] = flags;
    out[12] = wstate ? weaponSlot(wstate.id) : -1;
    out[13] = q2(s.hspeed || 0);
    // 上限随改装/装甲板变化，放在每个包尾随带上，省掉一整类“资料同步”消息。
    out[14] = q1(player.maxHealth || 100);
    out[15] = q1(player.maxShield || 0);
    return out;
  }

  /** 解码玩家状态到可复用的对象（避免每帧分配） */
  function decodePlayer(tuple, out) {
    const o = out || {
      pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0,
      health: 0, shield: 0, maxHealth: 100, maxShield: 0,
      moveState: 'AIR', flags: 0, weaponId: null,
      hspeed: 0, alive: true, state: { grounded: true, crouching: false, sliding: false, hspeed: 0 },
    };
    if (!Array.isArray(tuple)) return o;
    o.pos[0] = tuple[0] || 0;
    o.pos[1] = tuple[1] || 0;
    o.pos[2] = tuple[2] || 0;
    o.yaw = tuple[3] || 0;
    o.pitch = tuple[4] || 0;
    o.vel[0] = tuple[5] || 0;
    o.vel[1] = tuple[6] || 0;
    o.vel[2] = tuple[7] || 0;
    o.health = tuple[8] || 0;
    o.shield = tuple[9] || 0;
    o.moveState = MOVE_STATES[tuple[10] | 0] || 'AIR';
    const f = tuple[11] | 0;
    o.flags = f;
    o.alive = (f & FLAG.ALIVE) !== 0;
    o.weaponId = weaponIdOf(tuple[12] | 0);
    o.hspeed = tuple[13] || 0;
    o.maxHealth = Number.isFinite(tuple[14]) && tuple[14] > 0 ? tuple[14] : 100;
    o.maxShield = Number.isFinite(tuple[15]) && tuple[15] > 0 ? tuple[15] : 0;
    o.state.grounded = (f & FLAG.GROUNDED) !== 0;
    o.state.crouching = (f & FLAG.CROUCHING) !== 0;
    o.state.sliding = (f & FLAG.SLIDING) !== 0;
    o.state.sprinting = (f & FLAG.SPRINTING) !== 0;
    o.state.hspeed = o.hspeed;
    o.state.moveState = o.moveState;
    o.ads = (f & FLAG.ADS) !== 0;
    o.reloading = (f & FLAG.RELOADING) !== 0;
    o.firing = (f & FLAG.FIRING) !== 0;
    o.grappling = (f & FLAG.GRAPPLE) !== 0;
    return o;
  }

  return {
    weaponIds,
    enemyTypeIds,
    weaponSlot,
    weaponIdOf,
    enemyTypeSlot,
    enemyTypeOf,
    encodePlayer,
    decodePlayer,
    /** 协议里位置是 2 位小数，比较时用同一精度避免假差异 */
    quantizePos: q2,
  };
}

/**
 * 敌人快照元组的字段数。
 *
 *   0 id      1 兵种槽   2 x   3 y   4 z   5 yaw
 *   6 hp      7 shield   8 位标志
 *   9 maxHp  10 maxShield  11 scale
 *
 * 后三项是 2.0.7 守关首领带来的：首领 `maxHp *= 5 + tier`、`maxShield *= 3`、
 * `scale = 1.6`。不同步上限，房客端血条会算成 600%；不同步 scale，房客看到的
 * 首领是普通体型、命中盒也跟着错。
 */
export const ENEMY_TUPLE = 12;

/** 敌人位标志 */
export const EFLAG = Object.freeze({
  ALIVE: 1 << 0,
  ELITE: 1 << 1,
});

/** 清理聊天文本：去掉控制字符，限制长度 */
export function sanitizeChat(raw, max = 200) {
  const text = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** 校验收到的一条游戏消息是否结构合法 */
export function validateGameMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.k !== 'string') return false;
  return true;
}

export default {
  NET_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_SERVER_PORT,
  parseServerAddress,
  SRV,
  MSG,
  FLAG,
  EV,
  MOVE_STATES,
  PLAYER_TUPLE,
  createCodec,
  sanitizeChat,
  validateGameMessage,
  q1,
  q2,
  q4,
};
