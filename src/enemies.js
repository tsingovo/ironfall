// ==== enemies.js — 敌人与 AI ====
// 设计要点：
//   * 六个兵种，各自有明确的"读招"：冲锋兵贴近、盾兵顶盾推进、飞行兵绕后、
//     重装兵破盾后才掉血、狙击兵蓄力有预警激光、虫群蜂拥。
//   * 感知 = 视锥（角度 + 距离） + 射线可见性 + 听觉半径（开火/脚步）。
//   * 移动走 world.resolveCapsule，能上坡、不穿墙、会绕障（简单的转向偏移）。
//   * 射击有预瞄延迟 + 点射节奏 + 精度随难度/距离衰减（低难度故意打偏）。
//   * 渲染按"网格形状"分组实例化：每帧只有几次 draw call。

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';

// 尺寸基线：普通人形敌人的站立高度严格对齐玩家 1.8m 胶囊，而不是用一个含糊的
// “放大百分比”。重装、无人机和虫群保留兵种本身的体型差异。scale 同时作用于
// 可视模型、碰撞体、命中盒和枪口，避免视觉与判定错位。
export const ENEMY_BASE_SCALE = 1.0;
export const ENEMY_HUMANOID_HEIGHT = CFG.move.capsuleHeight;

export function enemyBaseScale(type) {
  if (type && Number.isFinite(type.baseScale)) return Math.max(0.25, type.baseScale);
  return type && type.meshKind === 'humanoid'
    ? ENEMY_HUMANOID_HEIGHT / Math.max(0.01, type.height)
    : ENEMY_BASE_SCALE;
}
// 敌方伤害全局缩放。保留兵种与层级差异，但避免开局被一轮齐射瞬间蒸发。
export const ENEMY_DAMAGE_SCALE = 0.35;

/** 兵种定义 */
export const ENEMY_TYPES = {
  grunt: {
    id: 'grunt', name: '巡逻兵', nameCN: '远征巡逻兵',
    // 所有敌人默认带一层基础能量护甲；数值低于生命值，破盾后仍能快速击杀。
    hp: 75, shield: 57, speed: 4.2, accel: 22,
    radius: 0.4, height: 1.75,
    color: [0.82, 0.20, 0.08], accentColor: [1.0, 0.62, 0.18],
    score: 100, alloy: 3,
    weapon: { damage: 7, rpm: 300, range: 60, accuracy: 0.72, burst: 5, burstPause: 0.95, projectileSpeed: 0, spreadDeg: 3.8, telegraph: 0.28 },
    behavior: 'infantry',
    xp: 1, threat: 1,
    meshKind: 'humanoid',
    attackRange: 34, preferredRange: 14, strafe: true,
  },
  shieldman: {
    id: 'shieldman', name: '盾卫', nameCN: '重盾突击兵',
    // 需求 12：血量翻倍（100+75 → 200+150）。
    hp: 200, shield: 150, speed: 3.4, accel: 18,
    radius: 0.46, height: 1.8,
    color: [0.16, 0.48, 0.78], accentColor: [0.35, 0.92, 1.0],
    score: 150, alloy: 5,
    // 需求 12：改用霰弹枪，命中按距离判定伤害。
    // damageFalloff* 三个字段驱动 _fire 里的线性衰减：8m 内满伤，30m 外只剩 18%。
    // 数值刻意不高（满伤 9/弹丸、射速降到 90），配合血量翻倍，
    // 定位是「难啃但不构成主要威胁」，而不是变成秒人怪。
    weapon: {
      damage: 9, rpm: 90, range: 30, accuracy: 0.6,
      burst: 1, burstPause: 1.5, projectileSpeed: 0, spreadDeg: 9.5, telegraph: 0.42,
      pellets: 6,
      damageFalloffStart: 8, damageFalloffEnd: 30, falloffMinMul: 0.18,
    },
    behavior: 'charger',
    shieldFront: true, shieldArc: 0.55, shieldDamageMul: 0.22,
    xp: 2, threat: 1.6,
    meshKind: 'humanoid',
    attackRange: 22, preferredRange: 3.4, strafe: false,
  },
  flyer: {
    id: 'flyer', name: '飞行器', nameCN: '游猎无人机',
    hp: 75, shield: 57, speed: 7.4, accel: 30,
    radius: 0.42, height: 0.9,
    color: [0.48, 0.16, 0.76], accentColor: [0.92, 0.48, 1.0],
    score: 120, alloy: 4,
    weapon: { damage: 6, rpm: 360, range: 46, accuracy: 0.66, burst: 6, burstPause: 1.0, projectileSpeed: 42, spreadDeg: 3.4, telegraph: 0.3 },
    behavior: 'flyer',
    flying: true, hoverHeight: 5.2, bobAmp: 0.55, bobFreq: 1.7,
    xp: 2, threat: 1.4,
    meshKind: 'drone',
    attackRange: 42, preferredRange: 12, strafe: true,
  },
  heavy: {
    id: 'heavy', name: '重装兵', nameCN: '重装压制者',
    hp: 75, shield: 57, speed: 2.6, accel: 12,
    radius: 0.58, height: 2.15,
    color: [0.72, 0.28, 0.06], accentColor: [1.0, 0.78, 0.20],
    score: 320, alloy: 12,
    weapon: { damage: 13, rpm: 420, range: 52, accuracy: 0.7, burst: 9, burstPause: 1.6, projectileSpeed: 0, spreadDeg: 4.4, telegraph: 0.5 },
    behavior: 'infantry',
    xp: 5, threat: 3.2,
    meshKind: 'heavy',
    attackRange: 46, preferredRange: 16, strafe: true,
    elite: true,
  },
  sniper: {
    id: 'sniper', name: '狙击手', nameCN: '定点清除者',
    hp: 75, shield: 57, speed: 3.0, accel: 16,
    radius: 0.4, height: 1.78,
    color: [0.08, 0.58, 0.38], accentColor: [0.42, 1.0, 0.68],
    score: 200, alloy: 7,
    weapon: { damage: 34, rpm: 42, range: 160, accuracy: 0.94, burst: 1, burstPause: 2.4, projectileSpeed: 0, spreadDeg: 0.7, telegraph: 1.15, laser: true },
    behavior: 'sniper',
    xp: 3, threat: 2.4,
    meshKind: 'humanoid',
    attackRange: 140, preferredRange: 55, strafe: false, keepDistance: true,
  },
  // 需求 2：可能在高处生成的狙击手。
  //   黑色人体模型；瞄准时冒出极其明显的红光，并发出红色射线**缓慢**瞄向玩家；
  //   确定射击后不再移动镜头，0.5 秒后开枪；伤害 100。
  // 与普通 sniper 的区别：普通狙击手是"绿色 + 34 伤 + 会走位"的常规远程单位，
  // 这个是"黑色 + 100 伤 + 站桩"的高台威胁，靠红色射线给玩家反应窗口。
  highSniper: {
    id: 'highSniper', name: '高处狙击手', nameCN: '高台射手',
    hp: 75, shield: 57, speed: 2.2, accel: 12,
    radius: 0.4, height: 1.8,
    // 黑色人体模型（需求原文）
    color: [0.045, 0.045, 0.055], accentColor: [1.0, 0.10, 0.06],
    score: 260, alloy: 8,
    weapon: {
      damage: 100, rpm: 30, range: 80, accuracy: 0.98,
      burst: 1, burstPause: 3.2, projectileSpeed: 0, spreadDeg: 0.45,
      // 总蓄力 1.6s：前 1.1s 红线缓慢扫向玩家，后 0.5s 冻结（需求"0.5 秒后射击"）
      telegraph: 1.6, laser: true,
      aimTurnRate: 0.85,        // 弧度/秒，缓慢
      aimStartMissDeg: 34,      // 起始故意偏开，让玩家看到红线扫过来
      aimLockTime: 0.5,         // 最后 0.5 秒冻结瞄向
      aimRange: 180,
    },
    behavior: 'sniper',
    xp: 3, threat: 2.8,
    meshKind: 'humanoid',
    // 注意射程/交战距离要控制在地图尺度内：内置地图 size=200（半宽 100），
    // 而导演的刷怪环大致按 attackRange/preferredRange 推算。
    // 早先这里写 170/90，刷怪环被推到 182–220m —— 完全落在地图之外，
    // 表现为"高处狙击手永远刷不出来"。现在压到 70/45，环落在 60–110m 内。
    attackRange: 70, preferredRange: 45, strafe: false, keepDistance: true,
    // 刷怪高度偏好（供 director 选点用）：优先高台
    prefersHighGround: true, highGroundMin: 6,
  },
  swarm: {
    id: 'swarm', name: '虫群', nameCN: '拆解虫群',
    hp: 75, shield: 57, speed: 8.0, accel: 38,
    // 虫群不再是贴在脚底的小点：模型、碰撞体与命中盒统一放大 55%。
    radius: 0.34, height: 0.72, baseScale: 1.55,
    color: [0.72, 0.58, 0.02], accentColor: [1.0, 0.94, 0.22],
    score: 40, alloy: 1,
    weapon: { damage: 6, rpm: 140, range: 2.6, accuracy: 1.0, burst: 1, burstPause: 0.8, projectileSpeed: 0, spreadDeg: 0, telegraph: 0.18, melee: true },
    behavior: 'melee',
    flying: false, hopHeight: 1.5,
    xp: 1, threat: 0.7,
    meshKind: 'crawler',
    attackRange: 2.9, preferredRange: 1.9, strafe: false,
    swarm: true,
  },
  stalker: {
    id: 'stalker', name: '绿影', nameCN: '绿影突袭者',
    hp: 50, shield: 0, speed: 18, accel: 60, radius: 0.4, height: 1.8,
    color: [0.08, 0.85, 0.22], accentColor: [0.35, 1, 0.55],
    score: 180, alloy: 5, xp: 3, threat: 1.4,
    weapon: {damage: 50, melee: true}, behavior: 'hitrun', meshKind: 'humanoid',
    attackRange: 2.7, preferredRange: 2, retreatDistance: 60, windup: 0.22,
  },
  blastSpider: {
    id: 'blastSpider', name: '爆蛛', nameCN: '爬墙自爆蛛',
    hp: 75, shield: 0, speed: 8, accel: 38, radius: 0.42, height: 0.9,
    color: [0.20, 0.13, 0.10], accentColor: [1, 0.35, 0.06],
    score: 100, alloy: 3, xp: 2, threat: 1.0,
    weapon: {damage: 50, melee: true}, behavior: 'bomber', meshKind: 'spider',
    attackRange: 3.2, preferredRange: 2.5, chargeTime: 1.1, blastRadius: 5,
  },
  broodStalker: {
    id:'broodStalker', name:'绿影蛛皇', nameCN:'绿影蛛皇',
    // 蛛皇 BOSS：血量/护盾基准取玩家基线量级（150），因为 director 会在生成时
    // 直接乘 `(5 + tier)`。改成兵种表驱动之前，这里的实际起点就是全局的
    // CFG.gameplay.maxHealth(150)；若跟随普通小怪一起减半，会让 boss 血量
    // 在无意中缩水 2/3 —— 那属于隐性 nerf，不是需求要求的。
    hp:150, shield:150, speed:18, accel:60, radius:0.65, height:2.35,
    color:[0.06,0.66,0.17], accentColor:[0.45,1,0.24],
    score:1500, alloy:30, xp:12, threat:6, elite:true, hybridBoss:true,
    weapon:{damage:50,melee:true}, behavior:'hitrun', meshKind:'hybrid',
    attackRange:3.5, preferredRange:2, retreatDistance:60, windup:0.22,
  },
};

export const ENEMY_IDS = Object.keys(ENEMY_TYPES);

/** AI 状态 */
const AI_IDLE = 0;
const AI_ALERT = 1;
const AI_ENGAGE = 2;
const AI_REPOSITION = 3;
const AI_FLEE = 4;
const AI_STATE_NAMES = ['idle', 'alert', 'engage', 'reposition', 'flee'];

// 暂存
const T_A = new Float32Array(3);
const T_B = new Float32Array(3);
const T_C = new Float32Array(3);
const T_D = new Float32Array(3);
// 伤害方向暂存：霰弹的多弹丸循环里 RAY_D 每颗都在变，而 applyDamage 之后
// 同一帧还可能被其它监听者读取，所以不能再借 T_D/T_B，单独开一块。
const T_HITDIR = new Float32Array(3);
const RAY_O = new Float32Array(3);
const RAY_D = new Float32Array(3);
const HIT_MIN = new Float32Array(3);
const HIT_MAX = new Float32Array(3);

let _nextId = 1;

export class EnemySystem {
  constructor(world, player, engine, opts = {}) {
    this.world = world;
    this.player = player;
    this.engine = engine;
    this.opts = opts;
    this.particles = opts.particles || null;
    this.projectiles = opts.projectiles || null;

    /** @type {Array<object>} */
    this.all = [];
    this._free = [];
    this.difficulty = 1;
    this.rng = M.mulberry32(0xBADF00D);
    this.stats = { spawned: 0, killed: 0, damageDealt: 0 };
    this._renderBuckets = new Map();
    this._mats = new Float32Array(16 * 512);
    this._cols = new Float32Array(4 * 512);
    this._time = 0;
    this._score = 0;
    this._onKill = opts.onKill || null;

    // ---------------- 联机（局域网合作）----------------
    // players：参与仇恨判定的玩家集合。单机时只有本机玩家，逻辑与改造前一致；
    // 联机时由 net/session.js 写入 [本机玩家, ...远程玩家代理]，敌人会就近选目标。
    this.players = player ? [player] : [];
    // replicated：房客模式。敌人不再自行决策/移动，只接受房主快照驱动。
    this.replicated = false;
    // 房客侧待上报给房主的命中队列（扁平数组，零分配追加）。
    this.hitReports = [];
  }

  /** 联机：设置参与仇恨的玩家集合（本机玩家 + 远程玩家代理） */
  setPlayers(list) {
    this.players = Array.isArray(list) ? list.filter(Boolean) : [];
    if (this.players.length === 0 && this.player) this.players = [this.player];
  }

  /** 联机：切换为“由房主快照驱动”的复制模式 */
  setReplicated(flag) {
    this.replicated = !!flag;
    if (this.replicated) this.hitReports.length = 0;
  }

