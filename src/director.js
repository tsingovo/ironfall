// ==== director.js — 刷怪与节奏导演 ====
// 预算制 + 相位机的"AI 导演"，目标是制造有呼吸感的压力曲线：
//   intro(喘息) → build(压力上升) → peak(爆发) → respite(回落) → 循环
// 压力反馈：玩家打得顺 → 加压；连续挨打/残血 → 减压并给喘息窗口。
// 刷怪规则：必须在玩家视野外、距离足够远、且是合法导航点。

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';
import { ENEMY_TYPES } from './enemies.js';

export const PHASES = ['intro', 'build', 'peak', 'respite'];

/** 每层的兵种池与权重（越深越凶） */
const TIER_TABLES = [
  // tier 1
  { grunt: 10, swarm: 3 },
  // tier 2
  { grunt: 10, swarm: 5, shieldman: 3 },
  // tier 3
  { grunt: 9, swarm: 5, shieldman: 5, flyer: 3 },
  // tier 4
  { grunt: 8, swarm: 5, shieldman: 6, flyer: 5, sniper: 2 },
  // tier 5+
  { grunt: 8, swarm: 6, shieldman: 6, flyer: 6, sniper: 3, heavy: 2 },
];

/**
 * 需求 8：第三关开始每关都有 boss。
 *
 * 第 3 关沿用既有的绿影蛛皇（需求里没要求换），第 4~10 关各一个专属 boss。
 * 这里集中成一张表，便于调整顺序与提示文案。
 */
const TIER_BOSS = {
  3:  { typeId: 'broodStalker',       scale: 1.6, hint: '击败首领才能完成本层目标' },
  4:  { typeId: 'tier4ShieldMech',    scale: 1.0, hint: '正面护盾会挡住子弹 —— 绕到侧面或背后打' },
  5:  { typeId: 'tier5Stalker',       scale: 1.0, hint: '它会瞬移。看地面裂痕，捶地前离开范围' },
  6:  { typeId: 'tier6Dragon',        scale: 1.0, hint: '它在空中盘旋 —— 俯冲时才是输出窗口' },
  7:  { typeId: 'tier7Vat',           scale: 1.0, hint: '打罐子没用。清掉 100 只哥布林，罐子会自己炸' },
  8:  { typeId: 'tier8GhostKnight',   scale: 1.0, hint: '它会来回冲刺 —— 侧向躲开，不要正面接矛' },
  9:  { typeId: 'tier9Boxer',         scale: 1.0, hint: '远程武器对它无效 —— 只能用近战或贴身输出' },
  10: { typeId: 'tier10LavaGuardian', scale: 1.0, hint: '射击可以击落它的追踪弹' },
};

export class Director {
  constructor(world, enemies, player, opts = {}) {
    this.world = world;
    this.enemies = enemies;
    this.player = player;
    this.opts = opts;
    this.particles = opts.particles || null;
    this.rng = M.mulberry32(0xD17EC7);

    this.active = false;
    this.tier = 1;
    this.phase = 'intro';
    this.phaseTime = 0;
    this.waveIndex = 0;

    this.budget = 0;
    this.budgetRate = 1;
    this.intensity = 0.35;
    this.threat = 0;

    this.concurrencyLimit = 8;
    this.spawnCooldown = 0;
    this.aliveCount = 0;

    this.recentPlayerDps = 0;
    this.recentPlayerDamageTaken = 0;
    this._dpsWindow = [];
    this._lastKillTime = 0;
    this._time = 0;
    this._spawnScratch = new Float32Array(3);
    this._spawnHistory = [];
    this.pressure = 0;      // -1（太轻松）..+1（太艰难）
    this.enabled = true;
  }

  start(run) {
    this.run = run;
    this.active = true;
    this.tier = run ? run.tier : 1;
    this.phase = 'intro';
    this.phaseTime = 0;
    this.waveIndex = 0;
    this.budget = 0;
    this.intensity = 0.35;
    this.spawnCooldown = 2.0;
    this._time = 0;
    this._openingSpawned = false;
    this._boss = null;
    this._bossId = null;
    this._bossPulse = 0;
    // 需求 8：第 3 关开始**每关都有 boss**（原本只有 3/6/10 三层）。
    this.run.bossPending = this.tier >= 3;
    this._dpsWindow.length = 0;
    this._spawnHistory.length = 0;
    this._applyTier();
  }

  /** 开局只生成半波远处增援；目标标记负责提示方位，不再在面前凭空落地。 */
  spawnOpeningWave() {
    if (this._openingSpawned) return 0;
    this._openingSpawned = true;
    const table = this._table();
    const ids = Object.keys(table);
    const weights = ids.map((k) => table[k]);
    let made = 0;
    let skipped = 0;
    const want = 3 + Math.floor(this.tier / 2);
    for (let i = 0; i < want; i++) {
      const id = M.weightedPick(ids, weights, this.rng);
      const out = this._findSpawnPoint(id, true);
      if (!out) { skipped++; continue; }
      this.enemies.spawn(id, out, {});
      made++;
    }
    this._lastCombat = this._time;
    this._openingStats = { made, skipped };
    return made;
  }

  stop() {
    this.active = false;
  }

  setTier(tier) {
    this.tier = Math.max(1, tier | 0);
    this._applyTier();
  }

  _applyTier() {
    const t = this.tier;
    // 同时活跃上限随层数增长但有硬顶（保证帧率）
    // 敌人仍少于最早版本，但不再机械砍半：远距离增援会占用较长的赶路时间，
    // 若并发只有 5 个就会产生大段空场。约 70% 的旧上限配合安全刷新距离，
    // 能让玩家持续遇敌而不会回到贴脸围攻。
    this.concurrencyLimit = Math.min(32, 6 + t * 2);
    this.budgetRate = 0.65 + t * 0.40;
    this.enemies.setDifficulty(0.85 + (t - 1) * 0.28);
  }

