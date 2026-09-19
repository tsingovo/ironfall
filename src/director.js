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
    this.run.bossPending = [3, 6, 10].includes(this.tier);
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
    const bossFloor = [3, 6, 10].includes(this.tier);
    const total = Object.values(base).reduce((a,b)=>a+b,0);
    // Boss 关两种新怪合计约 90% 权重；普通关合计约 29%，受原并发/预算保护。
    return {...base, stalker: total * (bossFloor ? 4.5 : 0.2), blastSpider: total * (bossFloor ? 4.5 : 0.2)};
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
        const pos = this._findSpawnPoint('broodStalker', true);
        if (pos) {
          this._boss = this.enemies.spawn('broodStalker', pos, { elite: true, scale: 1.6 });
          this._bossId = this._boss.id;
          this._boss.maxHp = Math.round(this._boss.maxHp * (5 + this.tier) * (1 + Math.max(0, this.tier - 3) * 0.15));
          this._boss.hp = this._boss.maxHp;
          this._boss.shield = this._boss.maxShield *= 3;
          Events.emit('audio:play', { name: 'boss_arrive' });
          Events.emit('ui:message', { title: '守关首领：绿影蛛皇', sub: '击败首领才能完成本层目标', kind: 'warn' });
        }
      } else if (!this._boss.alive || this._boss.id !== this._bossId) {
        this.run.bossPending = false;
        Events.emit('audio:play', { name: 'boss_defeat' });
        Events.emit('ui:message', { title: '首领已击败', sub: '完成剩余目标，结束本层远征', kind: 'good' });
      } else {
        this._updateBossSummons(dt);
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
  _samplePointInRing(minD, maxD, frontBias, typeId) {
    const p = this.player;
    const w = this.world;
    const cands = w.navCandidates();
    if (!cands.length) return null;
    const out = this._spawnScratch;
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

      // 找离目标点最近的可站点
      let nearest = null;
      let nd = Infinity;
      for (let i = 0; i < cands.length; i += 3) {
        const c = cands[i];
        const d2 = (c[0] - tx) * (c[0] - tx) + (c[2] - tz) * (c[2] - tz);
        if (d2 < nd) { nd = d2; nearest = c; }
      }
      if (!nearest) continue;
      nd = Math.sqrt(nd);
      const actual = Math.hypot(nearest[0] - p.pos[0], nearest[2] - p.pos[2]);
      if (actual < minD || actual > maxD * 1.35) continue;
      if (this._tooCloseToEnemy(nearest, 2.0)) continue;
      if (!this._isSafeSpawnPoint(typeId, nearest, minD)) continue;
      // 离目标点越近越好；距离接近目标距离的加分
      // 可见位置不是绝对禁用（开放地图仍需刷怪），但会被明显降权。
      const score = nd + Math.abs(actual - dist) * 0.5
        + (this._visibleFromPlayer(nearest, typeId) ? 24 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = nearest;
      }
    }

    if (!best) return null;
    out[0] = best[0]; out[1] = best[1]; out[2] = best[2];
    w.snapToGround(out, 0.15);
    return out;
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