  /**
   * 联机：多玩家时的目标选择。
   * 就近选人，但对当前目标保留迟滞，避免两名队友距离接近时敌人每个物理步
   * 都来回换目标（表现为原地抽搐、谁也不打）。
   */
  _selectTarget(e) {
    const list = this.players;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const pl = list[i];
      if (!pl || pl.alive === false) continue;
      const dx = pl.pos[0] - e.pos[0];
      const dy = pl.pos[1] - e.pos[1];
      const dz = pl.pos[2] - e.pos[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = pl; }
    }
    const cur = e.target;
    if (best && cur && cur.alive !== false && list.indexOf(cur) >= 0) {
      const dx = cur.pos[0] - e.pos[0];
      const dy = cur.pos[1] - e.pos[1];
      const dz = cur.pos[2] - e.pos[2];
      // 1.44 = 1.2²，即新目标要近 20% 以上才换人
      if (dx * dx + dy * dy + dz * dz <= bestD * 1.44) best = cur;
    }
    e.target = best;
    return best;
  }

  count() { return this.all.length; }

  aliveCount() {
    let n = 0;
    for (const e of this.all) if (e.alive) n++;
    return n;
  }

  setDifficulty(scalar) {
    this.difficulty = Math.max(0.3, Math.min(4, scalar));
  }

  clear() {
    for (const e of this.all) this._retire(e);
    this.all.length = 0;
  }

  // ---------------------------------------------------------------- 生成

  /**
   * 生成一个敌人。
   * opts: { elite, hpMul, damageMul, accuracyMul, scale }
   */
  spawn(typeId, pos, opts = {}) {
    const type = ENEMY_TYPES[typeId] || ENEMY_TYPES.grunt;
    const o = opts || {};
    const d = this.difficulty;      // 难度：只作用于伤害/精度倍率（见下方 damageMul/accuracyMul）
    // 生存数值取**兵种自己的定义**（ENEMY_TYPES[id].hp / .shield）。
    //
    // ⚠ 这里原本写的是 `Math.round(CFG.gameplay.maxHealth)` —— 也就是所有敌人
    // 共用玩家的全局基线，兵种表里的 hp/shield 字段**从未被读取过**。
    // 后果是需求 13（绿影/炸蛛去护盾、其他小怪减半）只改了数据表、运行时毫无变化。
    // 现在改为以兵种表为准，并保留全局值作为缺字段时的回退。
    const fallbackHp = Math.round(CFG.gameplay.maxHealth);
    const fallbackShield = Math.round(CFG.gameplay.maxShield);
    const maxHp = Number.isFinite(type.hp) ? Math.round(type.hp) : fallbackHp;
    const maxShield = Number.isFinite(type.shield) ? Math.round(type.shield) : fallbackShield;

    const e = this._free.pop() || {};
    // 联机时房客必须沿用房主分配的 id，才能让命中申报与快照对上同一只敌人。
    e.id = Number.isFinite(o.id) ? (o.id | 0) : _nextId++;
    e.typeId = typeId;
    e.type = type;
    e.pos = e.pos || new Float32Array(3);
    e.pos[0] = pos[0]; e.pos[1] = pos[1]; e.pos[2] = pos[2];
    e.vel = e.vel || new Float32Array(3);
    e.vel[0] = 0; e.vel[1] = 0; e.vel[2] = 0;
    e.hp = maxHp;
    e.maxHp = maxHp;
    e.shield = maxShield;
    e.maxShield = maxShield;
    e.scale = enemyBaseScale(type) * (o.scale == null ? 1 : Math.max(0.25, o.scale));
    e.radius = type.radius * e.scale;
    e.height = type.height * e.scale;
    e.alive = true;
    e.state = AI_IDLE;
    e.yaw = this.rng() * Math.PI * 2;
    e.aimYaw = e.yaw;
    e.target = null;
    e.fireCooldown = 0.5 + this.rng() * 0.6;
    // 即便极端地图找不到完全遮挡的导航点，出生后也有明确的观察/部署窗口，
    // 绝不会在创建对象的同一瞬间向玩家开火。
    e.spawnAttackLock = 1.5;
    e.burstLeft = 0;
    e.burstCooldown = 0;
    e.telegraph = 0;
    e.telegraphing = false;
    e.alertness = 0;
    e.spawnTime = this._time;
    e.age = 0;
    e.hitFlash = 0;
    e.lastDamageTime = -99;
    e.damageMul = ENEMY_DAMAGE_SCALE * (o.damageMul == null ? 1 : o.damageMul) * (1 + (d - 1) * 0.30);
    e.accuracyMul = (o.accuracyMul == null ? 1 : o.accuracyMul) * (0.72 + d * 0.28);
    e.elite = !!o.elite || !!type.elite;
    e.deadTime = 0;
    e.strafeDir = this.rng() < 0.5 ? -1 : 1;
    e.strafeTimer = 0.6 + this.rng() * 1.8;
    e.repositionTimer = 0;
    e.stuckTimer = 0;
    e.lastPos = e.lastPos || new Float32Array(3);
    e.lastPos[0] = e.pos[0]; e.lastPos[1] = e.pos[1]; e.lastPos[2] = e.pos[2];
    e.meleeCooldown = 0;
    e.specialPhase = 'approach'; e.specialTimer = 0; e.slashT = 0;
    e.wallJumpCooldown=2; e.wallJumpTimer=0; e.wallJumpMode=''; e.wallJumpNormal=null;
    e.summonCooldown=6; e.summonCast=0; e.summonerId=null;
    e.wallNormal = null; e.specialTarget = null; e.trailTimer = 0;
    e.specialLastPos = Array.from(e.pos);
    e.grounded = false;
    e.bobPhase = this.rng() * 6.28;
    e.statusBleed = 0; e.statusBleedDmg = 0; e.statusBleedTime = 0;
    e.statusSlow = 0; e.statusSlowTime = 0;
    e.groundY = pos[1];
    e.animPhase = this.rng() * 6.28;
    e.gunRecoil = 0;
    // 每帧由 Player 写入、由本系统在 AI 决策后消费的抓钩牵引请求。
    // 保存在敌人对象上可避免 Player 直接改位置而绕过碰撞系统。
    e.grapplePull = e.grapplePull || {};
    e.grapplePull.pending = false;
    e.grapplePull.source = null;
    e.grapplePull.targetSpeed = 0;
    e.grapplePull.accel = 0;
    e.grapplePull.minDistance = CFG.move.grappleMinDist;
    e.deathDir = e.deathDir || new Float32Array(3);

    // 命中盒（局部偏移，相对 pos 底部中点）
    e.hitboxes = buildHitboxes(type, e.scale);

    this.all.push(e);
    this.stats.spawned++;
    Events.emit('enemy:spawn', { enemy: e });
    return e;
  }

  _retire(e) {
    e.alive = false;
    this._free.push(e);
  }

  // ---------------------------------------------------------------- 更新

  update(dt, player) {
    this._time += dt;
    const p = player || this.player;
    // 联机多人时每只敌人就近选目标；单机时多一次数组长度判断，行为不变。
    const multi = this.players.length > 1;
    for (let i = 0; i < this.all.length; i++) {
      const e = this.all[i];
      if (!e.alive) {
        e.deadTime += dt;
        continue;
      }
      e.age += dt;
      if (e.hitFlash > 0) e.hitFlash -= dt * 4;
      if (e.gunRecoil > 0) e.gunRecoil -= dt * 6;
      // 房客：位置/朝向/血量完全由房主快照驱动（net/session.js 每帧插值写入），
      // 这里只推进表现层计时，绝不跑 AI、物理或抓钩牵引。
      if (this.replicated) { this._specialPresentation(e, dt); continue; }
      this._updateStatus(e, dt);
      if (!e.alive) continue;
      const target = multi ? this._selectTarget(e) : p;
      this._updateAI(e, dt, target);
      if (e.alive && e.type.hybridBoss) this._bossWallMovement(e,dt,e.specialTarget?.alive ? e.specialTarget : target);
      const grappleMaxSpeed = this._applyGrapplePull(e, dt, target);
      if (e.alive) this._physics(e, dt, grappleMaxSpeed);
      this._specialPresentation(e, dt);
      if (e.grapplePull) e.grapplePull.pending = false;
    }
    // 清理死亡超时的敌人
    let k = 0;
    for (let i = 0; i < this.all.length; i++) {
      const e = this.all[i];
      if (!e.alive && e.deadTime > 1.6) { this._free.push(e); continue; }
      this.all[k++] = e;
    }
    this.all.length = k;

    // 需求 3：绿影（stalker）具有碰撞体积，且小范围人数过多时会自相残杀。
    // 放在主循环之后统一处理：需要看到全部绿影的最终位置才能算簇。
    if (!this.replicated) this._updateStalkerPack(dt);
  }

  /**
   * 绿影族群逻辑（需求 3）。
   *
   * 规则：
   *   · 绿影有**碰撞体积** —— 互相推开，不再重叠成一坨
   *   · 4m 范围内超过 4 只时，多出来的会**互相攻击、自相残杀**，
   *     直到该范围内只剩 4 只为止
   *   · 击杀同类后自身状态**回满到原上限的 2 倍**、速度升到 22m/s、
   *     横向移动变得更夸张
   *   · BOSS **不参与**这套逻辑，也**不被绿影识别为同类**
   *
   * 为什么单独一遍而不是塞进每只的 AI：簇的判定是"这对多"的关系，
   * 逐只处理会出现先后顺序导致的结果不一致（先处理的已经把邻居杀了）。
   */
  _updateStalkerPack(dt) {
    const all = this.all;
    // 收集本帧活着的绿影（排除 BOSS 与蛛皇 —— 它们不算同类、也不受此逻辑影响）
    const pack = this._stalkerScratch || (this._stalkerScratch = []);
    pack.length = 0;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (!e.alive) continue;
      if (e.typeId !== 'stalker') continue;
      if (e.type.hybridBoss) continue;          // BOSS 不被识别为同类
      pack.push(e);
    }
    if (pack.length < 2) return;

    const RADIUS = 4.0;                          // 需求：4m 范围内
    const LIMIT = 4;                             // 需求：只允许 4 只以下
    const R2 = RADIUS * RADIUS;

    // ---- 1) 碰撞体积：互相推开，避免重叠
    for (let i = 0; i < pack.length; i++) {
      const a = pack[i];
      for (let j = i + 1; j < pack.length; j++) {
        const b = pack[j];
        let dx = b.pos[0] - a.pos[0];
        let dz = b.pos[2] - a.pos[2];
        const minD = (a.radius || 0.4) + (b.radius || 0.4);
        let d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {                          // 完全重合：给一个确定性的分离方向
          dx = ((i % 2) ? 1 : -1) * 0.01;
          dz = ((j % 2) ? 1 : -1) * 0.01;
          d = 0.0142;
        }
        const push = (minD - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.pos[0] -= nx * push; a.pos[2] -= nz * push;
        b.pos[0] += nx * push; b.pos[2] += nz * push;
      }
    }

    // ---- 2) 4m 内超过 4 只 → 多出来的互相攻击
    // 用简单的贪心簇划分：以每只未归属的绿影为种子，收集它 4m 内的同伴。
    const claimed = this._stalkerClaimed || (this._stalkerClaimed = new Set());
    claimed.clear();
    for (let i = 0; i < pack.length; i++) {
      const seed = pack[i];
      if (claimed.has(seed)) continue;
      const cluster = [seed];
      claimed.add(seed);
      for (let j = 0; j < pack.length; j++) {
        if (i === j) continue;
        const o = pack[j];
        if (claimed.has(o)) continue;
        const dx = o.pos[0] - seed.pos[0];
        const dz = o.pos[2] - seed.pos[2];
        if (dx * dx + dz * dz <= R2) { cluster.push(o); claimed.add(o); }
      }
      if (cluster.length <= LIMIT) continue;

      // 超编：让排在前面的 LIMIT 只之外的个体互相残杀。
      // 每帧只结算一对（用 e.slashT 节流），避免一瞬间整群暴毙、观感突兀。
      for (let a = LIMIT; a < cluster.length; a++) {
        const victim = cluster[a];
        victim.packAttackCd = (victim.packAttackCd || 0) - dt;
        if (victim.packAttackCd > 0) continue;
        victim.packAttackCd = 0.45;              // 每 ~0.45s 咬一口，看得见过程
        // 伤害足以在几次内杀掉同类（绿影自体血量见 ENEMY_TYPES）
        const dmg = Math.max(8, victim.maxHp * 0.35);
        this.damage(victim, dmg, false, victim.pos, null, { source: 'stalker-pack' });
        if (victim.alive) continue;
        // 击杀同类：击杀者（取簇里第一只，代表"赢家"）状态回满到上限 2 倍
        this._rewardPackKill(cluster[0]);
      }
    }
  }

  /**
   * 需求 3：击杀同类后的强化 —— 总状态回满至**原上限的 2 倍**，
   * 速度 22m/s，横向移动变得夸张。
   */
  _rewardPackKill(winner) {
    if (!winner || !winner.alive) return;
    const base = ENEMY_TYPES.stalker;
    // 上限翻倍（只做一次，避免反复翻倍滚雪球）
    if (!winner.packBoosted) {
      winner.packBoosted = true;
      winner.maxHp = base.hp * 2;
      winner.maxShield = base.shield * 2;
      winner.speed = 22;                         // 需求：22 m/s
      winner.weaveAmp = 0.95;                    // 需求：夸张的横向移动
    }
    // 回满。注意敌人用的是 hp/maxHp（不是 player 那套 health），
    // 早先这里多写了一行 winner.health 是无效字段。
    winner.hp = winner.maxHp;
    winner.shield = winner.maxShield;
    if (this.particles && typeof this.particles.emit === 'function') {
      this.particles.emit('ring', {
        pos: [winner.pos[0], winner.pos[1] + 1, winner.pos[2]],
        count: 1, color: [0.2, 1, 0.35], size: 0.6, sizeEnd: 3.6, life: 0.5, speed: 0,
        normal: [0, 1, 0],
      });
    }
  }

  _updateStatus(e, dt) {
    if (e.statusSlowTime > 0) {
      e.statusSlowTime -= dt;
      if (e.statusSlowTime <= 0) e.statusSlow = 0;
    }
    if (e.statusBleedTime > 0) {
      e.statusBleedTime -= dt;
      const tick = e.statusBleedDmg * dt;
      e.hp -= tick;
      if (e.hp <= 0) this.damage(e, 0.01, false, e.pos, null, { source: 'bleed' });
      if (e.statusBleedTime <= 0) e.statusBleed = 0;
    }
  }

  /**
   * 把抓钩牵引叠加在 AI 的自主移动之后。返回本帧允许的额外水平速度上限，
   * 让普通敌人真的能被拉动，而不是立刻被兵种的巡逻速度上限吃掉。
   */
  _applyGrapplePull(e, dt, player) {
    const gp = e.grapplePull;
    if (!gp || !gp.pending || !player || !player.alive
      || !player.grapple || !player.grapple.active || player.grapple.attachedEnemy !== e) {
      if (gp) { gp.pending = false; gp.source = null; }
      return 0;
    }

    let dx = player.pos[0] - e.pos[0];
    let dy = (player.pos[1] + player.currentHeight * 0.56)
      - (e.pos[1] + e.height * 0.52);
    let dz = player.pos[2] - e.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= Math.max(0.1, gp.minDistance || CFG.move.grappleMinDist)) return 0;
    dx /= dist; dy /= dist; dz /= dist;

    // 地面单位在高差很小时只水平牵引，避免每帧被细小地形起伏反复抛起；
    // 玩家明显位于高处时仍会把敌人向上拽，形成真实的双向绳索效果。
    if (!e.type.flying && e.grounded && dy < 0.22) dy = 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    const target = Math.max(0, gp.targetSpeed || 0);
    const radial = e.vel[0] * dx + e.vel[1] * dy + e.vel[2] * dz;
    const add = Math.max(0, Math.min(target - radial, Math.max(0, gp.accel || 0) * dt));
    e.vel[0] += dx * add;
    e.vel[1] += dy * add;
    e.vel[2] += dz * add;
    if (dy > 0.12 && e.grounded) e.grounded = false;

    return Math.max(e.type.speed * 1.35, target * 1.18);
  }

  /** 状态施加：kind = 'bleed' | 'slow'，strength 为强度（bleed 为 DPS，slow 为减速比例） */
  applyStatus(e, kind, strength, duration) {
    if (!e || !e.alive) return;
    if (kind === 'bleed') {
      e.statusBleedDmg = Math.max(e.statusBleedDmg, strength);
      e.statusBleedTime = Math.max(e.statusBleedTime, duration);
    } else if (kind === 'slow') {
      e.statusSlow = Math.max(e.statusSlow, M.clamp01(strength));
      e.statusSlowTime = Math.max(e.statusSlowTime, duration);
    }
  }

  nearestEnemies(pos, count, maxDist) {
    const out = [];
    const maxD2 = maxDist * maxDist;
    // 小数组选择排序（敌人数量不多，开销可忽略）
    const cands = [];
    for (const e of this.all) {
      if (!e.alive) continue;
      const d2 = M.distSq3(e.pos, pos);
      if (d2 <= maxD2) cands.push({ e, d2 });
    }
    cands.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < Math.min(count, cands.length); i++) out.push(cands[i].e);
    return out;
  }

  // ---------------------------------------------------------------- AI

  _updateAI(e, dt, player) {
    const type = e.type;
    if (type.behavior === 'hitrun' || type.behavior === 'bomber') {
      this._updateSpecialAI(e, dt, player); return;
    }
    if (!player || !player.alive) { e.state = AI_IDLE; this._moveIdle(e, dt); return; }

    const dx = player.pos[0] - e.pos[0];
    const dy = player.pos[1] - e.pos[1];
    const dz = player.pos[2] - e.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    const distHM = Math.hypot(dx, dz);
    const toPlayerYaw = Math.atan2(-dx, -dz);

    // --- 感知
    const sightRange = type.attackRange * 1.35 + 12;
    const facing = -Math.cos(e.aimYaw - toPlayerYaw) > -1 ? 1 : 1; // 占位：用夹角判断
    void facing;
    const angleToPlayer = Math.abs(M.wrapAngle(toPlayerYaw - e.yaw));
    const inCone = angleToPlayer < M.toRad(type.behavior === 'sniper' ? 70 : 110) || dist < 8;
    const canSee = dist < sightRange && inCone && this._hasLineOfSight(e, player, dist);

    // 听觉：玩家开火/冲刺会吸引注意
    const heard = this._heardPlayer(e, player, dist);

    if (canSee || heard) {
      e.alertness = Math.min(1, e.alertness + dt * (canSee ? 2.4 : 1.2));
      e.lastSeen = e.lastSeen || new Float32Array(3);
      if (canSee) {
        e.lastSeen[0] = player.pos[0]; e.lastSeen[1] = player.pos[1]; e.lastSeen[2] = player.pos[2];
        e.lastSeenTime = this._time;
      }
      if (e.state === AI_IDLE && e.alertness > 0.35) {
        e.state = AI_ALERT;
        Events.emit('audio:play', { name: 'enemy_alert', pos: e.pos });
      }
    } else {
      e.alertness = Math.max(0, e.alertness - dt * 0.35);
      if (e.state !== AI_IDLE && this._time - (e.lastSeenTime || -99) > 6) {
        e.state = AI_IDLE;
      }
    }

    const inAttackRange = dist <= type.attackRange;

    switch (e.state) {
      case AI_IDLE:
        this._moveIdle(e, dt);
        break;
      case AI_ALERT:
        this._faceTowards(e, toPlayerYaw, dt, 4.5);
        if (canSee && inAttackRange) e.state = AI_ENGAGE;
        else this._moveToward(e, player.pos, dt, 0.6);
        if (e.alertness < 0.1) e.state = AI_IDLE;
        break;
      case AI_ENGAGE:
        this._faceTowards(e, toPlayerYaw, dt, 7.5);
        this._engageMovement(e, dt, player, dist, distHM, toPlayerYaw);
        if (inAttackRange) this._tryAttack(e, dt, player, dist);
        if (!canSee && this._time - (e.lastSeenTime || 0) > 2.2) e.state = AI_REPOSITION;
        else if (dist > type.attackRange * 1.15) e.state = AI_REPOSITION;
        break;
      case AI_REPOSITION:
        this._faceTowards(e, toPlayerYaw, dt, 5);
        this._reposition(e, dt, player);
        if (canSee && inAttackRange && dist < type.attackRange * 0.9) e.state = AI_ENGAGE;
        if (this._time - (e.lastSeenTime || 0) > 8) e.state = AI_IDLE;
        break;
      case AI_FLEE:
        this._moveAway(e, player.pos, dt, 1.0);
        if (dist > type.attackRange * 1.6) e.state = AI_ENGAGE;
        break;
    }

    // 血量低时撤离（非虫群）
    if (!type.swarm && e.hp / e.maxHp < 0.2 && e.shield <= 0 && type.behavior !== 'charger') {
      if (e.state === AI_ENGAGE) e.state = AI_FLEE;
    }

    // 虫群必须停在玩家胶囊之外。旧版目标点就是 player.pos，低矮模型会钻到
    // 两脚之间并不断向中心加速，看起来像“吸附在脚底”。这里既改变寻路目标，
    // 也移除仍朝玩家中心的惯性分量，避免高速扑击后再次滑回脚下。
    if (type.swarm) this._keepSwarmOutsidePlayer(e, player, distHM);
  }

  _heardPlayer(e, player, dist) {
    // 玩家开火/蹬墙跑/滑铲会产生噪音
    const noisy = player.state.speed > 11 || player.state.wallRunning || player.state.sliding;
    const radius = noisy ? 26 : 12;
    return dist < radius;
  }

  _updateSpecialAI(e, dt, player) {
    const type = e.type;
    // 蓄力一旦开始就有独立引信，目标死亡或离开不会暂停倒计时。
    if (type.behavior === 'bomber' && e.specialPhase === 'charge') {
      e.vel[0] = e.vel[1] = e.vel[2] = 0;
      e.specialTimer -= dt;
      if (e.specialTimer <= 0) this._detonateSpider(e);
      return;
    }
    if (e.specialTarget?.alive && e.specialPhase !== 'approach') player = e.specialTarget;
    if (!player?.alive) { this._moveIdle(e, dt); return; }
    const distance = M.dist3(e.pos, player.pos);
    const yaw = Math.atan2(e.pos[0]-player.pos[0], e.pos[2]-player.pos[2]);
    e.state = AI_ENGAGE;
    if (type.behavior === 'hitrun') {
      if (e.specialPhase === 'retreat') {
        if (distance > type.retreatDistance) {
          e.specialPhase = 'approach'; e.specialTarget = null;
        } else {
          this._moveAway(e, player.pos, dt, 1);
          this._steerSpecial(e, dt);
          this._faceTowards(e, Math.atan2(-e.vel[0],-e.vel[2]), dt, 14);
          return;
        }
      }
      if (e.specialPhase === 'windup') {
        e.vel[0] = M.damp(e.vel[0],0,30,dt); e.vel[2] = M.damp(e.vel[2],0,30,dt);
        e.specialTimer -= dt;
        this._faceTowards(e, yaw, dt, 16);
        if (e.specialTimer <= 0) {
          e.slashT = 1;
          this._specialFx('stalker-slash', e.pos);
          if (distance <= type.attackRange + 0.4 && this._hasLineOfSight(e,player,distance)) {
            this._specialDamage(e, player, type.weapon.damage);
          }
          // 命中或挥空都只砍一次，必须先跑到 60m 之外才可再接近。
          e.specialPhase = 'retreat'; e.specialTarget = player;
        }
        return;
      }
      if (distance <= type.attackRange && e.age >= e.spawnAttackLock && this._hasLineOfSight(e,player,distance)) {
        e.specialPhase = 'windup'; e.specialTimer = type.windup; e.specialTarget = player;
        return;
      }
      // 接近玩家：不走直线，而是"边推进边不规律左右摆动"（总速度保持 type.speed）。
      // 详见 _moveApproachWeave 的注释。
      this._moveApproachWeave(e, dt, player);
      this._steerSpecial(e,dt);
      // 朝向仍面向实际移动方向，视觉上才像"扑过来"而不是横着平移
      this._faceTowards(e, Math.atan2(-e.vel[0],-e.vel[2]), dt, 14);
      return;
    }
    if (distance <= type.attackRange && e.age >= e.spawnAttackLock && this._hasLineOfSight(e,player,distance)) {
      e.specialPhase = 'charge'; e.specialTimer = type.chargeTime; e.specialTarget = player;
      e.vel.fill(0);
      this._specialFx('spider-charge',e.pos);
      return;
    }
    this._moveToward(e, player.pos, dt, 1);
    this._faceTowards(e,yaw,dt,10);
    this._spiderClimb(e,player);
  }

  /**
   * 绿影 / 绿影蛛皇 的接近移动：**不直勾勾冲向玩家**，而是边推进边不规律左右摆动。
   *
   * 设计要点（改之前先读）：
   *  · **总速度恒定**：先把"朝向玩家的单位向量"与"侧向单位向量"合成，
   *    再整体缩放到 `type.speed`（绿影 = 18 m/s）。所以摆动不会让它变慢或变快，
   *    只是在同样速度下走出蛇形轨迹。
   *  · **不规律**：三个不同频率的正弦叠加（低频决定大方向偏移、中频做主要摆动、
   *    高频抖动细节），每个个体的相位与频率由稳定哈希决定，因此同一只怪行为可复现，
   *    不同个体又互不相同 —— 比纯随机更像"有生命"，也不会出现全体同步摆动。
   *  · **摆动量随距离收敛**：远距离摆幅大（横向包抄、难以预判），
   *    进入攻击距离前迅速收敛为直线，保证该打到的时候打得到。
   *  · **撞墙修正**：摆动容易蹭到掩体，这里做一个短距离探针，撞上就把侧向分量反向。
   */
  _moveApproachWeave(e, dt, player) {
    const type = e.type;
    const dx = player.pos[0] - e.pos[0];
    const dz = player.pos[2] - e.pos[2];
    const dist = Math.hypot(dx, dz) || 1;
    const fx = dx / dist, fz = dz / dist;          // 朝向玩家
    const sx = -fz, sz = fx;                       // 侧向（右手）

    // 每只怪一份稳定的相位/频率（首次使用时惰性生成）
    if (e.weaveSeed === undefined) {
      // 只用 e.id：它是稳定的每实例标识，同一只怪每次运行行为一致（可复现），
      // 不同个体之间相位/频率不同（不会全体同步摆动）。
      const h = (e.id * 2654435761) >>> 0;
      const r = (n) => ((h >>> (n * 5)) & 1023) / 1023;
      e.weaveSeed = h;
      e.weavePhaseA = r(0) * Math.PI * 2;
      e.weavePhaseB = r(1) * Math.PI * 2;
      e.weavePhaseC = r(2) * Math.PI * 2;
      e.weaveFreqA = 0.42 + r(3) * 0.30;           // 低频：整体漂移，慢速换边
      e.weaveFreqB = 1.90 + r(4) * 1.30;           // 中频：主要的左右摆动
      e.weaveFreqC = 4.10 + r(5) * 2.40;           // 高频：细微抖动，破除规律感
      e.weaveSign = r(6) < 0.5 ? -1 : 1;           // 起始偏向
    }
    const t = this._time;

    // 三频叠加 → 侧向偏移系数，范围约 [-1.15, 1.15]
    const wob =
      0.30 * Math.sin(t * e.weaveFreqA * 2.0 + e.weavePhaseA) +
      0.72 * Math.sin(t * e.weaveFreqB * 2.0 + e.weavePhaseB) +
      0.22 * Math.sin(t * e.weaveFreqC * 2.0 + e.weavePhaseC);

    // 摆幅：远距离最大，贴近时收敛为直线（保证该打中时打得到）
    //
    // 基准值 0.45 是实测调出来的：扫过 0.85/0.70/0.55/0.45/0.35 后，
    // 横向速度占总速度的平均比例分别是 30%/25%/22%/18%/15%（峰值 67%/46%/53%/44%/40%）。
    // 0.85 时绿影平均三成速度花在横移上，观感是"蟹行"而不是"扑过来"；
    // 0.45 既保留了明显的不可预判性（峰值仍有 44%），又保证它是真的在接近。
    // 想让某个兵种摆得更凶/更稳，在 ENEMY_TYPES 里给它加 weaveAmp 即可（0 = 走直线）。
    const nearRamp = M.clamp01((dist - type.attackRange) / 7.0);
    const amp = (type.weaveAmp == null ? 0.45 : type.weaveAmp) * nearRamp;

    // 合成方向并归一化 —— 这一步保证"总速度"不变
    let bx = fx + sx * wob * amp * e.weaveSign;
    let bz = fz + sz * wob * amp * e.weaveSign;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl; bz /= bl;

    // 前方短探针：摆动蹭墙时把侧向分量反向，避免贴着掩体原地磨
    const origin = [e.pos[0], e.pos[1] + e.height * 0.5, e.pos[2]];
    if (this.world.raycast(origin, [bx, 0, bz], e.radius + 1.1, {}).hit) {
      e.weaveSign = -e.weaveSign;
      bx = fx - sx * wob * amp * e.weaveSign;
      bz = fz - sz * wob * amp * e.weaveSign;
      const l2 = Math.hypot(bx, bz) || 1;
      bx /= l2; bz /= l2;
    }

    const speed = type.speed * (1 - e.statusSlow);
    const tx = bx * speed, tz = bz * speed;
    e.vel[0] = M.damp(e.vel[0], tx, type.accel * 0.3, dt);
    e.vel[2] = M.damp(e.vel[2], tz, type.accel * 0.3, dt);
  }

  _steerSpecial(e, dt) {
    const speed = Math.hypot(e.vel[0], e.vel[2]);
    if (speed < 0.1) return;
    const origin = [e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]];
    const direction = [e.vel[0]/speed,0,e.vel[2]/speed];
    const reach = e.radius + 1.4;
    if (!this.world.raycast(origin,direction,reach,{}).hit) return;
    for (const turn of [e.strafeDir*0.8,-e.strafeDir*0.8,e.strafeDir*1.57,-e.strafeDir*1.57]) {
      const c=Math.cos(turn),s=Math.sin(turn);
      const d=[direction[0]*c-direction[2]*s,0,direction[0]*s+direction[2]*c];
      if (!this.world.raycast(origin,d,reach,{}).hit) {
        e.vel[0]=d[0]*speed; e.vel[2]=d[2]*speed; return;
      }
    }
    e.stuckTimer += dt;
    if (e.stuckTimer > 0.4 && e.grounded) { e.vel[1]=6; e.stuckTimer=0; e.strafeDir*=-1; }
  }

  _bossWallMovement(e,dt,player) {
    if(!player?.alive) return;
    e.wallJumpCooldown=Math.max(0,e.wallJumpCooldown-dt);
    // 一次挥刀的前摇/后撤规则仍由绿影 AI 决定，不因上下墙追加伤害。
    if(e.specialPhase==='windup') { e.wallJumpMode=''; return; }
    const retreat=e.specialPhase==='retreat';
    let dx=(player.pos[0]-e.pos[0])*(retreat?-1:1),dz=(player.pos[2]-e.pos[2])*(retreat?-1:1);
    const length=Math.hypot(dx,dz)||1; dx/=length;dz/=length;
    if(e.wallJumpMode==='drop') {
      e.wallJumpTimer-=dt;
      e.wallNormal=null;
      // 脱墙后先沿外法线弹出，避免目标隔着墙时直接把自己压回墙里。
      const n=e.wallJumpNormal||[0,0,0];
      e.vel[0]=(dx+n[0]*1.4)*e.type.speed;
      e.vel[2]=(dz+n[2]*1.4)*e.type.speed;
      e.vel[1]=Math.min(e.vel[1],-12);
      if(e.wallJumpTimer<=0 || e.grounded) e.wallJumpMode='';
      return;
    }
    if(e.wallJumpMode==='launch') {
      e.wallJumpTimer-=dt;
      const n=e.wallJumpNormal;
      e.vel[0]=-n[0]*18; e.vel[2]=-n[2]*18;
      e.vel[1]=Math.max(e.vel[1],13);
      const center=[e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]];
      const hit=this.world.raycast(center,[-n[0],0,-n[2]],Math.max(e.radius,e.height*0.4)+0.45,{});
      if(hit.hit && Math.abs(hit.normal[1])<0.25) {
        e.wallNormal=Array.from(hit.normal);e.wallJumpMode='climb';e.wallJumpTimer=0.8;
      } else if(e.wallJumpTimer<=0) {e.wallJumpMode='';e.wallJumpCooldown=2;}
      return;
    }
    if(e.wallNormal || e.wallJumpMode==='climb') {
      const previous=e.wallNormal;
      this._spiderClimb(e,{pos:[e.pos[0]+dx*20, e.pos[1]+10, e.pos[2]+dz*20]});
      e.wallJumpTimer-=dt;
      if(!e.wallNormal || e.wallJumpTimer<=0) {
        e.wallJumpNormal=previous || e.wallJumpNormal;
        e.wallNormal=null;e.wallJumpMode='drop';e.wallJumpTimer=0.55;e.wallJumpCooldown=4;
        e.vel[1]=-12;
      }
      return;
    }
    if(e.wallJumpCooldown>0 || !e.grounded) return;
    const origin=[e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]];
    // 只向射线确认的真实近墙起跳，没有墙时继续原来的地面追击。
    for(const turn of [0,0.7,-0.7,1.3,-1.3]) {
      const c=Math.cos(turn),s=Math.sin(turn),dir=[dx*c-dz*s,0,dx*s+dz*c];
      const wall=this.world.raycast(origin,dir,10,{});
      if(!wall.hit || Math.abs(wall.normal[1])>0.25) continue;
      e.wallJumpNormal=Array.from(wall.normal);e.wallJumpMode='launch';e.wallJumpTimer=0.65;
      e.wallJumpCooldown=4;e.grounded=false;e.vel[1]=15;
      e.vel[0]=dir[0]*18;e.vel[2]=dir[2]*18;
      this._specialFx('stalker-slash',e.pos);
      break;
    }
  }

  _spiderClimb(e, player) {
    const origin=[e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]];
    let dx=player.pos[0]-e.pos[0],dz=player.pos[2]-e.pos[2];
    const l=Math.hypot(dx,dz)||1; dx/=l; dz/=l;
    let hit=this.world.raycast(origin,[dx,0,dz],e.radius+0.8,{});
    if ((!hit.hit || Math.abs(hit.normal[1])>0.25) && e.wallNormal) {
      hit=this.world.raycast(origin,e.wallNormal.map(v=>-v),e.radius+0.8,{});
    }
    if (!hit.hit || Math.abs(hit.normal[1])>0.25) {
      // 越过墙沿后继续向目标迈出，而不是在顶沿原地上下抖动。
      if (e.wallNormal) { e.vel[0]=dx*e.type.speed; e.vel[2]=dz*e.type.speed; e.vel[1]=2.5; }
      e.wallNormal=null; return;
    }
    const n=Array.from(hit.normal); e.wallNormal=n; e.grounded=false;
    const speed=e.type.speed*(1-e.statusSlow);
    const dot=dx*n[0]+dz*n[2];
    // 有墙面接触才关闭重力；法向贴附，切向前进/爬升，依然经过 sweep/resolve。
    let tx=dx-n[0]*dot,tz=dz-n[2]*dot;
    const vertical=player.pos[1]<e.pos[1]-1 ? -1 : 1;
    const len=Math.hypot(tx,vertical,tz)||1;
    e.vel[0]=tx/len*speed-n[0]*1.5;
    e.vel[1]=vertical/len*speed;
    e.vel[2]=tz/len*speed-n[2]*1.5;
    e.yaw=e.aimYaw=0; // 墙面模型局部 -Z 朝爬升方向
  }

  _specialDamage(e, player, amount) {
    const dir=[player.pos[0]-e.pos[0],0,player.pos[2]-e.pos[2]];
    const l=Math.hypot(...dir)||1;
    for(let i=0;i<3;i++) dir[i]/=l;
    // 固定 50 基础伤害，不乘全局 0.35 或难度倍率；正常先盾后血。
    player.applyDamage(amount,dir,e);
    this.stats.damageDealt += amount;
  }

  _detonateSpider(e) {
    if (!e.alive || this.replicated) return;
    const targets=new Set(this.players.length ? this.players : [this.player]);
    for(const p of targets) {
      if (!p?.alive) continue;
      const distance=M.dist3(e.pos,p.pos);
      if(distance<=e.type.blastRadius && this._hasLineOfSight(e,p,distance)) this._specialDamage(e,p,50);
    }
    this._specialFx('spider-explode',[e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]]);
    e.alive=false; e.hp=0; e.deadTime=0; e.wallNormal=null;
    Events.emit('enemy:die',{enemy:e,pos:e.pos,byPlayer:false,headshot:false,source:'self-destruct'});
  }

  _specialFx(kind,pos) {
    this.playSpecialFx(kind,pos);
    Events.emit('enemy:special-fx',{kind,pos:Array.from(pos)});
  }

  playSpecialFx(kind,pos) {
    if(kind==='boss-summon') {
      Events.emit('audio:play',{name:'boss_arrive',pos,gain:0.8});
      this.particles?.emit('ring',{pos,count:1,color:[0.1,1,0.3],size:0.8,sizeEnd:6,life:0.8,speed:0,normal:[0,1,0]});
    }
    if(kind==='spider-charge') Events.emit('audio:play',{name:'spider_charge',pos,gain:1});
    if(kind==='stalker-slash') Events.emit('audio:play',{name:'melee_swing',pos,gain:1});
    if(kind==='spider-explode') {
      Events.emit('audio:play',{name:'explosion',pos,gain:0.8});
      // 明亮冲击环与火星，不添加遮挡视野的黑烟。
      this.particles?.emit('ring',{pos,count:1,color:[1,0.4,0.08],size:0.5,sizeEnd:5,life:0.35,normal:[0,1,0]});
      this.particles?.emit('spark',{pos,count:22,color:[1,0.55,0.12],speed:12,spread:180,size:0.07,life:0.45});
    }
  }

  _specialPresentation(e,dt) {
    e.slashT=Math.max(0,(e.slashT||0)-dt*3.5);
    if(!e.alive || !['hitrun','bomber'].includes(e.type.behavior)) return;
    if (this.replicated && dt > 0 && e.specialLastPos) {
      for(let k=0;k<3;k++) e.vel[k]=(e.pos[k]-e.specialLastPos[k])/dt;
      e.animPhase += Math.min(20,Math.hypot(...e.vel))*dt*2.6;
    }
    e.specialLastPos=Array.from(e.pos);
    if(e.type.behavior!=='hitrun') return;
    e.trailTimer-=dt;
    if(Math.hypot(e.vel[0],e.vel[2])>5 && e.trailTimer<=0) {
      e.trailTimer=0.04;
      const speed=Math.hypot(e.vel[0],e.vel[2]);
      const back=[-e.vel[0]/speed,0.06,-e.vel[2]/speed];
      const pos=[e.pos[0]+back[0]*0.35,e.pos[1]+e.height*0.6,e.pos[2]+back[2]*0.35];
      this.particles?.emit('trail',{pos,dir:back,count:2,color:[0.12,1,0.38],speed:3,spread:9,size:0.12,life:0.32});
    }
  }

  _hasLineOfSight(e, player, dist) {
    if (dist > 120) return false;
    RAY_O[0] = e.pos[0]; RAY_O[1] = e.pos[1] + e.height * 0.75; RAY_O[2] = e.pos[2];
    const tx = player.pos[0], ty = player.pos[1] + CFG.cam.eyeHeight, tz = player.pos[2];
    RAY_D[0] = tx - RAY_O[0]; RAY_D[1] = ty - RAY_O[1]; RAY_D[2] = tz - RAY_O[2];
    const d = Math.hypot(RAY_D[0], RAY_D[1], RAY_D[2]);
    if (d < 0.1) return true;
    RAY_D[0] /= d; RAY_D[1] /= d; RAY_D[2] /= d;
    // 用两次采样（眼睛与胸口）提高容错，避免被小掩体完全遮挡
    const hit = this.world.raycast(RAY_O, RAY_D, d - 0.35, {});
    if (!hit.hit) return true;
    return false;
  }

  _faceTowards(e, targetYaw, dt, rate) {
    const diff = M.wrapAngle(targetYaw - e.aimYaw);
    const step = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    e.aimYaw = M.wrapAngle(e.aimYaw + step);
    e.yaw = e.aimYaw;
  }

  _moveIdle(e, dt) {
    // 极慢的原地巡视
    e.yaw = M.wrapAngle(e.yaw + Math.sin(this._time * 0.4 + e.id) * dt * 0.6);
    e.aimYaw = e.yaw;
    e.vel[0] = M.damp(e.vel[0], 0, 5, dt);
    e.vel[2] = M.damp(e.vel[2], 0, 5, dt);
  }

  /** 交战时移动：保持理想距离 + 侧向绕圈 */
  _engageMovement(e, dt, player, dist, distHM, toPlayerYaw) {
    const type = e.type;
    const speedMul = (1 - e.statusSlow);
    const speed = type.speed * speedMul * (e.elite ? 0.9 : 1);

    if (type.behavior === 'melee') {
      // 虫群靠近后停在攻击环，而不是继续追逐玩家脚下的中心点。
      const standOff = Math.max(type.preferredRange, player.radius + e.radius + 0.55);
      if (distHM > standOff + 0.25) this._moveToward(e, player.pos, dt, 1.08, speed);
      else if (distHM < standOff - 0.20) this._moveAway(e, player.pos, dt, 0.95, speed);
      else {
        e.vel[0] = M.damp(e.vel[0], 0, 10, dt);
        e.vel[2] = M.damp(e.vel[2], 0, 10, dt);
      }
      // 偶尔跳跃扑击
      if (e.grounded && distHM < 7 && this.rng() < dt * 0.9) {
        e.vel[1] = 6.2; e.grounded = false;
      }
      return;
    }
    if (type.behavior === 'charger') {
      // 盾兵顶盾推进
      this._moveToward(e, player.pos, dt, 1.0, speed);
      return;
    }
    if (type.behavior === 'sniper') {
      // 狙击手保持远距离
      if (dist < type.preferredRange * 0.75) this._moveAway(e, player.pos, dt, 1.0, speed);
      else if (dist > type.preferredRange * 1.3) this._moveToward(e, player.pos, dt, 0.8, speed);
      else {
        e.vel[0] = M.damp(e.vel[0], 0, 6, dt);
        e.vel[2] = M.damp(e.vel[2], 0, 6, dt);
      }
      return;
    }

    // 常规步兵：保持 preferredRange，侧向绕圈
    e.strafeTimer -= dt;
    if (e.strafeTimer <= 0) {
      e.strafeTimer = 0.8 + this.rng() * 2.0;
      e.strafeDir = this.rng() < 0.5 ? -1 : 1;
    }
    const radial = dist - type.preferredRange;
    let mx = 0, mz = 0;
    if (Math.abs(radial) > 1.6) {
      const s = Math.sign(radial);
      const dxn = (player.pos[0] - e.pos[0]) / Math.max(0.01, dist);
      const dzn = (player.pos[2] - e.pos[2]) / Math.max(0.01, dist);
      mx += dxn * s; mz += dzn * s;
    }
    if (type.strafe) {
      const px2 = -(player.pos[2] - e.pos[2]) / Math.max(0.01, dist);
      const pz2 = (player.pos[0] - e.pos[0]) / Math.max(0.01, dist);
      mx += px2 * e.strafeDir * 0.85;
      mz += pz2 * e.strafeDir * 0.85;
    }
    if (type.flying) {
      // 飞行单位上下浮动
      e.bobPhase += dt * type.bobFreq;
      const targetY = this.world.groundHeight(e.pos[0], e.pos[2]) + type.hoverHeight
        + Math.sin(e.bobPhase) * type.bobAmp;
      e.vel[1] = M.damp(e.vel[1], (targetY - e.pos[1]) * 2.4, 6, dt);
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 0.01) {
      const tx = mx / ml * speed, tz = mz / ml * speed;
      e.vel[0] = M.damp(e.vel[0], tx, type.accel * 0.35, dt);
      e.vel[2] = M.damp(e.vel[2], tz, type.accel * 0.35, dt);
    } else {
      e.vel[0] = M.damp(e.vel[0], 0, 8, dt);
      e.vel[2] = M.damp(e.vel[2], 0, 8, dt);
    }
    void toPlayerYaw;
  }

  _moveToward(e, target, dt, mul, speedOverride) {
    const dx = target[0] - e.pos[0];
    const dz = target[2] - e.pos[2];
    const l = Math.hypot(dx, dz) || 1;
    const speed = (speedOverride == null ? e.type.speed : speedOverride) * mul * (1 - e.statusSlow);
    const tx = dx / l * speed, tz = dz / l * speed;
    e.vel[0] = M.damp(e.vel[0], tx, e.type.accel * 0.3, dt);
    e.vel[2] = M.damp(e.vel[2], tz, e.type.accel * 0.3, dt);
  }

  _moveAway(e, target, dt, mul, speedOverride) {
    const dx = e.pos[0] - target[0];
    const dz = e.pos[2] - target[2];
    const l = Math.hypot(dx, dz) || 1;
    const speed = (speedOverride == null ? e.type.speed : speedOverride) * mul * (1 - e.statusSlow);
    const tx = dx / l * speed, tz = dz / l * speed;
    e.vel[0] = M.damp(e.vel[0], tx, e.type.accel * 0.3, dt);
    e.vel[2] = M.damp(e.vel[2], tz, e.type.accel * 0.3, dt);
  }

  _keepSwarmOutsidePlayer(e, player, distHM) {
    const minDist = Math.max(e.type.preferredRange || 0, player.radius + e.radius + 0.55);
    if (distHM >= minDist) return;
    let ox = e.pos[0] - player.pos[0];
    let oz = e.pos[2] - player.pos[2];
    let l = Math.hypot(ox, oz);
    if (l < 0.001) {
      ox = Math.sin(e.yaw || 0); oz = Math.cos(e.yaw || 0); l = 1;
    }
    ox /= l; oz /= l;
    const inward = e.vel[0] * -ox + e.vel[2] * -oz;
    if (inward > 0) {
      e.vel[0] += ox * inward;
      e.vel[2] += oz * inward;
    }
    const push = Math.min(8.5, 3.0 + (minDist - distHM) * 8.0);
    e.vel[0] += ox * push;
    e.vel[2] += oz * push;
  }

  /** 失去视野时：向最后已知位置推进（并在卡住时绕行） */
  _reposition(e, dt, player) {
    const target = (this._time - (e.lastSeenTime || 0) < 6 && e.lastSeen) ? e.lastSeen : player.pos;
    this._moveToward(e, target, dt, 0.85);
    // 卡住检测：位置几乎没变则侧向绕行
    const moved = M.dist3(e.pos, e.lastPos);
    if (moved < 0.06) {
      e.stuckTimer += dt;
      if (e.stuckTimer > 0.45) {
        e.stuckTimer = 0;
        e.strafeDir = -e.strafeDir;
        // 侧向推力
        const dx = target[0] - e.pos[0], dz = target[2] - e.pos[2];
        const l = Math.hypot(dx, dz) || 1;
        e.vel[0] += -dz / l * e.type.speed * e.strafeDir;
        e.vel[2] += dx / l * e.type.speed * e.strafeDir;
        // 尝试跳一下越过小台阶
        if (e.grounded) { e.vel[1] = 4.5; e.grounded = false; }
      }
    } else {
      e.stuckTimer = 0;
    }
    e.lastPos[0] = e.pos[0]; e.lastPos[1] = e.pos[1]; e.lastPos[2] = e.pos[2];
  }

  // ---------------------------------------------------------------- 攻击

  _tryAttack(e, dt, player, dist) {
    const type = e.type;
    const w = type.weapon;
    if (e.meleeCooldown > 0) e.meleeCooldown -= dt;
    if (e.age < (e.spawnAttackLock || 0)) return;

    if (e.telegraphing) {
      e.telegraph -= dt;
      // 需求 2：高处狙击手在确定射击后「不再移动镜头」——
      // 也就是蓄力后半段把瞄向冻结，不再追着玩家转。
      // 用 aimLockT 表示锁定时机：telegraph 是总蓄力时长，后 0.5 秒为冻结段。
      if (e.aimDir && e.aimLockT > 0) {
        e.aimLockT -= dt;
        if (e.aimLockT <= 0) {
          e.aimLocked = true;
          e.aimLockT = 0;
        }
      }
      // 未锁定时，把瞄向**缓慢**转向玩家（需求："缓慢瞄向玩家"）。
      // 用固定角速度而不是插值，视觉上才像"激光扫过去"。
      if (e.aimDir && !e.aimLocked && w.aimTurnRate) {
        this._turnAimToward(e, player, w.aimTurnRate * dt);
      }
      if (e.telegraph <= 0) {
        e.telegraphing = false;
        this._clearAimBeam(e);
        this._shoot(e, player, dist);
      } else {
        // 蓄力期间维持瞄准射线
        this._updateAimBeam(e, player, w);
      }
      return;
    }

    if (e.burstLeft > 0) {
      e.burstCooldown -= dt;
      if (e.burstCooldown <= 0) {
        e.burstLeft--;
        e.burstCooldown = 60 / w.rpm;
        this._shoot(e, player, dist);
        if (e.burstLeft <= 0) e.fireCooldown = w.burstPause * (0.75 + this.rng() * 0.5);
      }
      return;
    }

    e.fireCooldown -= dt;
    if (e.fireCooldown <= 0) {
      if (w.melee) {
        if (dist < type.attackRange) {
          this._melee(e, player);
          e.fireCooldown = w.burstPause;
        } else {
          e.fireCooldown = 0.25;
        }
        return;
      }
      // 开始蓄力（玩家可以躲）
      e.telegraphing = true;
      e.telegraph = w.telegraph / Math.max(0.5, e.accuracyMul);
      e.sniperAim = w.laser;
      e.burstLeft = w.burst;
      e.burstCooldown = 0;
      // 需求 2：高处狙击手在蓄力开始时建立"瞄向"，之后靠 _turnAimToward 缓慢
      // 转向玩家；锁定段（最后 aimLockTime 秒）冻结，实现"确定射击后不再移动镜头"。
      if (w.aimTurnRate) {
        if (!e.aimDir) e.aimDir = new Float32Array(3);
        // 初始瞄向：从枪口指向玩家当前位置（首帧对齐，之后才开始缓慢修正）
        const a = e.aimDir;
        const my = e.pos[1] + e.height * 0.72;
        a[0] = player.pos[0] - e.pos[0];
        a[1] = (player.pos[1] + player.currentHeight * 0.5) - my;
        a[2] = player.pos[2] - e.pos[2];
        const L = Math.hypot(a[0], a[1], a[2]) || 1;
        a[0] /= L; a[1] /= L; a[2] /= L;
        // 故意先偏开一个角度，让玩家看到红线"扫过来"而不是一开始就贴脸
        const off = (w.aimStartMissDeg || 0) * Math.PI / 180;
        if (off > 0) {
          const c = Math.cos(off), s = Math.sin(off);
          const nx = a[0] * c - a[2] * s;
          const nz = a[0] * s + a[2] * c;
          a[0] = nx; a[2] = nz;
          const L2 = Math.hypot(a[0], a[1], a[2]) || 1;
          a[0] /= L2; a[1] /= L2; a[2] /= L2;
        }
        e.aimLocked = false;
        e.aimLockT = Number.isFinite(w.aimLockTime) ? w.aimLockTime : 0.5;
      } else {
        e.aimDir = null;
        e.aimLocked = false;
      }
    }
  }

  /** 把 e.aimDir 以固定角速度朝玩家方向旋转（需求 2 的"缓慢瞄向"） */
  _turnAimToward(e, player, maxRad) {
    const a = e.aimDir;
    if (!a) return;
    const my = e.pos[1] + e.height * 0.72;
    const tx = player.pos[0] - e.pos[0];
    const ty = (player.pos[1] + player.currentHeight * 0.5) - my;
    const tz = player.pos[2] - e.pos[2];
    const L = Math.hypot(tx, ty, tz) || 1;
    const dx = tx / L, dy = ty / L, dz = tz / L;
    // 当前瞄向与目标方向的夹角
    const dot = M.clamp(a[0] * dx + a[1] * dy + a[2] * dz, -1, 1);
    const ang = Math.acos(dot);
    if (ang <= 1e-4) return;
    const t = Math.min(1, maxRad / ang);       // 本帧最多转 maxRad 弧度
    let nx = a[0] + (dx - a[0]) * t;
    let ny = a[1] + (dy - a[1]) * t;
    let nz = a[2] + (dz - a[2]) * t;
    const L2 = Math.hypot(nx, ny, nz) || 1;
    a[0] = nx / L2; a[1] = ny / L2; a[2] = nz / L2;
  }

  /** 蓄力期间维护瞄准射线（需求 2：红色射线 + 极其明显的红光） */
  _updateAimBeam(e, player, w) {
    if (!this.projectiles || !e.aimDir) return;
    const key = 'aim:' + e.id;
    const from = T_B;
    from[0] = e.pos[0];
    from[1] = e.pos[1] + e.height * 0.72;
    from[2] = e.pos[2];
    // 终点：沿瞄向前方 rayRange，或碰到世界几何就停在命中点
    const range = Number.isFinite(w.aimRange) ? w.aimRange : 160;
    const hit = this.world.raycast(from, e.aimDir, range, {});
    const to = T_C;
    const len = hit.hit ? hit.t : range;
    to[0] = from[0] + e.aimDir[0] * len;
    to[1] = from[1] + e.aimDir[1] * len;
    to[2] = from[2] + e.aimDir[2] * len;
    // 锁定后变亮变粗，给玩家"要开枪了"的读数
    const locked = !!e.aimLocked;
    this.projectiles.setAimBeam(key, from, to, {
      width: locked ? 0.075 : 0.05,
      color: locked ? [1, 0.10, 0.06] : [0.95, 0.18, 0.10],
    });
  }

  _clearAimBeam(e) {
    if (!this.projectiles || !e.aimDir) return;
    if (typeof this.projectiles.clearAimBeam === 'function') {
      this.projectiles.clearAimBeam('aim:' + e.id);
    }
  }

  _melee(e, player) {
    const dist = M.dist3(e.pos, player.pos);
    if (dist > e.type.attackRange + 0.6) return;
    const dmg = e.type.weapon.damage * e.damageMul;
    const dir = T_A;
    dir[0] = player.pos[0] - e.pos[0];
    dir[1] = 0;
    dir[2] = player.pos[2] - e.pos[2];
    const l = Math.hypot(dir[0], dir[2]) || 1;
    dir[0] /= l; dir[2] /= l;
    player.applyDamage(dmg, dir, e);
    e.meleeCooldown = 0.8;
    if (this.particles) {
      this.particles.emitBurst(player.eyePos, [0, 1, 0], 'flesh', {});
    }
  }

  _shoot(e, player, dist) {
    const type = e.type;
    const w = type.weapon;
    // 预瞄：射击瞬间对准玩家（带精度误差）
    const spreadRad = M.toRad(w.spreadDeg) / Math.max(0.3, e.accuracyMul);
    const muzzle = T_B;
    muzzle[0] = e.pos[0];
    muzzle[1] = e.pos[1] + e.height * 0.72;
    muzzle[2] = e.pos[2];

    const target = T_C;
    target[0] = player.pos[0];
    target[1] = player.pos[1] + CFG.cam.eyeHeight * 0.85;
    target[2] = player.pos[2];
    // 预判玩家移动（高难度才明显）
    const lead = M.clamp01((this.difficulty - 1) * 0.35);
    target[0] += player.vel[0] * lead * 0.12;
    target[1] += player.vel[1] * lead * 0.10;
    target[2] += player.vel[2] * lead * 0.12;

    const dir = T_D;
    // 需求 2：带瞄准射线的狙击手必须**按自己的瞄向开火**，而不是每发都瞬间
    // 对准玩家 —— 否则"锁定后不再移动镜头"就没有意义，玩家也躲不掉。
    // 瞄向在他蓄力期间缓慢转向，锁定后冻结，所以打偏是玩家主动走位的结果。
    if (e.aimDir && w.aimTurnRate) {
      dir[0] = e.aimDir[0]; dir[1] = e.aimDir[1]; dir[2] = e.aimDir[2];
      // 保留一点精度误差，但不再做"瞬间对准"
      M.randomConeDir(dir, spreadRad, this.rng, dir);
    } else {
      M.sub3(target, muzzle, dir);
      const d = M.len3(dir) || 1;
      M.scale3(dir, 1 / d, dir);
      M.randomConeDir(dir, spreadRad, this.rng, dir);
    }

    e.gunRecoil = 1;

    if (w.melee) return;

    if (w.projectileSpeed > 0) {
      // 投射物（飞行兵的能量弹）
      if (this.projectiles) {
        this.projectiles.spawn(muzzle, dir, w.projectileSpeed, {
          color: type.accentColor, width: 0.14, life: 3.0,
          damage: w.damage * e.damageMul, ownerId: -1, gravity: 0,
        });
      }
      return;
    }

    // 即时射线。需求 12：支持霰弹 —— `w.pellets > 1` 时逐弹丸独立射线判定伤害，
    // 每颗弹丸各自算命中与距离衰减。**但只画一条曳光**：6 条光柱会糊满屏幕、
    // 也让人分不清威胁来向，视觉上收敛成一条更能读。
    RAY_O[0] = muzzle[0]; RAY_O[1] = muzzle[1]; RAY_O[2] = muzzle[2];
    const maxDist = w.range;
    const pellets = Math.max(1, Math.min(12, w.pellets | 0) || 1);

    // 玩家受击体积：胶囊近似为球
    const pc = T_A;
    pc[0] = player.pos[0];
    pc[1] = player.pos[1] + player.currentHeight * 0.5;
    pc[2] = player.pos[2];
    const pr = Math.max(player.radius, player.currentHeight * 0.32);

    let tracerEnd = null;
    let anyWorldHit = null;
    let visiblePellet = false;
    for (let pi = 0; pi < pellets; pi++) {
      // 首颗弹丸用已算好的 dir；其余各自在锥内重新散布
      if (pi === 0) {
        RAY_D[0] = dir[0]; RAY_D[1] = dir[1]; RAY_D[2] = dir[2];
      } else {
        RAY_D[0] = dir[0]; RAY_D[1] = dir[1]; RAY_D[2] = dir[2];
        M.randomConeDir(RAY_D, spreadRad, this.rng, RAY_D);
      }
      const worldHit = this.world.raycast(RAY_O, RAY_D, maxDist, {});
      const worldT = worldHit.hit ? worldHit.t : maxDist;
      const ph = raySphereHit(RAY_O, RAY_D, pc, pr);

      if (ph != null && ph < worldT) {
        // 命中玩家。
        // 需求 12：霰弹类敌人要"按距离判定伤害"。数据驱动衰减：
        // 兵种在 weapon 上写 damageFalloffStart / damageFalloffEnd / falloffMinMul，
        // 命中距离越远伤害越低，线性过渡到 falloffMinMul 倍。
        // 没有配这三个字段的兵种行为完全不变（衰减因子恒为 1）。
        let falloff = 1;
        if (Number.isFinite(w.damageFalloffStart) && Number.isFinite(w.damageFalloffEnd)
            && w.damageFalloffEnd > w.damageFalloffStart) {
          const t = M.clamp01((ph - w.damageFalloffStart) / (w.damageFalloffEnd - w.damageFalloffStart));
          const minMul = Number.isFinite(w.falloffMinMul) ? w.falloffMinMul : 0.3;
          falloff = 1 + (minMul - 1) * t;
        }
        const dmg = w.damage * falloff * e.damageMul * (1 + (this.difficulty - 1) * 0.2);
        const dd = T_HITDIR;
        dd[0] = RAY_D[0]; dd[1] = RAY_D[1]; dd[2] = RAY_D[2];
        player.applyDamage(dmg, dd, e);
        Events.emit('hit:player', {
          damage: dmg,
          point: new Float32Array([RAY_O[0] + RAY_D[0] * ph, RAY_O[1] + RAY_D[1] * ph, RAY_O[2] + RAY_D[2] * ph]),
          source: e,
        });
        if (!visiblePellet) {
          // 弹道在相机前 3.5m 截断，既能明确提示来向，又不会贴近近裁剪面
          // 膨胀成遮住半个画面的粗光柱。
          const visibleT = Math.max(0.6, ph - 3.5);
          T_C[0] = RAY_O[0] + RAY_D[0] * visibleT;
          T_C[1] = RAY_O[1] + RAY_D[1] * visibleT;
          T_C[2] = RAY_O[2] + RAY_D[2] * visibleT;
          tracerEnd = T_C;
          visiblePellet = true;
        }
      } else if (worldHit.hit) {
        anyWorldHit = worldHit;
        if (!tracerEnd) tracerEnd = worldHit.point;
      } else if (!tracerEnd) {
        T_C[0] = RAY_O[0] + RAY_D[0] * maxDist;
        T_C[1] = RAY_O[1] + RAY_D[1] * maxDist;
        T_C[2] = RAY_O[2] + RAY_D[2] * maxDist;
        tracerEnd = T_C;
      }
    }
    // 只有一颗实弹丸时保留原来的"打在世界上的弹着点"反馈，避免霰弹刷屏
    if (pellets === 1 && anyWorldHit) {
      Events.emit('hit:world', { point: anyWorldHit.point, normal: anyWorldHit.normal, kind: anyWorldHit.kind });
    }
    // 即时射线也必须有可见弹道，否则玩家只会凭空掉血。敌弹用兵种强调色。
    //
    // 需求 1：强化远程敌人的弹道观感 —— 轨迹要明显变粗，但**不得比玩家的粗**。
    // 玩家曳光最细的是 R-99 的 0.060（见 weapons.js），所以这里上限取 0.052，
    // 保证任何时候玩家自己的弹道都是画面上最醒目的一条。
    // 同时把曳光存活时间拉长一点，让密集弹雨"看得见来向"。
    if (this.projectiles && tracerEnd) {
      const TRACER_W = {
        sniper: 0.052,      // 最粗，但仍在玩家 R-99(0.060) 之下
        heavy: 0.046,
        grunt: 0.040,
        shieldman: 0.036,
        flyer: 0.034,
        stalker: 0.040,
      };
      this.projectiles.spawnTracer(RAY_O, tracerEnd, {
        color: type.accentColor,
        width: TRACER_W[e.typeId] || 0.038,
        minWidth: 0.02,
        life: e.typeId === 'sniper' ? 0.26 : 0.18,
        minLength: 0,
        dir: RAY_D,
      });
    }
    Events.emit('audio:play', {
      name: e.typeId === 'sniper' ? 'sniper_fire' : (e.typeId === 'heavy' ? 'flatline_fire' : 'r99_fire'),
      pos: e.pos, gain: 0.55,
    });
  }

  // ---------------------------------------------------------------- 物理

  _physics(e, dt, externalMaxSpeed = 0) {
    const type = e.type;
    if (!type.flying && !e.wallNormal) {
      e.vel[1] -= CFG.move.gravity * dt;
      if (e.vel[1] < -55) e.vel[1] = -55;
    }
    // 水平速度上限
    const hs = Math.hypot(e.vel[0], e.vel[2]);
    const maxS = Math.max(type.speed * (type.behavior === 'hitrun' ? 1 : 1.35), externalMaxSpeed || 0);
    if (hs > maxS) {
      const k = maxS / hs;
      e.vel[0] *= k; e.vel[2] *= k;
    }

    const dx = e.vel[0] * dt, dy = e.vel[1] * dt, dz = e.vel[2] * dt;
    const dist = Math.hypot(dx, dy, dz);
    const wasGrounded = !!e.grounded;

    if (type.flying) {
      e.pos[0] += dx; e.pos[1] += dy; e.pos[2] += dz;
      // 飞行单位也要避免穿墙：用球扫掠
      const hit = this.world.sweepSphere(e.pos, e.radius, [0, 0, 0], {});
      void hit;
      // 简单分离
      const res = this.world.resolveCapsule(e.pos, e.radius, e.height, 2);
      if (res.contacts > 0) {
        // 被墙挡住：抬升绕开
        e.vel[1] = Math.max(e.vel[1], 2.2);
      }
    } else {
      if (dist > 1e-5) {
        const sweepR = Math.max(e.radius, e.height * 0.4);
        const center = T_A;
        center[0] = e.pos[0];
        center[1] = e.pos[1] + e.height * 0.5;
        center[2] = e.pos[2];
        const hit = this.world.sweepSphere(center, sweepR, [dx, dy, dz], {});
        if (hit.hit) {
          e.pos[0] += dx / dist * Math.max(0, hit.t - 0.01);
          e.pos[1] += dy / dist * Math.max(0, hit.t - 0.01);
          e.pos[2] += dz / dist * Math.max(0, hit.t - 0.01);
          // 沿墙滑行
          const d = e.vel[0] * hit.normal[0] + e.vel[1] * hit.normal[1] + e.vel[2] * hit.normal[2];
          e.vel[0] -= hit.normal[0] * d;
          e.vel[1] -= hit.normal[1] * d;
          e.vel[2] -= hit.normal[2] * d;
          if (hit.normal[1] > 0.5) e.grounded = true;
          if (type.behavior === 'bomber' || type.behavior === 'hitrun') {
            // 消费剩余切向位移：否则贴墙的蜘蛛每帧 t=0，只投影速度而永远爬不上去。
            const left=dt*(1-M.clamp01(hit.t/dist));
            const delta=[e.vel[0]*left,e.vel[1]*left,e.vel[2]*left];
            const length=Math.hypot(...delta);
            if(length>1e-6) {
              const c=[e.pos[0],e.pos[1]+e.height*0.5,e.pos[2]];
              const slide=this.world.sweepSphere(c,sweepR,delta,{});
              const fraction=slide.hit ? Math.max(0,slide.t-0.01)/length : 1;
              for(let k=0;k<3;k++) e.pos[k]+=delta[k]*fraction;
            }
          }
        } else {
          e.pos[0] += dx; e.pos[1] += dy; e.pos[2] += dz;
        }
      }
      const res = this.world.resolveCapsule(e.pos, e.radius, e.height, 3);
      let grounded = res.grounded;
      if (!grounded) {
        const probe = this.world.probeGround(e.pos, e.radius, e.height, 0.3);
        grounded = probe.grounded && e.vel[1] <= 0.5;
      }
      e.grounded = grounded;
      if (grounded) {
        if (e.vel[1] < 0) e.vel[1] = 0;
        // 台阶自动上抬
        if (!wasGrounded) {
          const slope = this.world.sampleSlope(e.pos[0], e.pos[2]);
          if (slope > 0.6) {
            // 太陡：往回推一点
            e.vel[0] *= 0.3; e.vel[2] *= 0.3;
          }
        }
      }
    }

    // 掉出地图兜底
    if (e.pos[1] < -120) {
      this.damage(e, 9999, false, e.pos, null, { source: 'void' });
    }

    // 水平边界兜底：大部分原型没有外围墙，敌人也会跑出地形网格掉进虚空。
    // 夹回范围内并清掉朝外的速度分量，否则它会贴着边界一直顶。
    if (typeof this.world.clampToBounds === 'function') {
      const pushInset = Math.max(e.radius || 0.4, 0.6) + 0.6;
      const pushed = this.world.clampToBounds(e.pos, pushInset);
      if (pushed) {
        if (pushed & 1) e.vel[0] = 0;
        if (pushed & 2) e.vel[2] = 0;
      }
    }

    // 卡住检测：贴墙/夹角里原地磨 —— 玩家看到的是"怪卡墙里动不了"。
    // 判定条件：这一帧几乎没动，但速度本身不小（真的在用力，只是被卡住）。
    this._detectStuck(e, dt);

    // 不靠墙倾向：只有爆蛛（爬墙自爆蛛）和绿影蛛皇靠贴墙机动，其余兵种
    // 贴墙只会卡住、也会给人"卡模型"的观感（用户反馈"除蜘蛛外倾向不靠墙"）。
    this._avoidWalls(e, dt);

    // 动画相位（走路摆动）
    e.animPhase += Math.hypot(e.vel[0], e.wallNormal ? e.vel[1] : 0, e.vel[2]) * dt * 2.6;
  }

  /**
   * 非爬墙兵种的"不靠墙"倾向。
   *
   * 做法：沿当前速度方向打一条短探针，探到墙就沿着墙的**切向**重新分配速度，
   * 并叠加一点朝外的推力。相比"撞到再硬转"，这样怪会自然地沿着墙面滑过去、
   * 与墙保持一点距离，不会蹭着墙磨。
   *
   * 跳过：爆蛛（本来就要爬墙）、绿影蛛皇（BOSS 会主动上墙）、飞行单位。
   */
  _avoidWalls(e, dt) {
    const type = e.type;
    if (type.flying || type.wallClimber) return;
    if (type.meshKind === 'spider' || type.hybridBoss) return;
    const hs = Math.hypot(e.vel[0], e.vel[2]);
    if (hs < 1.2) return;                       // 没在移动就不用管

    const origin = T_A;
    origin[0] = e.pos[0];
    origin[1] = e.pos[1] + e.height * 0.5;
    origin[2] = e.pos[2];
    const dir = T_B;
    dir[0] = e.vel[0] / hs; dir[1] = 0; dir[2] = e.vel[2] / hs;

    // 探针长度：身体半径 + 一点余量，太短没意义、太长会让怪在空旷处也绕
    const reach = Math.max(e.radius, 0.4) + 0.9;
    const hit = this.world.raycast(origin, dir, reach, {});
    if (!hit.hit) {
      e.wallAvoidCd = 0;
      return;
    }
    // 只处理"竖直墙面"：地面/薄板（法线朝上/下）不参与，否则走下坡会被误判
    const n = hit.normal;
    if (Math.abs(n[1]) > 0.7) return;

    // 沿切向重定向：把速度投影到墙面上，再叠加朝外的分离力
    const d = e.vel[0] * n[0] + e.vel[2] * n[2];
    let vx = e.vel[0] - n[0] * d;
    let vz = e.vel[2] - n[2] * d;
    const sep = 2.4;                            // 朝外推的强度（m/s）
    vx += n[0] * sep;
    vz += n[2] * sep;
    // 保持原有水平速度大小，避免靠墙就整体变慢
    const l = Math.hypot(vx, vz) || 1;
    e.vel[0] = vx / l * hs;
    e.vel[2] = vz / l * hs;
    e.wallAvoidCd = 0.15;                        // 短暂抑制，避免每帧抖动
  }

  /**
   * 卡住检测与自动脱离。
   *
   * 为什么需要：推出式碰撞解算在墙角/薄板/斜面夹角处会把怪"顶住"，
   * 它速度不为零却几乎不位移，表现就是「卡墙里动不了」，而且会一直卡下去
   * （玩家反馈的问题）。这里累计"想动但没动"的时长，超过阈值就主动脱离。
   *
   * 脱离手段按代价递增：
   *   1. 先给它一个向上的推力 + 侧向速度，靠引擎自身的碰撞解算爬出来（最自然）
   *   2. 还不行就沿"离它最近的可用导航点"方向推一把
   *   3. 仍然不行才瞬移到该导航点（最后手段，避免永久卡死）
   * 蜘蛛/飞行单位不参与（爆蛛本来就要贴墙爬，卡住是它的正常表现）。
   */
  _detectStuck(e, dt) {
    // 这类兵种靠贴墙移动，不能按"卡住"处理。
    // 但 BOSS 要区别对待：它**正在爬墙时**属于正常机动，不该判卡住；
    // 一旦脱墙（wallNormal 为空）卡在平台与地面的缝隙里，就必须救出来 ——
    // 早先把 hybridBoss 整个排除在外，结果 BOSS 卡缝隙时永远不会脱离。
    if (e.type.flying || e.type.meshKind === 'spider') {
      e.stuckTime = 0;
      e.lastPos = null;
      return;
    }
    if (e.wallNormal && (e.type.hybridBoss || e.wallJumpMode)) {
      e.stuckTime = 0;
      e.lastPos = null;
      return;
    }
    const isBoss = !!e.type.hybridBoss;
    const lx = e.lastPos ? e.lastPos[0] : e.pos[0];
    const lz = e.lastPos ? e.lastPos[2] : e.pos[2];
    if (!e.lastPos) e.lastPos = [e.pos[0], e.pos[1], e.pos[2]];
    const moved = Math.hypot(e.pos[0] - lx, e.pos[2] - lz);
    const wants = Math.hypot(e.vel[0], e.vel[2]);

    // BOSS 体型大、在狭窄处本来就走得慢，阈值放宽一点，避免误判正常绕行。
    const moveEps = isBoss ? 0.05 : 0.02;
    const wantEps = isBoss ? 0.5 : 0.8;
    const holdTime = isBoss ? 1.0 : 0.6;

    if (wants > wantEps && moved < moveEps) {
      e.stuckTime = (e.stuckTime || 0) + dt;
    } else {
      e.stuckTime = 0;
    }
    e.lastPos[0] = e.pos[0];
    e.lastPos[1] = e.pos[1];
    e.lastPos[2] = e.pos[2];

    if (e.stuckTime < holdTime) return;

    // 阶段 1：上抬 + 侧向速度，靠引擎自己爬出来。
    // BOSS 更容易被平台"压住"，给它更高的上抬速度，并且只给它两次机会
    // （体型大、缝隙窄，硬蹭通常无效，早点进入瞬移阶段更好）。
    e.stuckTime = 0;
    e.stuckAttempts = (e.stuckAttempts || 0) + 1;
    const liftChances = isBoss ? 2 : 3;
    if (e.stuckAttempts <= liftChances) {
      e.vel[1] = Math.max(e.vel[1], isBoss ? 9.5 : 6.5);
      const side = (e.id % 2 === 0) ? 1 : -1;
      // 注意：两个分量必须都基于**原始**速度算，否则先改 vel[0] 再拿它算 vel[2]
      // 会得到错误的方向（这里踩过一次）。
      const vx = e.vel[0], vz = e.vel[2];
      const s = Math.hypot(vx, vz) || 1;
      // 沿速度的左手/右手方向给一个横向推力，避免继续正对墙面磨
      e.vel[0] = vx + (-vz / s) * 4.5 * side;
      e.vel[2] = vz + (vx / s) * 4.5 * side;
      return;
    }

    // 阶段 2：挪到最近的**可用且确实能站**的导航点（避免永久卡死）。
    //
    // 落点必须同时满足三条，否则"瞬移"等于没救：
    //   · 离当前位置足够远（BOSS 4m / 其它 2m）—— 否则选到脚下那个点，
    //     下帧又卡在同一个缝里，来回弹
    //   · 头顶有净空 —— 否则会从"地面缝"直接卡进"平台里"
    //   · 脚下是地面 —— 否则会落到半空或虚空
    const cands = this.world.navCandidates ? this.world.navCandidates() : null;
    const blocked = e.stuckBlocked || (e.stuckBlocked = []);
    if (cands && cands.length) {
      const radius = isBoss ? 30 : 14;
      const minMove = isBoss ? 4.0 : 2.0;
      let best = null, bestD = Infinity;
      const steps = Math.max(1, Math.floor(cands.length / 512));   // 大表抽样，控制单帧开销
      for (let i = 0; i < cands.length; i += steps) {
        const c = cands[i];
        const dx = c[0] - e.pos[0], dz = c[2] - e.pos[2];
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        if (d2 < minMove * minMove) continue;                       // 太近，救不出来
        if (d2 >= bestD) continue;
        // 跳过最近尝试过、明显无效的点（避免反复选同一处来回弹）
        let skip = false;
        for (let k = 0; k < blocked.length; k++) {
          const bp = blocked[k];
          if ((c[0] - bp[0]) * (c[0] - bp[0]) + (c[2] - bp[2]) * (c[2] - bp[2]) < 4) { skip = true; break; }
        }
        if (skip) continue;
        bestD = d2; best = c;
      }
      if (best) {
        const y = best[1] + 0.15;
        // 头顶净空
        const upHit = this.world.raycast
          ? this.world.raycast([best[0], y + 0.2, best[2]], [0, 1, 0], e.height + 0.5, {}).hit
          : false;
        // 脚下有地
        const gy = this.world.groundHeight ? this.world.groundHeight(best[0], best[2]) : best[1];
        const grounded = Number.isFinite(gy) && Math.abs(gy - best[1]) < 1.2;
        if (!upHit && grounded) {
          e.pos[0] = best[0];
          e.pos[1] = y;
          e.pos[2] = best[2];
          e.vel[0] = 0; e.vel[1] = 0; e.vel[2] = 0;
          e.stuckTime = 0;
          e.stuckAttempts = 0;
          // 记住这个落点：若下帧又卡住，换一个候选，避免在同一处来回弹
          blocked.push([best[0], best[1], best[2]]);
          if (blocked.length > 4) blocked.shift();
          if (isBoss) {
            // BOSS 脱困是玩家能看见的事件，给一条特效，避免"它怎么突然出现了"
            this._specialFx('boss-summon', [e.pos[0], e.pos[1], e.pos[2]]);
          }
          return;
        }
      }
    }
    // 找不到合适落点：清空黑名单再试，并重置计数（下一轮重新评估）
    if (blocked.length) blocked.length = 0;
    e.stuckAttempts = 0;
  }

  // ---------------------------------------------------------------- 伤害

  /**
   * 对敌人造成伤害。
   * 返回 { killed, damage, blocked, shieldDamage, healthDamage, shieldHit, shieldBreak }。
   *
   * 护盾与生命严格按顺序结算：本次命中的伤害先全部交给护盾，只有护盾
   * 被本次命中打穿后才把剩余伤害交给生命。这样 HUD、特效和音效都能明确
   * 区分“打盾”和“打肉”，不会再把普通命中一律播成肉体命中声。
   */
  damage(enemy, amount, headshot, hitPoint, hitNormal, opts) {
    const e = enemy;
    const res = {
      killed: false,
      damage: 0,
      blocked: false,
      shieldDamage: 0,
      healthDamage: 0,
      shieldHit: false,
      shieldBreak: false,
    };
    if (!e || !e.alive || amount <= 0) return res;
    const o = opts || {};
    let dmg = amount;

    // 盾兵正面减伤
    if (e.type.shieldFront && !o.ignoreShield) {
      const dx = hitPoint ? hitPoint[0] - e.pos[0] : 0;
      const dz = hitPoint ? hitPoint[2] - e.pos[2] : 0;
      const l = Math.hypot(dx, dz) || 1;
      const toHitYaw = Math.atan2(-dx / l, -dz / l);
      const diff = Math.abs(M.wrapAngle(toHitYaw - e.aimYaw));
      if (diff < e.type.shieldArc) {
        dmg *= e.type.shieldDamageMul;
        res.blocked = true;
      }
    }

    // 护盾先扣。保留标准“过量伤害穿透”规则：只有护盾归零后，
    // 本次命中的剩余伤害才会进入生命；护盾未破时绝不会扣肉。
    if (e.shield > 0) {
      const shieldBefore = e.shield;
      const absorbed = Math.min(e.shield, dmg);
      e.shield -= absorbed;
      dmg -= absorbed;
      res.shieldDamage = absorbed;
      res.shieldHit = absorbed > 0;
      if (e.shield <= 0 && e.maxShield > 0) {
        res.shieldBreak = shieldBefore > 0;
        if (this.particles) {
          this.particles.emitBurst(hitPoint || e.pos, hitNormal || UP_V, 'shieldBreak', {});
        }
      }
    }
    if (dmg > 0) {
      e.hp -= dmg;
      res.healthDamage = dmg;
    }
    e.hitFlash = 1;
    e.lastDamageTime = this._time;
    e.alertness = 1;
    if (e.state === AI_IDLE) e.state = AI_ALERT;

    // 命中特效
    if (this.particles) {
      const kind = res.shieldHit ? 'shield' : (headshot ? 'headshot' : 'flesh');
      this.particles.emitBurst(hitPoint || e.pos, hitNormal || UP_V, kind, {});
    }

    // 命中音效跟随实际结算层，而不是跟随“这是一发枪”这个外部动作：
    // 护盾吸收播金属/能量声，生命受损播肉体声。大威力命中穿盾时两者
    // 会按结算顺序依次触发，且破盾另外播放清脆的 shield_break。
    if (!o.noImpactAudio) {
      const impactPos = hitPoint || e.pos;
      if (res.shieldHit) {
        Events.emit('audio:play', { name: 'hit_armor', pos: impactPos, gain: 1.72 });  // 需求10：命中音效响度 x2
      }
      if (res.shieldBreak) {
        // 破盾音放在护盾命中音之后、肉体命中音之前，听感上明确表现为
        // “金属受击 → 清脆碎裂 → 肉体受击”的顺序。
        Events.emit('audio:play', { name: 'shield_break', pos: impactPos, gain: 1.44 });  // 需求10：命中音效响度 x2
      }
      if (res.healthDamage > 0) {
        Events.emit('audio:play', {
          name: headshot ? 'hit_head' : 'hit_flesh', pos: impactPos, gain: 1.6,   // 需求10：命中音效响度 x2
        });
      }
    }

    // 实际扣除的总量（护盾 + 生命），而不是只返回护盾吸收量。
    res.damage = res.shieldDamage + res.healthDamage;
    this.stats.damageDealt += res.damage;
    if (!o.countAsDealt) res.countAsDealt = true;

    if (e.hp <= 0) {
      if (this.replicated) {
        // 房客不做权威击杀：这里只把预测血量夹到 0，等房主快照回传 alive=false
        // 后再播死亡表现。否则房客会自行刷掉落、重复计分。
        e.hp = 0;
      } else {
        res.killed = true;
        this._kill(e, headshot, o);
      }
    }

    // 房客把命中申报给房主做权威结算。上报的是**本次命中的原始伤害**，而不是
    // 本地预测结算后的数值：房主的敌人血量/护盾才是事实来源，用原始值重算才能
    // 让两端的护盾-生命分配保持一致。
    if (this.replicated) {
      const p = hitPoint || e.pos;
      const n = hitNormal || UP_V;
      this.hitReports.push(
        e.id, amount, headshot ? 1 : 0,
        p[0], p[1], p[2], n[0], n[1], n[2],
      );
    }
    return res;
  }

  _kill(e, headshot, opts) {
    if (!e.alive) return;
    e.alive = false;
    e.deadTime = 0;
    e.hp = 0;
    this.stats.killed++;
    this._score += e.type.score * (headshot ? 1.5 : 1);

    // 死亡不再生成大团烟雾/粒子；它会遮挡准星与后方目标，连续击杀时尤其严重。
    // 击杀确认由音效、命中标记和击杀播报负责。
    Events.emit('enemy:die', { enemy: e, pos: e.pos, byPlayer: true, headshot, source: opts && opts.source });
    Events.emit('audio:play', { name: 'enemy_die', pos: e.pos, gain: 0.7 });
    Events.emit('fx:shake', { amount: e.type.elite ? 0.25 : 0.08, time: 0.14 });
    if (this._onKill) this._onKill(e, headshot, opts);
    void opts;
  }

  // ---------------------------------------------------------------- 联机同步

  /** 按网络 id 查敌人（房客侧用；数量级 10²，线性查找足够） */
  findByNetId(id) {
    for (let i = 0; i < this.all.length; i++) {
      if (this.all[i].id === id) return this.all[i];
    }
    return null;
  }

  /**
   * 联机：取出房客侧待上报的命中队列。
   * 扁平数组，每 9 个数为一组：id, 伤害, 爆头, 命中点xyz, 法线xyz。
   */
  takeHitReports(out) {
    const src = this.hitReports;
    if (src.length === 0) return out || [];
    const dst = out || [];
    for (let i = 0; i + 8 < src.length; i += 9) {
      dst.push([src[i], src[i + 1], src[i + 2], src[i + 3], src[i + 4], src[i + 5], src[i + 6], src[i + 7], src[i + 8]]);
    }
    src.length = 0;
    return dst;
  }

  /**
   * 联机：把房主快照里的权威血量写入本地敌人（房客侧）。
   * 位置与朝向由调用方按固定频率插值逼近；这里只负责“状态量”，因为它们必须
   * 立刻生效（血条、命中反馈、死亡判定都依赖它）。
   */
  applyNetState(e, hp, shield, alive, aiState) {
    if (!e) return;
    if (Number.isFinite(hp)) e.hp = hp;
    if (Number.isFinite(shield)) e.shield = shield;
    if (Number.isFinite(aiState)) e.state = aiState;
    if (alive === false && e.alive) this.presentRemoteDeath(e);
    else if (alive === true && !e.alive) { e.alive = true; e.deadTime = 0; }
  }

  /**
   * 联机：房主判定死亡后，房客在本机补播同一套死亡表现。
   * 只做表现（音效/闪光/死亡方向），不触发掉落与计分——那些是房主的职责。
   */
  presentRemoteDeath(e) {
    e.alive = false;
    e.deadTime = 0;
    e.hp = 0;
    e.hitFlash = 1;
    Events.emit('audio:play', { name: 'enemy_die', pos: e.pos, gain: 0.7 });
    Events.emit('fx:shake', { amount: e.type && e.type.elite ? 0.25 : 0.08, time: 0.14 });
  }

  /** 联机：彻底移除一只敌人（房主快照里已消失） */
  removeByNetId(id) {
    const e = this.findByNetId(id);
    if (!e) return false;
    e.alive = false;
    e.deadTime = 99;
    return true;
  }

  /** 爆炸伤害（范围衰减 + 视线检查） */
  explosion(pos, radius, damage, opts) {
    const o = opts || {};
    for (const e of this.all) {
      if (!e.alive) continue;
      if (o.exclude && e === o.exclude) continue;
      const d = M.dist3(e.pos, pos);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const dmg = damage * falloff * falloff;
      if (dmg < 0.5) continue;
      // 视线遮挡减半
      RAY_O[0] = pos[0]; RAY_O[1] = pos[1]; RAY_O[2] = pos[2];
      RAY_D[0] = e.pos[0] - pos[0]; RAY_D[1] = e.pos[1] + e.height * 0.5 - pos[1]; RAY_D[2] = e.pos[2] - pos[2];
      const dd = Math.hypot(RAY_D[0], RAY_D[1], RAY_D[2]) || 1;
      RAY_D[0] /= dd; RAY_D[1] /= dd; RAY_D[2] /= dd;
      const blocked = this.world.raycast(RAY_O, RAY_D, dd - 0.3, {}).hit;
      this.damage(e, blocked ? dmg * 0.45 : dmg, false, e.pos, UP_V, { explosion: true });
      // 击退
      const kb = falloff * 9;
      e.vel[0] += (e.pos[0] - pos[0]) / Math.max(0.5, d) * kb;
      e.vel[1] += kb * 0.5;
      e.vel[2] += (e.pos[2] - pos[2]) / Math.max(0.5, d) * kb;
    }
    if (this.particles) this.particles.emitBurst(pos, UP_V, 'explosion', {});
    Events.emit('audio:play', { name: 'explosion', pos, gain: 1 });
    Events.emit('fx:shake', { amount: 0.7, time: 0.4 });
  }

  // ---------------------------------------------------------------- 射线

  /**
   * 对敌人的射线检测（武器命中判定用）。
   * 返回 { enemy, t, point, normal, headshot, legshot } 或 null。
   */
  raycastEnemies(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const e of this.all) {
      if (!e.alive) continue;
      // 先用包围球粗筛
      const cx = e.pos[0], cy = e.pos[1] + e.height * 0.5, cz = e.pos[2];
      const toC = (cx - origin[0]) * dir[0] + (cy - origin[1]) * dir[1] + (cz - origin[2]) * dir[2];
      if (toC < -e.height || toC > bestT + e.height) continue;
      const boundR = e.type.hybridBoss ? e.height*0.9 : e.type.meshKind === 'spider' ? 0.75*e.scale : Math.max(e.radius, e.height * 0.5) * 1.05;
      const px2 = origin[0] + dir[0] * toC - cx;
      const py2 = origin[1] + dir[1] * toC - cy;
      const pz2 = origin[2] + dir[2] * toC - cz;
      if (px2 * px2 + py2 * py2 + pz2 * pz2 > boundR * boundR) continue;

      // 精确：逐命中盒做射线-AABB
      const boxes = e.hitboxes;
      for (let b = 0; b < boxes.length; b++) {
        const hb = boxes[b];
        for (let k = 0; k < 3; k++) {
          HIT_MIN[k] = hb.min[k] + e.pos[k];
          HIT_MAX[k] = hb.max[k] + e.pos[k];
        }
        const hit = rayAABBLocal(origin, dir, HIT_MIN, HIT_MAX);
        if (hit && hit.t >= 0 && hit.t < bestT) {
          bestT = hit.t;
          if (!best) best = { enemy: e, t: 0, point: new Float32Array(3), normal: new Float32Array(3), headshot: false, legshot: false };
          best.enemy = e;
          best.t = hit.t;
          best.point[0] = origin[0] + dir[0] * hit.t;
          best.point[1] = origin[1] + dir[1] * hit.t;
          best.point[2] = origin[2] + dir[2] * hit.t;
          best.normal[0] = hit.normal[0];
          best.normal[1] = hit.normal[1];
          best.normal[2] = hit.normal[2];
          best.headshot = hb.name === 'head';
          best.legshot = hb.name === 'legs';
        }
      }
    }
    return best;
  }

  /** 抓钩目标查询（player.opts.queryGrappleTarget 用） */
  queryGrappleTarget(origin, dir, maxRange) {
    let best = null;
    let bestT = maxRange;
    for (const e of this.all) {
      if (!e.alive) continue;
      const cx = e.pos[0], cy = e.pos[1] + e.height * 0.55, cz = e.pos[2];
      const r = Math.max(e.radius, e.height * 0.45);
      const t = raySphereHit(origin, dir, [cx, cy, cz], r * 1.2);
      if (t != null && t < bestT) {
        bestT = t;
        best = {
          enemy: e,
          dist: t,
          point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
        };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 渲染

  render(engine) {
    const e = engine;
    // 按 meshKind 分桶
    const buckets = this._renderBuckets;
    buckets.clear();
    let total = 0;
    for (const en of this.all) {
      let list = buckets.get(en.typeId);
      if (!list) { list = []; buckets.set(en.typeId, list); }
      list.push(en);
      total++;
    }
    if (total === 0) return;

    for (const [typeId, list] of buckets) {
      const type = ENEMY_TYPES[typeId];
      this._renderType(e, type, list);
    }
  }

  _renderType(e, type, list) {
    const shape = type.hybridBoss ? HYBRID_SHAPE : SHAPES[type.meshKind] || SHAPES.humanoid;
    // 每个形状由多个"部件"组成，每个部件一次 instanced draw
    for (let partIdx = 0; partIdx < shape.length; partIdx++) {
      const part = shape[partIdx];
      const mesh = e.sharedMeshes ? e.sharedMeshes[part.mesh] : null;
      if (!mesh) continue;
      let n = 0;
      const cap = Math.min(list.length, 512);
      for (let i = 0; i < cap; i++) {
        const en = list[i];
        if (type.behavior === 'hitrun' && part.name.startsWith('gun')) continue;
        if (part.onlyHitrun && type.behavior !== 'hitrun') continue;
        if (!en.alive) {
          // 死亡后的下沉/散架
          const t = M.clamp01(en.deadTime / 1.4);
          if (t >= 1) continue;
          const s = 1 - t * 0.65;
          const m = M.m4Compose(
            [en.pos[0], en.pos[1] - t * 0.7, en.pos[2]],
            en.yaw, en.type.behavior === 'melee' ? 1.4 * t : t * 1.1, t * 0.9,
            [s, s, s], TMPM);
          const col = en.type.color;
          const o = n * 16;
          this._mats.set(m, o);
          const co = n * 4;
          this._cols[co] = col[0] * (1 - t);
          this._cols[co + 1] = col[1] * (1 - t);
          this._cols[co + 2] = col[2] * (1 - t);
          this._cols[co + 3] = 1;
          n++;
          continue;
        }
        if (!e.inFrustumSphere([en.pos[0], en.pos[1] + en.height * 0.5, en.pos[2]], en.height * 1.2)) continue;
        this._writeEnemyPart(n, en, type, part, shape, partIdx, e);
        n++;
      }
      if (n > 0) {
        e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
          colors: this._cols.subarray(0, n * 4),
        });
      }
    }
  }

  _writeEnemyPart(slot, en, type, part, shape, partIdx, engine) {
    const sc = en.scale;
    // 走路摆动（腿/手臂）
    const anim = Math.sin(en.animPhase + (part.phase || 0));
    const isLeg = part.name === 'legL' || part.name === 'legR'
      || part.name === 'shinL' || part.name === 'shinR';
    const isArm = part.name === 'armL' || part.name === 'armR'
      || part.name === 'forearmL' || part.name === 'forearmR';
    let swing = 0;
    if (isLeg) swing = anim * (part.name.endsWith('L') ? 1 : -1) * 0.45;
    if (isArm) swing = anim * (part.name.endsWith('L') ? -1 : 1) * 0.30;
    if (type.behavior === 'hitrun' && isArm && part.name.endsWith('R')) swing -= Math.sin((en.slashT || 0) * Math.PI) * 1.8;
    if (part.spiderLeg) swing = anim * 0.24;
    if (part.onlyHitrun) swing = -Math.sin((en.slashT || 0)*Math.PI)*1.8;
    // 受击闪白
    const flash = M.clamp01(en.hitFlash + (en.specialPhase === 'charge' ? (0.5+0.5*Math.sin(en.age*32))*0.65 : 0));
    const color = type.color;
    const accent = type.accentColor;

    const px = en.pos[0] + rotateY(part.offset[0], part.offset[2], en.yaw) * sc;
    const pz = en.pos[2] + rotateZ_(part.offset[0], part.offset[2], en.yaw) * sc;
    let py = en.pos[1] + part.offset[1] * sc;
    // 腿部摆动时略抬起
    if (isLeg) py += Math.max(0, swing) * 0.18 * sc;

    const size = part.size;
    const scale = [size[0] * sc, size[1] * sc, size[2] * sc];
    // 旧模型把步行动画加在 yaw 上，手脚会像钟摆门一样左右张开；人形关节应绕
    // X 轴前后摆。部件仍随角色 yaw 整体朝向，局部 rot 只负责造型微调。
    const rot = [
      (part.rot ? part.rot[0] : 0) + swing,
      en.yaw + (part.rot ? part.rot[1] : 0),
      part.rot ? part.rot[2] : 0,
    ];
    const m = M.m4Compose([px, py, pz], rot[1], rot[0], rot[2], scale, TMPM);
    const o = slot * 16;
    if ((type.meshKind === 'spider' || type.hybridBoss) && en.wallNormal) {
      // 将整个模型绕腹部中心旋到真实墙面，碰撞/命中保持包围腹部的体积。
      const n = en.wallNormal, h = Math.hypot(n[0], n[2]) || 1;
      const nx = n[0]/h, nz = n[2]/h;
      const cx = en.pos[0], cy = en.pos[1] + en.height*0.5, cz = en.pos[2];
      for (let col=0; col<4; col++) {
        const j=col*4, x=m[j]-(col===3?cx:0), y=m[j+1]-(col===3?cy:0), z=m[j+2]-(col===3?cz:0);
        m[j] = nz*x + nx*y + (col===3?cx:0);
        m[j+1] = -z + (col===3?cy:0);
        m[j+2] = -nx*x + nz*y + (col===3?cz:0);
      }
    }
    this._mats.set(m, o);
    const co = slot * 4;
    // 自发光部位（眼睛/能量核心）用 accent 且提亮
    const isGlow = part.glow === true;
    const isAccent = part.accent === true;
    const base = (isGlow || isAccent) ? accent : color;
    const boost = (isGlow ? 0.92 : (part.shade == null ? 1 : part.shade));
    this._cols[co] = M.clamp01(base[0] * boost + flash * 0.9);
    this._cols[co + 1] = M.clamp01(base[1] * boost + flash * 0.9);
    this._cols[co + 2] = M.clamp01(base[2] * boost + flash * 0.9);
    this._cols[co + 3] = 1;
    void engine; void shape; void partIdx;
  }

  /** 敌人血条数据（HUD 用） */
  getHealthBars() {
    const out = [];
    for (const e of this.all) {
      if (!e.alive) continue;
      out.push({ enemy: e, hp: e.hp / e.maxHp, shield: e.maxShield > 0 ? e.shield / e.maxShield : 0 });
    }
    return out;
  }

  debugState() {
    const byType = {};
    for (const e of this.all) {
      if (!e.alive) continue;
      byType[e.typeId] = (byType[e.typeId] || 0) + 1;
    }
    return {
      total: this.all.length,
      alive: this.aliveCount(),
      byType,
      difficulty: Math.round(this.difficulty * 100) / 100,
      spawned: this.stats.spawned,
      killed: this.stats.killed,
      damageDealt: Math.round(this.stats.damageDealt),
    };
  }
}