  _table() {
    const idx = Math.min(TIER_TABLES.length - 1, this.tier - 1);
    const base = TIER_TABLES[idx];
    // 需求 8 之后每层都有 boss，爆蛛的 BOSS 层加成也跟着对所有 boss 层生效
    const bossFloor = this.tier >= 3;
    const total = Object.values(base).reduce((a,b)=>a+b,0);
    // Boss 关两种新怪合计约 90% 权重；普通关合计约 29%，受原并发/预算保护。
    //
    // 需求 11：绿影改为**只在第三关大量出现** ——
    //   第 3 关（本来就是 BOSS 层）保持高权重，是这一关的招牌压力来源；
    //   其它层权重归零，避免它每一关都刷屏。
    // 爆蛛不受影响，仍按原来的 BOSS 层加成逻辑走。
    const stalkerWeight = this.tier === 3 ? total * 4.5 : 0;
    return { ...base, stalker: stalkerWeight, blastSpider: total * (bossFloor ? 4.5 : 0.2) };
  }

  /**
   * 需求 8：各关 boss 的专属行为分发。
   *
   * 通用的移动/开火/AI 仍由 EnemySystem 负责；这里只处理"每个 boss 独有"的机制，
   * 这样既有战力与表现不变，新机制是叠加而不是替换。
   */
  _updateTierBoss(dt, boss) {
    if (!boss || !boss.alive) return;
    const k = boss.type.bossKind;
    if (!k) return;
    switch (k) {
      case 'shieldMech': this._bossShieldMech(dt, boss); break;
      case 'slenderKiller': this._bossSlenderKiller(dt, boss); break;
      case 'corruptDragon': this._bossCorruptDragon(dt, boss); break;
      case 'cloneVat': this._bossCloneVat(dt, boss); break;
      case 'ghostKnight': this._bossGhostKnight(dt, boss); break;
      case 'boxer': this._bossBoxer(dt, boss); break;
      case 'lavaGuardian': this._bossLavaGuardian(dt, boss); break;
      default: break;
    }
  }

  /** 把 boss 传送到目标点附近的可用落点（用于瞬移类机制） */
  _blinkBossTo(boss, tx, tz, opts) {
    const o = opts || {};
    const out = this._spawnScratch;
    out[0] = tx; out[1] = boss.pos[1]; out[2] = tz;
    // 找地面并把位置贴上去；找不到就退回原地
    if (this.world.groundHeight) {
      const gy = this.world.groundHeight(tx, tz);
      if (!Number.isFinite(gy) || gy < -200) return false;
      out[1] = gy + 0.2;
    }
    boss.pos[0] = out[0]; boss.pos[1] = out[1]; boss.pos[2] = out[2];
    boss.vel[0] = 0; boss.vel[1] = 0; boss.vel[2] = 0;
    if (o.facePlayer !== false) {
      const p = this.player;
      if (p) boss.yaw = Math.atan2(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);
    }
    // 瞬移是玩家能看见的事件，给一次特效，避免"它怎么突然出现了"
    if (this.enemies && typeof this.enemies.playSpecialFx === 'function') {
      this.enemies.playSpecialFx(o.fx || 'boss-summon', [boss.pos[0], boss.pos[1] + boss.height * 0.5, boss.pos[2]]);
    }
    return true;
  }

  /** 第 4 关：重盾机甲 —— 转向慢、正面蓝色护盾、放爆炸蜘蛛、艺术激光炮 + 减速 */
  _bossShieldMech(dt, boss) {
    const p = this.player;
    if (!p || !p.alive) return;
    const t = boss.type;
    // 转向慢：把朝向以受限角速度转向玩家（而不是瞬间对准）
    const want = Math.atan2(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);
    let d = want - boss.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const maxTurn = (t.turnRate || 1.1) * dt;
    boss.yaw += Math.max(-maxTurn, Math.min(maxTurn, d));
    boss.aimYaw = boss.yaw;                    // 炮口跟着机体转，形成"绕到侧面"的玩法

    // 周期性释放 2~3 只爆炸蜘蛛
    boss.summonT = (boss.summonT || 3) - dt;
    if (boss.summonT <= 0) {
      boss.summonT = 9;
      const n = 2 + (this.rng() < 0.5 ? 0 : 1);      // 2 或 3
      for (let i = 0; i < n; i++) {
        const ang = this.rng() * Math.PI * 2;
        const r = 3 + this.rng() * 3;
        const sx = boss.pos[0] + Math.cos(ang) * r;
        const sz = boss.pos[2] + Math.sin(ang) * r;
        const gy = this.world.groundHeight ? this.world.groundHeight(sx, sz) : boss.pos[1];
        if (!Number.isFinite(gy) || gy < -200) continue;
        this.enemies.spawn('blastSpider', [sx, gy + 0.3, sz], {});
      }
      if (this.enemies.playSpecialFx) {
        this.enemies.playSpecialFx('boss-summon', [boss.pos[0], boss.pos[1] + 1, boss.pos[2]]);
      }
    }
  }

