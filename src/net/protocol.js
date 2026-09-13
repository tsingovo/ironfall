// ==== net/protocol.js — 局域网协议：消息种类、位标志与紧凑编解码 ====
//
// 只 import core/*，不依赖任何游戏系统，因此可以在 Node 里单独导入做契约测试。
// 符号表（武器 id、移动状态、敌人兵种）由调用方通过 createCodec() 注入，
// 避免 net/* 反向依赖 weapons.js / enemies.js。

export const NET_VERSION = '1';
export const PROTOCOL_VERSION = 1;

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

/** 敌人快照元组的字段数：id, 兵种槽, x, y, z, yaw, hp, shield, 位标志 */
export const ENEMY_TUPLE = 9;

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