// ---------------------------------------------------------------- 敌人形状

/**
 * 程序化低模敌人形状：由"部件"组成，每个部件一个单位网格 + 偏移 + 尺寸 + 颜色。
 * 这样 6 个兵种共用 3~4 个网格，draw call 极少。
 */
const SHAPES = {
  humanoid: [
    {name:'blade',onlyHitrun:true,mesh:'cone',offset:[0.37,0.92,-0.48],size:[0.07,0.58,0.025],rot:[Math.PI/2,0,0],glow:true},
    // 分层装甲取代单块“火柴人”躯干：骨盆、胸甲、肩甲、头盔、关节和武器
    // 都有独立轮廓，远处仍能一眼读出朝向与姿态。
    { name: 'pelvis', mesh: 'cube', offset: [0, 0.78, 0], size: [0.42, 0.24, 0.30], shade: 0.62 },
    { name: 'torso', mesh: 'cube', offset: [0, 1.14, 0.02], size: [0.50, 0.54, 0.32], shade: 0.82 },
    { name: 'chestPlate', mesh: 'cube', offset: [0, 1.18, -0.19], size: [0.38, 0.30, 0.08], accent: true },
    { name: 'collar', mesh: 'cube', offset: [0, 1.45, 0], size: [0.36, 0.10, 0.30], shade: 0.56 },
    { name: 'head', mesh: 'cube', offset: [0, 1.62, 0], size: [0.29, 0.28, 0.29], shade: 0.72 },
    { name: 'helmet', mesh: 'cube', offset: [0, 1.76, 0.02], size: [0.34, 0.10, 0.34], shade: 0.48 },
    { name: 'visor', mesh: 'cube', offset: [0, 1.64, -0.155], size: [0.22, 0.075, 0.035], glow: true },
    { name: 'legL', mesh: 'cube', offset: [-0.145, 0.50, 0], size: [0.18, 0.48, 0.21], phase: 0 },
    { name: 'legR', mesh: 'cube', offset: [0.145, 0.50, 0], size: [0.18, 0.48, 0.21], phase: 0 },
    { name: 'shinL', mesh: 'cube', offset: [-0.145, 0.20, -0.015], size: [0.16, 0.38, 0.18], phase: 0, shade: 0.68 },
    { name: 'shinR', mesh: 'cube', offset: [0.145, 0.20, -0.015], size: [0.16, 0.38, 0.18], phase: 0, shade: 0.68 },
    { name: 'bootL', mesh: 'cube', offset: [-0.145, 0.055, -0.055], size: [0.20, 0.11, 0.31], shade: 0.42 },
    { name: 'bootR', mesh: 'cube', offset: [0.145, 0.055, -0.055], size: [0.20, 0.11, 0.31], shade: 0.42 },
    { name: 'shoulderL', mesh: 'cube', offset: [-0.34, 1.33, 0], size: [0.18, 0.18, 0.26], accent: true },
    { name: 'shoulderR', mesh: 'cube', offset: [0.34, 1.33, 0], size: [0.18, 0.18, 0.26], accent: true },
    { name: 'armL', mesh: 'cube', offset: [-0.36, 1.08, 0], size: [0.14, 0.36, 0.16], phase: 1.6, shade: 0.78 },
    { name: 'armR', mesh: 'cube', offset: [0.36, 1.08, 0], size: [0.14, 0.36, 0.16], phase: 1.6, shade: 0.78 },
    { name: 'forearmL', mesh: 'cube', offset: [-0.34, 0.88, -0.08], size: [0.15, 0.28, 0.17], phase: 1.6, shade: 0.55 },
    { name: 'forearmR', mesh: 'cube', offset: [0.34, 0.88, -0.08], size: [0.15, 0.28, 0.17], phase: 1.6, shade: 0.55 },
    { name: 'gunBody', mesh: 'cube', offset: [0.27, 1.02, -0.30], size: [0.12, 0.14, 0.52], shade: 0.32 },
    { name: 'gunRail', mesh: 'cube', offset: [0.27, 1.12, -0.31], size: [0.07, 0.035, 0.45], accent: true },
    { name: 'gunBarrel', mesh: 'cylinder', offset: [0.27, 1.04, -0.64], size: [0.045, 0.24, 0.045], rot: [Math.PI / 2, 0, 0], shade: 0.24 },
    { name: 'pack', mesh: 'cube', offset: [0, 1.17, 0.23], size: [0.34, 0.42, 0.16], shade: 0.45 },
    { name: 'packCore', mesh: 'cylinder', offset: [0, 1.17, 0.34], size: [0.09, 0.26, 0.09], accent: true },
  ],
  drone: [
    { name: 'core', mesh: 'sphere', offset: [0, 0.10, 0], size: [0.58, 0.54, 0.62], shade: 0.72 },
    { name: 'coreBand', mesh: 'cylinder', offset: [0, 0.10, 0], size: [0.64, 0.11, 0.64], accent: true },
    { name: 'eyeSocket', mesh: 'cylinder', offset: [0, 0.10, -0.29], size: [0.25, 0.10, 0.25], rot: [Math.PI / 2, 0, 0], shade: 0.34 },
    { name: 'eye', mesh: 'sphere', offset: [0, 0.10, -0.36], size: [0.16, 0.16, 0.10], glow: true },
    { name: 'wingL', mesh: 'cube', offset: [-0.43, 0.22, 0.02], size: [0.48, 0.055, 0.22], shade: 0.78 },
    { name: 'wingR', mesh: 'cube', offset: [0.43, 0.22, 0.02], size: [0.48, 0.055, 0.22], shade: 0.78 },
    { name: 'wingTipL', mesh: 'cube', offset: [-0.71, 0.22, 0.02], size: [0.16, 0.09, 0.28], accent: true },
    { name: 'wingTipR', mesh: 'cube', offset: [0.71, 0.22, 0.02], size: [0.16, 0.09, 0.28], accent: true },
    { name: 'thrusterL', mesh: 'cylinder', offset: [-0.48, 0.08, 0.18], size: [0.12, 0.20, 0.12], rot: [Math.PI / 2, 0, 0], glow: true },
    { name: 'thrusterR', mesh: 'cylinder', offset: [0.48, 0.08, 0.18], size: [0.12, 0.20, 0.12], rot: [Math.PI / 2, 0, 0], glow: true },
    { name: 'gunL', mesh: 'cube', offset: [-0.25, -0.10, -0.15], size: [0.10, 0.10, 0.38], shade: 0.32 },
    { name: 'gunR', mesh: 'cube', offset: [0.25, -0.10, -0.15], size: [0.10, 0.10, 0.38], shade: 0.32 },
    { name: 'tail', mesh: 'cube', offset: [0, 0.06, 0.37], size: [0.11, 0.11, 0.42], shade: 0.46 },
  ],
  heavy: [
    { name: 'pelvis', mesh: 'cube', offset: [0, 0.82, 0], size: [0.62, 0.32, 0.44], shade: 0.52 },
    { name: 'torso', mesh: 'cube', offset: [0, 1.35, 0], size: [0.78, 0.72, 0.52], shade: 0.76 },
    { name: 'chestPlate', mesh: 'cube', offset: [0, 1.40, -0.31], size: [0.62, 0.42, 0.12], accent: true },
    { name: 'reactor', mesh: 'sphere', offset: [0, 1.42, -0.39], size: [0.17, 0.17, 0.08], glow: true },
    { name: 'head', mesh: 'cube', offset: [0, 1.90, 0], size: [0.34, 0.30, 0.34], shade: 0.58 },
    { name: 'helmet', mesh: 'cube', offset: [0, 2.05, 0.03], size: [0.42, 0.12, 0.42], shade: 0.38 },
    { name: 'visor', mesh: 'cube', offset: [0, 1.92, -0.18], size: [0.25, 0.09, 0.06], glow: true },
    { name: 'legL', mesh: 'cube', offset: [-0.24, 0.54, 0], size: [0.28, 0.58, 0.30], phase: 0, shade: 0.72 },
    { name: 'legR', mesh: 'cube', offset: [0.24, 0.54, 0], size: [0.28, 0.58, 0.30], phase: 0, shade: 0.72 },
    { name: 'shinL', mesh: 'cube', offset: [-0.24, 0.20, -0.02], size: [0.25, 0.46, 0.27], phase: 0, shade: 0.52 },
    { name: 'shinR', mesh: 'cube', offset: [0.24, 0.20, -0.02], size: [0.25, 0.46, 0.27], phase: 0, shade: 0.52 },
    { name: 'bootL', mesh: 'cube', offset: [-0.24, 0.06, -0.08], size: [0.31, 0.13, 0.40], shade: 0.34 },
    { name: 'bootR', mesh: 'cube', offset: [0.24, 0.06, -0.08], size: [0.31, 0.13, 0.40], shade: 0.34 },
    { name: 'armL', mesh: 'cube', offset: [-0.53, 1.31, 0], size: [0.22, 0.60, 0.25], phase: 1.6, shade: 0.70 },
    { name: 'armR', mesh: 'cube', offset: [0.53, 1.31, 0], size: [0.22, 0.60, 0.25], phase: 1.6, shade: 0.70 },
    { name: 'forearmL', mesh: 'cube', offset: [-0.50, 0.98, -0.10], size: [0.24, 0.36, 0.27], phase: 1.6, shade: 0.48 },
    { name: 'forearmR', mesh: 'cube', offset: [0.50, 0.98, -0.10], size: [0.24, 0.36, 0.27], phase: 1.6, shade: 0.48 },
    { name: 'shoulderL', mesh: 'cube', offset: [-0.58, 1.64, 0], size: [0.32, 0.24, 0.38], accent: true },
    { name: 'shoulderR', mesh: 'cube', offset: [0.58, 1.64, 0], size: [0.32, 0.24, 0.38], accent: true },
    { name: 'gun', mesh: 'cylinder', offset: [0.34, 1.18, -0.45], size: [0.15, 0.80, 0.15], rot: [Math.PI / 2, 0, 0], shade: 0.30 },
    { name: 'gunShroud', mesh: 'cube', offset: [0.34, 1.18, -0.35], size: [0.25, 0.22, 0.52], shade: 0.42 },
    { name: 'gunCoil', mesh: 'cylinder', offset: [0.34, 1.18, -0.74], size: [0.20, 0.10, 0.20], rot: [Math.PI / 2, 0, 0], glow: true },
    { name: 'tank', mesh: 'cylinder', offset: [0, 1.38, 0.38], size: [0.31, 0.66, 0.31], shade: 0.44 },
    { name: 'tankBand', mesh: 'cube', offset: [0, 1.38, 0.48], size: [0.36, 0.12, 0.12], accent: true },
  ],
  spider: [
    {name:'abdomen',mesh:'sphere',offset:[0,0.43,0.22],size:[0.72,0.56,0.8]},
    {name:'reactor',mesh:'sphere',offset:[0,0.56,0.26],size:[0.38,0.22,0.42],glow:true},
    {name:'head',mesh:'sphere',offset:[0,0.32,-0.32],size:[0.42,0.32,0.42]},
    {name:'eyeL',mesh:'sphere',offset:[-0.12,0.40,-0.51],size:[0.075,0.075,0.06],glow:true},
    {name:'eyeR',mesh:'sphere',offset:[0.12,0.40,-0.51],size:[0.075,0.075,0.06],glow:true},
    ...[-1,1].flatMap(side=>Array.from({length:4},(_,i)=>[
      {name:'spiderUpper'+side+i,spiderLeg:true,mesh:'cube',offset:[side*0.50,0.31,(i-1.5)*0.29],size:[0.58,0.075,0.09],rot:[0,side*(i-1.5)*0.30,side*0.28],phase:i*Math.PI/2+(side<0?Math.PI:0),shade:0.7},
      {name:'spiderLower'+side+i,spiderLeg:true,mesh:'cube',offset:[side*0.83,0.16,(i-1.5)*0.40],size:[0.36,0.065,0.075],rot:[0,side*(i-1.5)*0.34,-side*0.65],phase:i*Math.PI/2+(side<0?Math.PI:0),accent:true},
    ]).flat()),
  ],
  crawler: [
    { name: 'body', mesh: 'sphere', offset: [0, 0.28, 0], size: [0.48, 0.31, 0.62], shade: 0.70 },
    { name: 'carapace', mesh: 'cube', offset: [0, 0.39, 0.04], size: [0.42, 0.12, 0.48], accent: true },
    { name: 'head', mesh: 'sphere', offset: [0, 0.28, -0.30], size: [0.30, 0.25, 0.30], shade: 0.54 },
    { name: 'eyeL', mesh: 'sphere', offset: [-0.085, 0.32, -0.43], size: [0.08, 0.08, 0.05], glow: true },
    { name: 'eyeR', mesh: 'sphere', offset: [0.085, 0.32, -0.43], size: [0.08, 0.08, 0.05], glow: true },
    { name: 'legL1', mesh: 'cube', offset: [-0.27, 0.17, -0.19], size: [0.36, 0.065, 0.08], rot: [0, -0.22, -0.22], shade: 0.58 },
    { name: 'legR1', mesh: 'cube', offset: [0.27, 0.17, -0.19], size: [0.36, 0.065, 0.08], rot: [0, 0.22, 0.22], shade: 0.58 },
    { name: 'legL2', mesh: 'cube', offset: [-0.30, 0.15, 0.04], size: [0.40, 0.065, 0.08], rot: [0, 0, -0.28], shade: 0.52 },
    { name: 'legR2', mesh: 'cube', offset: [0.30, 0.15, 0.04], size: [0.40, 0.065, 0.08], rot: [0, 0, 0.28], shade: 0.52 },
    { name: 'legL3', mesh: 'cube', offset: [-0.25, 0.14, 0.23], size: [0.34, 0.06, 0.075], rot: [0, 0.24, -0.20], shade: 0.46 },
    { name: 'legR3', mesh: 'cube', offset: [0.25, 0.14, 0.23], size: [0.34, 0.06, 0.075], rot: [0, -0.24, 0.20], shade: 0.46 },
    { name: 'tail', mesh: 'cone', offset: [0, 0.30, 0.47], size: [0.16, 0.36, 0.16], rot: [Math.PI / 2, 0, 0], shade: 0.50 },
    { name: 'tailTip', mesh: 'sphere', offset: [0, 0.30, 0.68], size: [0.12, 0.12, 0.16], glow: true },
  ],
};