  /** 第 5 关：神秘杀手 —— 每秒瞬移、贴身捶地击飞、随后远遁等待 */
  _bossSlenderKiller(dt, boss) {
    const p = this.player;
    if (!p || !p.alive) return;
    const t = boss.type;
    boss.smashPhase = boss.smashPhase || 'hunt';
    boss.smashT = boss.smashT || 0;
    boss.blinkT = (boss.blinkT == null ? t.blinkInterval : boss.blinkT) - dt;

    if (boss.smashPhase === 'wait') {
      // 捶地后远遁：等待结束再回来
      boss.waitT = (boss.waitT || 0) - dt;
      if (boss.waitT <= 0) { boss.smashPhase = 'hunt'; boss.blinkT = 0; }
      return;
    }
    if (boss.smashPhase === 'smash') {
      boss.smashT -= dt;
      boss.vel[0] = 0; boss.vel[2] = 0;                 // 捶地时不动
      if (boss.smashT <= 0) {
        // 结算范围伤害：玩家 100 点 + 击飞；其他怪物直接被秒杀
        const R = t.smashRadius || 9;
        const d = Math.hypot(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);
        if (d <= R) {
          const dir = [p.pos[0] - boss.pos[0], 0.55, p.pos[2] - boss.pos[2]];
          const L = Math.hypot(dir[0], dir[2]) || 1;
          dir[0] /= L; dir[2] /= L;
          p.applyDamage(t.weapon.damage || 100, dir, boss);
          // 击飞初速度：按需求约能飞 30m
          const kb = t.knockback || 30;
          p.vel[0] += dir[0] * kb;
          p.vel[1] += dir[1] * kb * 0.7;
          p.vel[2] += dir[2] * kb;
        }
        // 秒杀范围内的其他怪物
        if (t.killsMinions && this.enemies && this.enemies.all) {
          for (const e of this.enemies.all) {
            if (e === boss || !e.alive) continue;
            if (e.type.tierBoss) continue;              // 不误伤其他 boss
            const dd = Math.hypot(e.pos[0] - boss.pos[0], e.pos[2] - boss.pos[2]);
            if (dd <= R) this.enemies.damage(e, 999999, false, e.pos, null, { source: 'boss-smash' });
          }
        }
        if (this.enemies.playSpecialFx) {
          this.enemies.playSpecialFx('explosion', [boss.pos[0], boss.pos[1] + 0.3, boss.pos[2]]);
        }
        Events.emit('audio:play', { name: 'explosion', pos: boss.pos, gain: 1 });
        // 瞬移到 100m 之外等待
        const ang = this.rng() * Math.PI * 2;
        const far = t.postSmashBlink || 100;
        this._blinkBossTo(boss, boss.pos[0] + Math.cos(ang) * far, boss.pos[2] + Math.sin(ang) * far);
        boss.smashPhase = 'wait';
        boss.waitT = t.postSmashWait || 3;
      }
      return;
    }
    // hunt：贴近到 10m 内就捶地；否则每秒瞬移一次拉近距离
    const dist = Math.hypot(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);
    if (dist <= (t.smashRange || 10)) {
      boss.smashPhase = 'smash';
      boss.smashT = t.smashTime || 1.5;
      if (this.enemies.playSpecialFx) {
        this.enemies.playSpecialFx('spider-charge', [boss.pos[0], boss.pos[1] + 0.2, boss.pos[2]]);
      }
      return;
    }
    if (boss.blinkT <= 0) {
      boss.blinkT = t.blinkInterval || 1.0;
      // 在周边 blinkRange 内随机瞬移（偏向玩家，保证它能靠近）
      const ang = this.rng() * Math.PI * 2;
      const r = 6 + this.rng() * ((t.blinkRange || 50) * 0.5);
      const tx = p.pos[0] + Math.cos(ang) * r;
      const tz = p.pos[2] + Math.sin(ang) * r;
      this._blinkBossTo(boss, tx, tz, { fx: 'boss-summon' });
    }
  }

