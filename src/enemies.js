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
    hp: 100, shield: 75, speed: 4.2, accel: 22,
    radius: 0.4, height: 1.75,
    color: [0.82, 0.20, 0.08], accentColor: [1.0, 0.62, 0.18],
    score: 100, alloy: 3,
    weapon: { damage: 7, rpm: 260, range: 60, accuracy: 0.72, burst: 4, burstPause: 1.0, projectileSpeed: 0, spreadDeg: 3.4, telegraph: 0.28 },
    behavior: 'infantry',
    xp: 1, threat: 1,
    meshKind: 'humanoid',
    attackRange: 34, preferredRange: 14, strafe: true,
  },
  shieldman: {
    id: 'shieldman', name: '盾卫', nameCN: '重盾突击兵',
    hp: 100, shield: 75, speed: 3.4, accel: 18,
    radius: 0.46, height: 1.8,
    color: [0.16, 0.48, 0.78], accentColor: [0.35, 0.92, 1.0],
    score: 150, alloy: 5,
    weapon: { damage: 9, rpm: 200, range: 30, accuracy: 0.6, burst: 3, burstPause: 1.4, projectileSpeed: 0, spreadDeg: 4.6, telegraph: 0.36 },
    behavior: 'charger',
    shieldFront: true, shieldArc: 0.55, shieldDamageMul: 0.22,
    xp: 2, threat: 1.6,
    meshKind: 'humanoid',
    attackRange: 24, preferredRange: 3.4, strafe: false,
  },
  flyer: {
    id: 'flyer', name: '飞行器', nameCN: '游猎无人机',
    hp: 100, shield: 75, speed: 7.4, accel: 30,
    radius: 0.42, height: 0.9,
    color: [0.48, 0.16, 0.76], accentColor: [0.92, 0.48, 1.0],
    score: 120, alloy: 4,
    weapon: { damage: 6, rpm: 320, range: 46, accuracy: 0.66, burst: 5, burstPause: 1.1, projectileSpeed: 42, spreadDeg: 3.0, telegraph: 0.3 },
    behavior: 'flyer',
    flying: true, hoverHeight: 5.2, bobAmp: 0.55, bobFreq: 1.7,
    xp: 2, threat: 1.4,
    meshKind: 'drone',
    attackRange: 42, preferredRange: 12, strafe: true,
  },
  heavy: {
    id: 'heavy', name: '重装兵', nameCN: '重装压制者',
    hp: 100, shield: 75, speed: 2.6, accel: 12,
    radius: 0.58, height: 2.15,
    color: [0.72, 0.28, 0.06], accentColor: [1.0, 0.78, 0.20],
    score: 320, alloy: 12,
    weapon: { damage: 13, rpm: 380, range: 52, accuracy: 0.7, burst: 8, burstPause: 1.7, projectileSpeed: 0, spreadDeg: 4.0, telegraph: 0.5 },
    behavior: 'infantry',
    xp: 5, threat: 3.2,
    meshKind: 'heavy',
    attackRange: 46, preferredRange: 16, strafe: true,
    elite: true,
  },
  sniper: {
    id: 'sniper', name: '狙击手', nameCN: '定点清除者',
    hp: 100, shield: 75, speed: 3.0, accel: 16,
    radius: 0.4, height: 1.78,
    color: [0.08, 0.58, 0.38], accentColor: [0.42, 1.0, 0.68],
    score: 200, alloy: 7,
    weapon: { damage: 34, rpm: 42, range: 160, accuracy: 0.94, burst: 1, burstPause: 2.4, projectileSpeed: 0, spreadDeg: 0.7, telegraph: 1.15, laser: true },
    behavior: 'sniper',
    xp: 3, threat: 2.4,
    meshKind: 'humanoid',
    attackRange: 140, preferredRange: 55, strafe: false, keepDistance: true,
  },
  swarm: {
    id: 'swarm', name: '虫群', nameCN: '拆解虫群',
    hp: 100, shield: 75, speed: 8.0, accel: 38,
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
    const d = this.difficulty;
    // 玩家与所有敌人使用同一套 100/100 生存基线。兵种强弱由武器、机动、体型和
    // 行为体现，不再暗中乘难度 HP，避免重装/虫群出现数倍于玩家的隐性血池。
    const maxHp = Math.round(CFG.gameplay.maxHealth);
    const maxShield = Math.round(CFG.gameplay.maxShield);

    const e = this._free.pop() || {};
    e.id = _nextId++;
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
    for (let i = 0; i < this.all.length; i++) {
      const e = this.all[i];
      if (!e.alive) {
        e.deadTime += dt;
        continue;
      }
      e.age += dt;
      if (e.hitFlash > 0) e.hitFlash -= dt * 4;
      if (e.gunRecoil > 0) e.gunRecoil -= dt * 6;
      this._updateStatus(e, dt);
      this._updateAI(e, dt, p);
      const grappleMaxSpeed = this._applyGrapplePull(e, dt, p);
      this._physics(e, dt, grappleMaxSpeed);
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
      if (e.telegraph <= 0) {
        e.telegraphing = false;
        this._shoot(e, player, dist);
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
    M.sub3(target, muzzle, dir);
    const d = M.len3(dir) || 1;
    M.scale3(dir, 1 / d, dir);
    M.randomConeDir(dir, spreadRad, this.rng, dir);

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

    // 即时射线
    RAY_O[0] = muzzle[0]; RAY_O[1] = muzzle[1]; RAY_O[2] = muzzle[2];
    RAY_D[0] = dir[0]; RAY_D[1] = dir[1]; RAY_D[2] = dir[2];
    const maxDist = w.range;
    const worldHit = this.world.raycast(RAY_O, RAY_D, maxDist, {});
    const worldT = worldHit.hit ? worldHit.t : maxDist;
    // 玩家受击体积：胶囊近似为球
    const pc = T_A;
    pc[0] = player.pos[0];
    pc[1] = player.pos[1] + player.currentHeight * 0.5;
    pc[2] = player.pos[2];
    const pr = Math.max(player.radius, player.currentHeight * 0.32);
    const ph = raySphereHit(RAY_O, RAY_D, pc, pr);
    let tracerEnd = null;
    if (ph != null && ph < worldT) {
      // 命中玩家
      const dmg = w.damage * e.damageMul * (1 + (this.difficulty - 1) * 0.2);
      const dd = T_D;
      dd[0] = dir[0]; dd[1] = dir[1]; dd[2] = dir[2];
      player.applyDamage(dmg, dd, e);
      Events.emit('hit:player', {
        damage: dmg,
        point: new Float32Array([RAY_O[0] + RAY_D[0] * ph, RAY_O[1] + RAY_D[1] * ph, RAY_O[2] + RAY_D[2] * ph]),
        source: e,
      });
      // 弹道在相机前 3.5m 截断，既能明确提示来向，又不会贴近近裁剪面
      // 膨胀成遮住半个画面的粗光柱。
      const visibleT = Math.max(0.6, ph - 3.5);
      T_C[0] = RAY_O[0] + RAY_D[0] * visibleT;
      T_C[1] = RAY_O[1] + RAY_D[1] * visibleT;
      T_C[2] = RAY_O[2] + RAY_D[2] * visibleT;
      tracerEnd = T_C;
    } else if (worldHit.hit) {
      Events.emit('hit:world', { point: worldHit.point, normal: worldHit.normal, kind: worldHit.kind });
      tracerEnd = worldHit.point;
    } else {
      T_C[0] = RAY_O[0] + RAY_D[0] * maxDist;
      T_C[1] = RAY_O[1] + RAY_D[1] * maxDist;
      T_C[2] = RAY_O[2] + RAY_D[2] * maxDist;
      tracerEnd = T_C;
    }
    // 即时射线也必须有可见弹道，否则玩家只会凭空掉血。敌弹用兵种强调色，
    // 狙击弹更粗更久，命中点按真实射线终点截断。
    if (this.projectiles && tracerEnd) {
      this.projectiles.spawnTracer(RAY_O, tracerEnd, {
        color: type.accentColor,
        width: e.typeId === 'sniper' ? 0.045 : 0.026,
        minWidth: 0.02,
        life: e.typeId === 'sniper' ? 0.22 : 0.13,
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
    if (!type.flying) {
      e.vel[1] -= CFG.move.gravity * dt;
      if (e.vel[1] < -55) e.vel[1] = -55;
    }
    // 水平速度上限
    const hs = Math.hypot(e.vel[0], e.vel[2]);
    const maxS = Math.max(type.speed * 1.35, externalMaxSpeed || 0);
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
    // 动画相位（走路摆动）
    e.animPhase += Math.hypot(e.vel[0], e.vel[2]) * dt * 2.6;
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
        Events.emit('audio:play', { name: 'hit_armor', pos: impactPos, gain: 0.86 });
      }
      if (res.shieldBreak) {
        // 破盾音放在护盾命中音之后、肉体命中音之前，听感上明确表现为
        // “金属受击 → 清脆碎裂 → 肉体受击”的顺序。
        Events.emit('audio:play', { name: 'shield_break', pos: impactPos, gain: 0.72 });
      }
      if (res.healthDamage > 0) {
        Events.emit('audio:play', {
          name: headshot ? 'hit_head' : 'hit_flesh', pos: impactPos, gain: 0.8,
        });
      }
    }

    // 实际扣除的总量（护盾 + 生命），而不是只返回护盾吸收量。
    res.damage = res.shieldDamage + res.healthDamage;
    this.stats.damageDealt += res.damage;
    if (!o.countAsDealt) res.countAsDealt = true;

    if (e.hp <= 0) {
      res.killed = true;
      this._kill(e, headshot, o);
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
    Events.emit('enemy:die', { enemy: e, pos: e.pos, byPlayer: true, headshot });
    Events.emit('audio:play', { name: 'enemy_die', pos: e.pos, gain: 0.7 });
    Events.emit('fx:shake', { amount: e.type.elite ? 0.25 : 0.08, time: 0.14 });
    if (this._onKill) this._onKill(e, headshot, opts);
    void opts;
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
      const boundR = Math.max(e.radius, e.height * 0.5) * 1.05;
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
    const shape = SHAPES[type.meshKind] || SHAPES.humanoid;
    // 每个形状由多个"部件"组成，每个部件一次 instanced draw
    for (let partIdx = 0; partIdx < shape.length; partIdx++) {
      const part = shape[partIdx];
      const mesh = e.sharedMeshes ? e.sharedMeshes[part.mesh] : null;
      if (!mesh) continue;
      let n = 0;
      const cap = Math.min(list.length, 512);
      for (let i = 0; i < cap; i++) {
        const en = list[i];
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
    // 受击闪白
    const flash = M.clamp01(en.hitFlash);
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

/** 命中盒：由形状推导（head / body / legs） */
function buildHitboxes(type, scale = 1) {
  const h = type.height * scale;
  const r = type.radius * scale;
  const boxes = [];
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