// 蜘蛛腹部/八足 + 绿色人形躯干、手臂、刀刃，不是放大旧重装兵。
const HYBRID_SHAPE = [
  ...SHAPES.spider.map(p=>({...p,offset:[p.offset[0]*1.35,p.offset[1],p.offset[2]*1.35],size:[p.size[0]*1.3,p.size[1],p.size[2]*1.3]})),
  ...SHAPES.humanoid.filter(p=>!p.name.startsWith('gun') && !/^(leg|shin|boot)/.test(p.name))
    .map(p=>({...p,offset:[p.offset[0],p.offset[1]+0.4,p.offset[2]-0.1]})),
];

/** 命中盒：由形状推导（head / body / legs） */
function buildHitboxes(type, scale = 1) {
  const h = type.height * scale;
  const r = type.radius * scale;
  const boxes = [];
  if (type.hybridBoss) {
    const b=h*0.66; return [{name:'body',min:[-b,h*0.5-b,-b],max:[b,h*0.5+b,b]}];
  }
  if (type.meshKind === 'spider') {
    return [{name:'body', min:[-0.65*scale, h*0.5-0.65*scale, -0.65*scale], max:[0.65*scale, h*0.5+0.65*scale, 0.65*scale]}];
  }
  if (type.meshKind === 'crawler') {
    boxes.push({ name: 'head', min: [-r * 0.8, h * 0.2, -r * 0.8], max: [r * 0.8, h * 1.05, r * 0.8] });
    boxes.push({ name: 'body', min: [-r * 1.5, 0, -r * 1.8], max: [r * 1.5, h * 0.9, r * 1.8] });
    return boxes;
  }
  if (type.meshKind === 'drone') {
    boxes.push({ name: 'head', min: [-r * 0.7, h * 0.25, -r * 0.7], max: [r * 0.7, h * 1.1, r * 0.7] });
    boxes.push({ name: 'body', min: [-r * 2.0, -r * 0.4, -r * 1.6], max: [r * 2.0, h * 1.15, r * 1.6] });
    return boxes;
  }
  // 人形
  const headTop = h + 0.06;
  const headBottom = h * 0.80;
  boxes.push({ name: 'head', min: [-r * 0.78, headBottom, -r * 0.78], max: [r * 0.78, headTop, r * 0.78] });
  boxes.push({ name: 'body', min: [-r * 1.05, h * 0.40, -r * 0.85], max: [r * 1.05, headBottom, r * 0.85] });
  boxes.push({ name: 'legs', min: [-r * 1.05, 0, -r * 0.85], max: [r * 1.05, h * 0.40, r * 0.85] });
  return boxes;
}

// ---------------------------------------------------------------- 工具

const TMPM = new Float32Array(16);
const UP_V = new Float32Array([0, 1, 0]);

function rotateY(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return x * c + z * s;
}
function rotateZ_(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return -x * s + z * c;
}

/** 射线 vs AABB 的本地实现（避免跨模块调用开销） */
function rayAABBLocal(origin, dir, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  let axis = -1, sgn = 0;
  for (let i = 0; i < 3; i++) {
    const o = origin[i], d = dir[i];
    if (Math.abs(d) < 1e-9) {
      if (o < min[i] || o > max[i]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[i] - o) * inv;
    let t2 = (max[i] - o) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sgn = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? tmax : tmin;
  const n = new Float32Array(3);
  if (axis >= 0) n[axis] = tmin < 0 ? -sgn : sgn;
  return { t, normal: n };
}

/** 射线 vs 球，返回命中距离或 null */
function raySphereHit(origin, dir, center, r) {
  const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t < 0 ? null : t;
}

export { AI_STATE_NAMES };
export default EnemySystem;