  /** 第 6 关：腐化龙 —— 空中盘旋，偶尔锁定正下方玩家并俯冲 */
  _bossCorruptDragon(dt, boss) {
    const p = this.player;
    if (!p || !p.alive) return;
    const t = boss.type;
    boss.divePhase = boss.divePhase || 'circle';
    if (boss.divePhase === 'circle') {
      boss.diveT = (boss.diveT == null ? (t.diveCooldown || 7) : boss.diveT) - dt;
      // 悬停在玩家上空 ~18m，绕着玩家慢慢转
      const want = (t.hoverHeight || 18) + (this.world.groundHeight
        ? this.world.groundHeight(boss.pos[0], boss.pos[2]) : 0);
      boss.vel[1] = (want - boss.pos[1]) * 1.2;
      if (boss.diveT <= 0 && Math.hypot(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]) <= (t.diveRange || 100)) {
        boss.divePhase = 'dive';
        boss.diveTarget = [p.pos[0], p.pos[1], p.pos[2]];
        if (this.enemies.playSpecialFx) {
          this.enemies.playSpecialFx('spider-charge', [boss.pos[0], boss.pos[1], boss.pos[2]]);
        }
      }
      return;
    }
    if (boss.divePhase === 'dive') {
      // 朝锁定位置俯冲（锁定的是俯冲开始那一刻的位置，玩家可以走开）
      const tg = boss.diveTarget || [p.pos[0], p.pos[1], p.pos[2]];
      const dx = tg[0] - boss.pos[0], dy = tg[1] - boss.pos[1], dz = tg[2] - boss.pos[2];
      const L = Math.hypot(dx, dy, dz) || 1;
      const sp = t.diveSpeed || 34;
      boss.vel[0] = dx / L * sp;
      boss.vel[1] = dy / L * sp;
      boss.vel[2] = dz / L * sp;
      // 冲到目标附近就命中判定并拉起
      if (L < 3.5) {
        const pd = Math.hypot(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);
        if (pd < 4.5) {
          const dir = [0, -0.4, 0];
          p.applyDamage(t.weapon.damage || 100, dir, boss);
        }
        if (this.enemies.playSpecialFx) {
          this.enemies.playSpecialFx('explosion', [boss.pos[0], boss.pos[1], boss.pos[2]]);
        }
        boss.divePhase = 'climb';
      }
      return;
    }
    // climb：拉回空中再重新盘旋
    boss.vel[1] = t.climbSpeed || 18;
    const want = (t.hoverHeight || 18) + (this.world.groundHeight
      ? this.world.groundHeight(boss.pos[0], boss.pos[2]) : 0);
    if (boss.pos[1] >= want - 1) {
      boss.divePhase = 'circle';
      boss.diveT = t.diveCooldown || 7;
    }
  }

  /** 第 7 关：克隆罐 —— 维持 50 只哥布林，累计死亡 100 只后爆炸 */
  _bossCloneVat(dt, boss) {
    const t = boss.type;
    boss.vatKills = boss.vatKills || 0;
    // 统计当前存活的哥布林
    let alive = 0;
    if (this.enemies && this.enemies.all) {
      for (const e of this.enemies.all) {
        if (e.alive && e.typeId === 'tier7CloneGoblin') alive++;
      }
    }
    // 不足就立刻补（需求："每死亡一只哥布林由克隆罐即刻在罐子旁生成一只新的"）
    boss.vatSpawnCd = (boss.vatSpawnCd || 0) - dt;
    const want = t.concurrent || 50;
    if (alive < want && boss.vatSpawnCd <= 0) {
      // 一次补 1 只，但用很小的间隔避免开局一帧涌出 50 只
      boss.vatSpawnCd = t.spawnInterval || 0.16;
      const ang = this.rng() * Math.PI * 2;
      const r = 2.5 + this.rng() * 4;
      const sx = boss.pos[0] + Math.cos(ang) * r;
      const sz = boss.pos[2] + Math.sin(ang) * r;
      const gy = this.world.groundHeight ? this.world.groundHeight(sx, sz) : boss.pos[1];
      if (Number.isFinite(gy) && gy > -200) {
        this.enemies.spawn('tier7CloneGoblin', [sx, gy + 0.3, sz], {});
      }
    }
    // 累计死亡数：由 EnemySystem 的击杀事件累加（见 enemies.js 对 cloneVat 的处理）
    if (boss.vatKills >= (t.killGoal || 100)) {
      // 罐子自动爆炸：很大一声炸弹声、全图可听
      Events.emit('audio:play', { name: 'explosion', pos: boss.pos, gain: 2.0 });
      Events.emit('ui:message', { title: '克隆罐已过载', sub: '克隆体被清空', kind: 'good' });
      if (this.enemies.playSpecialFx) {
        this.enemies.playSpecialFx('explosion', [boss.pos[0], boss.pos[1] + 1, boss.pos[2]]);
      }
      this.enemies.damage(boss, 99999999, false, boss.pos, null, { source: 'vat-overload' });
    }
  }

  /** 第 8 关：鬼火骑士 —— 来回冲刺，击中后仍要冲满 40m */
  _bossGhostKnight(dt, boss) {
    const p = this.player;
    if (!p || !p.alive) return;
    const t = boss.type;
    boss.chargePhase = boss.chargePhase || 'aim';
    boss.chargeDist = boss.chargeDist || 0;
    if (boss.chargePhase === 'aim') {
      boss.chargeT = (boss.chargeT || t.chargeWindup || 0.45) - dt;
      boss.vel[0] = 0; boss.vel[2] = 0;
      if (boss.chargeT <= 0) {
        // 锁定方向后开始冲刺
        const dx = p.pos[0] - boss.pos[0], dz = p.pos[2] - boss.pos[2];
        const L = Math.hypot(dx, dz) || 1;
        boss.chargeDir = [dx / L, dz / L];
        boss.chargePhase = 'charge';
        boss.chargeDist = 0;
      }
      return;
    }
    // 冲刺中：沿锁定方向全速推进，**即使命中玩家也不停**（需求：至少 40m）
    const sp = t.chargeSpeed || 26;
    const before = [boss.pos[0], boss.pos[2]];
    boss.vel[0] = boss.chargeDir[0] * sp;
    boss.vel[2] = boss.chargeDir[1] * sp;
    boss.chargeDist += Math.hypot(boss.pos[0] - before[0], boss.pos[2] - before[1]);
    if (boss.chargeDist >= (t.chargeMinDistance || 40)) {
      boss.chargePhase = 'aim';
      boss.chargeT = t.chargeWindup || 0.45;
    }
  }

  /** 第 9 关：拳皇 —— 只会跳着走；远程攻击无效 */
  _bossBoxer(dt, boss) {
    // 跳跃由 EnemySystem 的通用 hop 机制驱动（见 _spiderQueenHop 对 hopOnly 的复用），
    // 这里只维持"远程免疫"的标记与落地节流。
    boss.rangedImmune = true;
  }

  /** 第 10 关：熔岩守卫者 —— 大跳保持距离、放不动的爆炸蜘蛛、追踪弹幕 */
  _bossLavaGuardian(dt, boss) {
    const p = this.player;
    if (!p || !p.alive) return;
    const t = boss.type;
    const dist = Math.hypot(p.pos[0] - boss.pos[0], p.pos[2] - boss.pos[2]);

    // 刻意保持 50~150m：太近就跳开，太远就跳近
    boss.leapT = (boss.leapT || 0) - dt;
    if (boss.leapT <= 0 && boss.grounded) {
      const tooNear = dist < (t.keepMin || 50);
      const tooFar = dist > (t.keepMax || 150);
      if (tooNear || tooFar) {
        boss.leapT = t.leapCooldown || 4.5;
        const ang = this.rng() * Math.PI * 2;
        const r = tooNear ? 60 + this.rng() * 40 : 40 + this.rng() * 40;
        const tx = p.pos[0] + Math.cos(ang) * r;
        const tz = p.pos[2] + Math.sin(ang) * r;
        // 横跨 100m 以内任意跳跃：直接落点传送 + 一段上抛动画由物理接管
        this._blinkBossTo(boss, tx, tz, { fx: 'boss-summon' });
        boss.vel[1] = 12;
      }
    }

    // 扔出不会动的爆炸蜘蛛（玩家靠近才蓄力爆炸）
    boss.seedT = (boss.seedT || t.seedSpiderCooldown || 5) - dt;
    if (boss.seedT <= 0) {
      boss.seedT = t.seedSpiderCooldown || 5;
      const n = t.seedSpiderCount || 3;
      for (let i = 0; i < n; i++) {
        const ang = this.rng() * Math.PI * 2;
        const r = 4 + this.rng() * 8;
        const sx = boss.pos[0] + Math.cos(ang) * r;
        const sz = boss.pos[2] + Math.sin(ang) * r;
        const gy = this.world.groundHeight ? this.world.groundHeight(sx, sz) : boss.pos[1];
        if (!Number.isFinite(gy) || gy < -200) continue;
        const sp = this.enemies.spawn('blastSpider', [sx, gy + 0.3, sz], {});
        // "不会动"：标记为静止，由 AI 检查
        sp.stationarySeed = true;
      }
    }

    // 间歇性红色大型子弹：慢、多（每秒约 5 个）、追踪玩家、可被击破
    boss.bulletT = (boss.bulletT || 0) - dt;
    if (boss.bulletT <= 0 && dist < (t.attackRange || 200)) {
      // 一次射出一个"波次"，持续约 1 秒、每秒 5 发
      const perSec = t.bulletPerSecond || 5;
      const shots = Math.max(1, Math.round(perSec * (t.bulletBurstInterval > 1 ? 1 : 1)));
      for (let i = 0; i < shots; i++) {
        this._spawnHomingBullet(boss, t, i * (1 / perSec));
      }
      boss.bulletT = (t.bulletBurstInterval || 4.0);
      Events.emit('audio:play', { name: 'sniper_fire', pos: boss.pos, gain: 0.7 });
    }
  }

  /**
   * 熔岩守卫者的追踪弹。
   * 需求：速度慢、数量多、追踪玩家、玩家射击可击破（血量 1）、命中伤害 40。
   * 用投射物系统实现，这样它能被玩家的子弹命中（bloodHp=1）。
   */
  _spawnHomingBullet(boss, t, delay) {
    const proj = this.enemies && this.enemies.projectiles;
    if (!proj || typeof proj.spawn !== 'function') return;
    const ang = Math.atan2(this.player.pos[0] - boss.pos[0], this.player.pos[2] - boss.pos[2]) + (this.rng() - 0.5) * 0.5;
    const muzzle = [boss.pos[0], boss.pos[1] + boss.height * 0.7, boss.pos[2]];
    const dir = [Math.sin(ang), 0.06, Math.cos(ang)];
    proj.spawn(muzzle, dir, t.bulletSpeed || 11, {
      color: [1.0, 0.22, 0.12], width: 0.42, life: 9.0,
      damage: t.bulletDamage || 40, ownerId: -1, gravity: 0,
      // 血量 1 → 被任意子弹命中即消失
      hp: t.bulletHp || 1, homing: !!t.bulletHoming, homingTarget: 'player',
      delayed: delay || 0,
    });
  }

  _updateBossSummons(dt) {
    const boss=this._boss;
    if(!boss?.alive || !boss.type.hybridBoss || this.enemies.replicated) return;
    if(boss.summonCast>0) {
      boss.summonCast-=dt;
      if(boss.summonCast>0) return;
      // 有限增援池，Boss 活着时才召唤；不覆盖/删除既有敌人来强行腾位。
      let room=Math.min(4,this.concurrencyLimit-this.enemies.aliveCount());
      const living=this.enemies.all.filter(e=>e.alive && e.summonerId===boss.id).length;
      room=Math.min(room,6-living);
      const candidates=this.world.navCandidates()||[];
      let made=0;
      for(const id of ['blastSpider','stalker','blastSpider','stalker']) {
        if(made>=room) break;
        let best=null,bestDistance=Infinity;
        for(const pos of candidates) {
          const distance=M.dist3(pos,boss.pos);
          if(distance<5 || distance>35 || distance>=bestDistance || this._tooCloseToEnemy(pos,2)) continue;
          // 不在任何玩家脚下召唤，也不在障碍物内部召唤。
          if((this.enemies.players||[this.player]).some(p=>p?.alive && M.dist3(pos,p.pos)<12)) continue;
          const type=ENEMY_TYPES[id],resolved=Array.from(pos);
          this.world.resolveCapsule(resolved,type.radius,type.height,3);
          if(M.dist3(resolved,pos)>0.4) continue;
          best=resolved;bestDistance=distance;
        }
        if(!best) continue;
        const minion=this.enemies.spawn(id,best,{});
        minion.summonerId=boss.id;
        this.enemies._specialFx('boss-summon',best);
        made++;
      }
      boss.summonCooldown=8;
      return;
    }
    boss.summonCooldown-=dt;
    if(boss.summonCooldown<=0) {
      boss.summonCast=0.9;
      this.enemies._specialFx('boss-summon',boss.pos);
    }
  }

  // ---------------------------------------------------------------- 更新

  update(dt) {
    if (!this.active || !this.enabled) return;
    this._time += dt;
    this.phaseTime += dt;
    if (this.run.bossPending) {
      if (!this._boss) {
        const spec = TIER_BOSS[this.tier] || TIER_BOSS[3];
        const pos = this._findSpawnPoint(spec.typeId, true);
        if (pos) {
          const boss = this.enemies.spawn(spec.typeId, pos, { elite: true, scale: spec.scale });
          this._boss = boss;
          this._bossId = boss.id;
          // 血量缩放（需求："除了拳皇外，boss 血量按目前样本大致线性增长"）。
          // 拳皇的血量在需求里写死 500，所以跳过缩放。
          if (!boss.type.flatHp) {
            boss.maxHp = Math.round(boss.maxHp * (5 + this.tier) * (1 + Math.max(0, this.tier - 3) * 0.15));
          }
          boss.hp = boss.maxHp;
          // 盾牌类 boss（重盾机甲）的血量靠正面护盾承伤，不再额外乘护盾
          boss.maxShield = Math.round(boss.maxShield * (boss.type.frontShield ? 1 : 3));
          boss.shield = boss.maxShield;
          // 克隆罐：把自己登记成 run 的 boss 目标，并在罐子旁持续生成哥布林
          if (boss.type.bossKind === 'cloneVat') {
            boss.vatSpawned = 0;
            boss.vatKills = 0;
          }
          Events.emit('audio:play', { name: 'boss_arrive' });
          Events.emit('ui:message', {
            title: `守关首领：${boss.type.name}`,
            sub: spec.hint || '击败首领才能完成本层目标',
            kind: 'warn',
          });
        }
      } else if (!this._boss.alive || this._boss.id !== this._bossId) {
        this.run.bossPending = false;
        Events.emit('audio:play', { name: 'boss_defeat' });
        Events.emit('ui:message', { title: '首领已击败', sub: '完成剩余目标，结束本层远征', kind: 'good' });
      } else {
        this._updateBossSummons(dt);
        // 需求 8：各 boss 的专属行为
        this._updateTierBoss(dt, this._boss);
        this._bossPulse -= dt;
        if (this._bossPulse <= 0) {
          this._bossPulse = 8;
          Events.emit('audio:play', { name: 'boss_arrive' });
        }
      }
    }

    // 统计玩家表现
    this._updatePlayerMetrics(dt);

    // 相位推进
    const durations = {
      intro: 9,
      build: 26 + this.tier * 2,
      peak: 17 + this.tier * 1.5,
      respite: 11,
    };
    if (this.phaseTime > durations[this.phase]) {
      this._nextPhase();
    }

    // 强度爬升
    const phaseTarget = {
      intro: 0.28,
      build: 0.62,
      peak: 1.0,
      respite: 0.22,
    }[this.phase];
    // 压力修正：玩家太轻松就加压，太惨就减压
    const adjust = M.clamp(this.pressure, -0.35, 0.35);
    const target = M.clamp01(phaseTarget + adjust * 0.5);
    this.intensity = M.damp(this.intensity, target, 1.4, dt);

    // 预算累积
    this.budget += this.budgetRate * this.intensity * dt;
    // 未使用的预算缓慢衰减，避免憋一波超大爆发
    this.budget = Math.min(this.budget, 60 + this.tier * 22);

    // 刷怪
    this.spawnCooldown -= dt;
    this.aliveCount = this.enemies.aliveCount();
    if (this.spawnCooldown <= 0) {
      // 开场先放一波"迎面而来"的敌人，之后才进入常规预算刷怪
      if (!this._openingSpawned && (!this.run || this.run.phase !== 'deploy')) {
        this.spawnOpeningWave();
      }
      this._trySpawnWave();
    }

    // 威胁度（给 HUD / 音乐用）
    const nearThreat = this._nearbyThreat();
    this.threat = M.clamp01(this.intensity * 0.5 + M.clamp01(nearThreat / 6) * 0.5);
  }

  _nextPhase() {
    const order = ['intro', 'build', 'peak', 'respite'];
    let i = order.indexOf(this.phase);
    // respite 之后回到 build
    i = (i + 1) % order.length;
    this.phase = order[i];
    this.phaseTime = 0;
    if (this.phase === 'peak') {
      this.waveIndex++;
      Events.emit('ui:message', {
        title: '敌军增援抵达', sub: `威胁等级上升 —— 波次 ${this.waveIndex}`, kind: 'warn',
      });
      Events.emit('audio:play', { name: 'enemy_alert', gain: 0.8 });
    } else if (this.phase === 'respite') {
      Events.emit('ui:message', {
        title: '敌军暂时后撤', sub: '趁机补给与推进目标', kind: 'good',
      });
    }
  }

  _updatePlayerMetrics(dt) {
    const p = this.player;
    // 用扁平数组存血量滑窗（每两个元素一个样本：[时间, 生命+护盾]），零对象分配
    const win = this._dpsWindow;
    win.push(this._time, p.health + p.shield);
    // 只保留最近 6 秒（主循环约 128Hz 时约 768 个样本，至少留 8 个）
    while (win.length > 16 && this._time - win[0] > 6) win.splice(0, 2);

    let hpTrend = 0;
    const n = win.length / 2;
    if (n > 1) {
      const oldest = win[1];
      const newest = win[win.length - 1];
      const span = Math.max(0.25, this._time - win[0]);
      hpTrend = (newest - oldest) / span;   // 每秒净变化
    }
    // 玩家血量比例低 + 持续掉血 => 减压
    const hpFrac = (p.health + p.shield) / Math.max(1, p.maxHealth + p.maxShield);
    let pressure = 0;
    if (hpFrac > 0.8) pressure += 0.5;
    else if (hpFrac > 0.55) pressure += 0.15;
    else if (hpFrac < 0.3) pressure -= 0.7;
    else if (hpFrac < 0.45) pressure -= 0.3;
    if (hpTrend < -3) pressure -= 0.4;
    if (hpTrend > 4) pressure += 0.25;
    // 玩家机动性强（高速移动多）视为游刃有余
    if (p.state.hspeed > 14) pressure += 0.2;
    // 连杀多 => 加压
    if (this.run && this.run.combo > 6) pressure += 0.35;
    // 最近没有战斗 => 加压（避免长时间空场）
    if (this._time - this._lastCombat > 12) pressure += 0.4;
    this.pressure = M.damp(this.pressure, M.clamp(pressure, -1, 1), 0.8, dt);
  }

  _nearbyThreat() {
    const p = this.player;
    let t = 0;
    for (const e of this.enemies.all) {
      if (!e.alive) continue;
      const d = M.dist3(e.pos, p.pos);
      if (d < 30) t += (e.type.threat || 1) * (1 - d / 30);
    }
    return t;
  }

  // ---------------------------------------------------------------- 刷怪

  _trySpawnWave() {
    const table = this._table();
    const ids = Object.keys(table);
    const weights = ids.map((k) => table[k]);
    const summonReserve = this._boss?.alive && this._boss.type.hybridBoss ? 4 : 0;
    const concurrencyLeft = this.concurrencyLimit - this.aliveCount - summonReserve;
    if (concurrencyLeft <= 0) {
      this.spawnCooldown = 0.8;
      return;
    }

    // 一次刷 1..N 个，受预算与并发限制
    const want = 1 + Math.floor(this.rng() * (1 + this.intensity * 2.2));
    let spawned = 0;
    for (let i = 0; i < want; i++) {
      if (spawned >= concurrencyLeft) break;
      const id = M.weightedPick(ids, weights, this.rng);
      const threat = THREAT_COST[id] || 1;
      if (this.budget < threat) break;
      const pos = this._findSpawnPoint(id);
      if (!pos) continue;
      this.budget -= threat;
      this.enemies.spawn(id, pos, { elite: this.rng() < 0.06 + this.tier * 0.015 });
      spawned++;
    }

    if (spawned > 0) {
      this._lastCombat = this._time;
      this.spawnCooldown = Math.max(0.35, (1.9 - this.intensity * 1.1) * (0.7 + this.rng() * 0.6));
    } else {
      this.spawnCooldown = 0.7;
    }
  }

  /**
   * 在玩家周围的"环形带"里找一个可站立的刷怪点。
   *
   * 为什么不用"从全场导航点里随机抽"：那样距离完全不受控，实测抽出来的点在
   * 35~109m，多数落在 60~110m 外 —— 敌人要跑十几秒才能到玩家面前，
   * 玩家体感就是"没有敌人"。这里改成先定距离与方位，再找离目标最近的可站点。
   *
   * @param minD 最小距离   @param maxD 最大距离
   * @param frontBias 0..1，1 = 只在前方半球，0 = 全向
   */
  /**
   * 兵种的高台偏好（需求 2：高处狙击手）。
   * 返回 null 表示该兵种不挑高度；返回 { min } 表示必须比玩家高至少 min 米。
   * 结果按 typeId 缓存 —— 刷怪是热路径，别每次刷怪都去查表 + 构造对象。
   */
  _highGroundPref(typeId) {
    if (!this._highPrefCache) this._highPrefCache = new Map();
    if (this._highPrefCache.has(typeId)) return this._highPrefCache.get(typeId);
    const def = ENEMY_TYPES[typeId];
    const pref = def && def.prefersHighGround
      ? { min: Number.isFinite(def.highGroundMin) ? def.highGroundMin : 6 }
      : null;
    this._highPrefCache.set(typeId, pref);
    return pref;
  }

  /** 该兵种这次刷怪是否必须占高台（高台点不够时允许放宽，避免刷不出怪） */
  _typePrefersHighGround(typeId, pref) {
    return !!pref;
  }

  _samplePointInRing(minD, maxD, frontBias, typeId) {
    const highPref = this._highGroundPref(typeId);
    const out = this._spawnScratch;

    // 高台兵种（需求 2）：先严格只在高台里找；找不到再放宽到任意高度。
    // 放宽这一轮是必须的 —— 地图没有高台、或高台都落在刷怪环之外时，
    // 严格过滤会让该兵种**完全刷不出来**，属于静默失效，比偶尔刷在地面糟糕得多。
    if (highPref) {
      const strict = this._sampleRingPass(minD, maxD, frontBias, typeId, highPref, false)
        || this._sampleRingPass(minD, maxD, frontBias, typeId, highPref, true);
      if (!strict) return null;
      out[0] = strict[0]; out[1] = strict[1]; out[2] = strict[2];
      this.world.snapToGround(out, 0.15);
      return out;
    }

    const got = this._sampleRingPass(minD, maxD, frontBias, typeId, null, false);
    if (!got) return null;
    out[0] = got[0]; out[1] = got[1]; out[2] = got[2];
    this.world.snapToGround(out, 0.15);
    return out;
  }

  /**
   * 环形采样的一轮：在 [minD,maxD] 环内挑一个可站导航点。
   * 抽成独立函数是为了让高台兵种能"严格一轮 + 放宽一轮"复用同一套评分逻辑。
   *
   * 返回候选点本身（不是共享 scratch），由调用方拷进 out —— 两轮连调时
   * 如果都写同一块 scratch，第一轮的结果会被第二轮覆盖。
   */
  _sampleRingPass(minD, maxD, frontBias, typeId, highPref, relaxHigh) {
    const p = this.player;
    const w = this.world;
    const cands = w.navCandidates();
    if (!cands.length) return null;

    // 高台过滤必须在**找最近候选点这一步**生效：
    // 否则"最近的导航点"永远先被地面点抢走，之后再按高度剔除就恒为 0。
    const needHigh = (highPref && !relaxHigh) ? (highPref.min + p.pos[1]) : -Infinity;
    let best = null;
    let bestScore = Infinity;

    for (let attempt = 0; attempt < 26; attempt++) {
      const dist = minD + this.rng() * (maxD - minD);
      // 方位：以视线为中心还是全向
      let ang;
      if (this.rng() < frontBias) {
        ang = p.yaw + (this.rng() - 0.5) * 1.6;      // 前方 ±46°
      } else {
        ang = this.rng() * Math.PI * 2;
      }
      // 注意 yaw=0 朝 -Z，所以前方是 (-sin, -cos)
      const tx = p.pos[0] - Math.sin(ang) * dist;
      const tz = p.pos[2] - Math.cos(ang) * dist;

      let nearest = null;
      let nd = Infinity;
      for (let i = 0; i < cands.length; i += 3) {
        const c = cands[i];
        if (c[1] < needHigh) continue;                 // 不够高，不参与
        const d2 = (c[0] - tx) * (c[0] - tx) + (c[2] - tz) * (c[2] - tz);
        if (d2 < nd) { nd = d2; nearest = c; }
      }
      if (!nearest) continue;

      nd = Math.sqrt(nd);
      const actual = Math.hypot(nearest[0] - p.pos[0], nearest[2] - p.pos[2]);
      if (actual < minD || actual > maxD * 1.35) continue;
      if (this._tooCloseToEnemy(nearest, 2.0)) continue;
      if (!this._isSafeSpawnPoint(typeId, nearest, minD)) continue;

      // 越高越优先（负分 = 更好）。放宽轮不加这个偏好，免得又偏向高台导致
      // 在"高台够不着"的图上白跑一轮。
      let highBonus = 0;
      if (highPref && !relaxHigh) {
        highBonus = -Math.min(60, Math.max(0, nearest[1] - p.pos[1]) * 2.2);
      }
      // 离目标点越近越好；距离接近目标距离的加分。
      // 可见位置不是绝对禁用（开放地图仍需刷怪），但会被明显降权。
      const score = nd + Math.abs(actual - dist) * 0.5
        + (this._visibleFromPlayer(nearest, typeId) ? 24 : 0) + highBonus;
      if (score < bestScore) {
        bestScore = score;
        best = nearest;
      }
    }

    // 返回副本：cands 是 world 的共享数组，直接返回引用会被后续改动污染
    return best ? [best[0], best[1], best[2]] : null;
  }

  /**
   * 常规刷怪点：主力用环形采样（16~34m），少量沿用地图给定出生点做变化。
   *
   * 距离取 16~34m 的依据：实测 25~45m 时，在这种结构密集的地图里敌人仍会被
   * 建筑挡住、玩家"看不到对手"；16~34m 既能立刻交火，又远到不会贴脸凭空出现。
   * 大部分刷在**玩家前方半球**，避免永远只在背后刷怪。
   */
  _findSpawnPoint(typeId, opening = false) {
    const p = this.player;
    const w = this.world;
    const out = this._spawnScratch;

    const range = this._spawnRange(typeId, opening);

    // 优先从远距离环形导航点采样；前方只做轻微偏置，避免每次都在玩家眼前生成。
    if (this.rng() < 0.82) {
      const ring = this._samplePointInRing(range.min, range.max, opening ? 0.45 : 0.28, typeId);
      if (ring) return ring;
    }

    const sp = w.spawnPoints();
    for (let attempt = 0; attempt < 16; attempt++) {
      let cand = null;
      if (sp && sp.length > 0) {
        cand = sp[(this.rng() * sp.length) | 0];
        out[0] = cand[0]; out[1] = cand[1]; out[2] = cand[2];
        w.snapToGround(out, 0.15);
      } else {
        w.randomOpenPoint(this.rng, p.pos, out);
      }
      const d = M.dist3(out, p.pos);
      if (d < range.min || d > range.max * 1.35) continue;
      if (this._tooCloseToEnemy(out, 2.0)) continue;
      if (!this._isSafeSpawnPoint(typeId, out, range.min)) continue;
      return out;
    }

    return this._samplePointInRing(range.min, range.max + 45, 0.12, typeId);
  }

  _spawnRange(typeId, opening) {
    const type = ENEMY_TYPES[typeId] || ENEMY_TYPES.grunt;
    // 任意兵种至少出生在自身攻击距离之外 12m；狙击手因此只能从真正的远点增援。
    const min = Math.max(opening ? 50 : 48, (type.attackRange || 30) + 12);
    return { min, max: Math.max(opening ? 78 : 90, min + 38) };
  }

  _isSafeSpawnPoint(typeId, pos, minDistance) {
    const type = ENEMY_TYPES[typeId] || ENEMY_TYPES.grunt;
    const d = M.dist3(pos, this.player.pos);
    if (d < Math.max(minDistance || 0, (type.attackRange || 0) + 12)) return false;
    // 若出生点恰好完全暴露，就再要求额外 16m 缓冲；其余位置由 1.5s 攻击锁兜底。
    if (this._visibleFromPlayer(pos, typeId) && d < (type.attackRange || 0) + 28) return false;
    return true;
  }

  _visibleFromPlayer(pos, typeId) {
    const p = this.player;
    const type = ENEMY_TYPES[typeId] || ENEMY_TYPES.grunt;
    const origin = p.eyePos || p.pos;
    RAY_O[0] = origin[0];
    RAY_O[1] = p.eyePos ? origin[1] : origin[1] + CFG.cam.eyeHeight;
    RAY_O[2] = origin[2];
    RAY_D[0] = pos[0] - RAY_O[0];
    RAY_D[1] = pos[1] + (type.height || 1.8) * 0.62 - RAY_O[1];
    RAY_D[2] = pos[2] - RAY_O[2];
    const d = Math.hypot(RAY_D[0], RAY_D[1], RAY_D[2]);
    if (d < 0.2) return true;
    RAY_D[0] /= d; RAY_D[1] /= d; RAY_D[2] /= d;
    return !this.world.raycast(RAY_O, RAY_D, Math.max(0, d - 0.45), {}).hit;
  }

  _tooCloseToEnemy(pos, minDist) {
    const md2 = minDist * minDist;
    for (const e of this.enemies.all) {
      if (!e.alive) continue;
      if (M.distSq3(e.pos, pos) < md2) return true;
    }
    return false;
  }

  debugState() {
    return {
      active: this.active,
      phase: this.phase,
      phaseTime: Math.round(this.phaseTime * 10) / 10,
      waveIndex: this.waveIndex,
      intensity: Math.round(this.intensity * 100) / 100,
      threat: Math.round(this.threat * 100) / 100,
      budget: Math.round(this.budget * 10) / 10,
      budgetRate: Math.round(this.budgetRate * 100) / 100,
      alive: this.aliveCount,
      concurrencyLimit: this.concurrencyLimit,
      pressure: Math.round(this.pressure * 100) / 100,
      tier: this.tier,
    };
  }
}

const RAY_O = new Float32Array(3);
const RAY_D = new Float32Array(3);

/** 兵种的预算消耗（与 type.threat 对应，单独列出便于调平衡） */
const THREAT_COST = {
  grunt: 1,
  shieldman: 1.6,
  flyer: 1.4,
  heavy: 3.2,
  sniper: 2.4,
  swarm: 0.7,
  stalker: 1.4,
  blastSpider: 1.0,
};

export default Director;
