// ==== run.js — 单局状态：目标推进 / 撤离 / 经济 / 统计 ====
// 一局（"远征"）的完整生命周期：
//   deploy → 清目标 → 压力上升 → 撤离点激活 → 滞留读条 → extracted/dead
// 目标类型：destroy（破坏）、hold（占领）、collect（回收）、survive（坚守）

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';

export const RUN_PHASE = {
  IDLE: 'idle',
  DEPLOY: 'deploy',
  OBJECTIVES: 'objectives',
  EXTRACT_READY: 'extract_ready',
  EXTRACTING: 'extracting',
  EXTRACTED: 'extracted',
  DEAD: 'dead',
};

const OBJECTIVE_VERBS = {
  destroy: '摧毁',
  hold: '占领',
  collect: '回收',
  survive: '坚守',
};

export class Run {
  constructor(world, player, enemies, opts = {}) {
    this.world = world;
    this.player = player;
    this.enemies = enemies;
    this.opts = opts;
    this.rng = M.mulberry32(1);

    this.phase = RUN_PHASE.IDLE;
    this.tier = 1;
    this.runId = 0;
    this.elapsed = 0;
    this.timeScale = 1;

    this.objectives = [];
    this.extractPoints = [];
    this.activeExtract = null;
    this.extractHold = 0;
    this.extractRequired = CFG.gameplay.extractHoldTime;

    this.alloy = 0;
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.heat = 0;

    this.stats = {
      kills: 0, headshots: 0, damageDealt: 0, damageTaken: 0,
      objectives: 0, time: 0, tier: 1, alloy: 0, deaths: 0, bestCombo: 0,
    };

    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = 4.0;
    this.comboMax = 0;

    this.message = '';
    this.pendingUpgradeOffer = false;
    this.supplyStations = [];
    this.nearSupplyStation = null;
    this.nearObjective = null;

    this._wireEvents();
  }

  _wireEvents() {
    this._offKill = Events.on('enemy:die', (p) => {
      if (this.phase !== RUN_PHASE.OBJECTIVES && this.phase !== RUN_PHASE.EXTRACT_READY
        && this.phase !== RUN_PHASE.EXTRACTING) return;
      this.kills++;
      this.stats.kills++;
      if (p.headshot) { this.headshots++; this.stats.headshots++; }
      this.addScore(p.enemy.type.score * (p.headshot ? 1.5 : 1));
      this.combo++;
      this.comboTimer = this.comboWindow;
      if (this.combo > this.comboMax) this.comboMax = this.combo;
      if (this.combo > this.stats.bestCombo) this.stats.bestCombo = this.combo;
      this.heat = M.clamp01(this.heat + CFG.gameplay.heatPerKill * (p.enemy.type.threat || 1));
      const alloy = Math.round((p.enemy.type.alloy || 1) * (this.mods ? (this.mods.meta.alloyFindMul || 1) : 1));
      this.addAlloy(alloy);
      Events.emit('audio:play', { name: 'pickup_alloy', gain: 0.4 });
    });

    this._offHurt = Events.on('player:hurt', (p) => {
      this.damageTaken += p.amount;
      this.stats.damageTaken += p.amount;
      this.heat = Math.max(0, this.heat - 0.02);
    });

    this._offHit = Events.on('hit:enemy', (p) => {
      this.damageDealt += p.damage;
      this.stats.damageDealt += p.damage;
    });

    this._offDie = Events.on('player:die', () => {
      this.stats.deaths++;
      this.end(false);
    });
  }

  dispose() {
    if (this._offKill) this._offKill();
    if (this._offHurt) this._offHurt();
    if (this._offHit) this._offHit();
    if (this._offDie) this._offDie();
  }

  setModifiers(mods) {
    this.mods = mods;
    const mul = mods && mods.meta && Number.isFinite(mods.meta.extractTimeMul)
      ? mods.meta.extractTimeMul : 1;
    this.extractRequired = Math.max(1.5, CFG.gameplay.extractHoldTime * mul);
  }

  // ---------------------------------------------------------------- 开局

  start(tier, mapIndex) {
    this.tier = Math.max(1, tier | 0);
    this.runId++;
    this.elapsed = 0;
    this.phase = RUN_PHASE.DEPLOY;
    this.alloy = 0;
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    // 每次开局重新应用永久撤离信标强化，避免上一局的读条进度/时长泄漏。
    this.setModifiers(this.mods || null);
    this.heat = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboMax = 0;
    this.extractHold = 0;
    this.activeExtract = null;
    this.stats = {
      kills: 0, headshots: 0, damageDealt: 0, damageTaken: 0,
      objectives: 0, time: 0, tier: this.tier, alloy: 0, deaths: 0, bestCombo: 0,
    };

    // 从世界取目标与撤离点
    this.objectives = (this.world.objectives() || []).map((o) => ({
      ...o,
      done: false,
      progress: 0,
      hp: o.hp || 100,
    }));
    this.extractPoints = this.world.extractPoints() || [];
    this.supplyStations = (this.world.supplyStations() || []).map((s) => ({ ...s, used: false }));

    Events.emit('run:start', { runId: this.runId, tier: this.tier });
    if (this.objectives.length === 0) {
      // 没有目标就直接开撤离
      this.phase = RUN_PHASE.EXTRACT_READY;
      this._activateExtracts();
    } else {
      this.phase = RUN_PHASE.OBJECTIVES;
      this._emitObjectiveProgress();
    }
    void mapIndex;
    return this;
  }

  end(extracted) {
    if (this.phase === RUN_PHASE.EXTRACTED || this.phase === RUN_PHASE.DEAD) return;
    this.phase = extracted ? RUN_PHASE.EXTRACTED : RUN_PHASE.DEAD;
    this.stats.time = this.elapsed;
    this.stats.alloy = this.alloy;
    Events.emit('run:end', { extracted, stats: { ...this.stats } });
  }

  // ---------------------------------------------------------------- 更新

  update(dt, player) {
    const p = player || this.player;
    if (this.phase === RUN_PHASE.IDLE || this.phase === RUN_PHASE.EXTRACTED || this.phase === RUN_PHASE.DEAD) {
      return;
    }
    const scaled = dt * this.timeScale;
    this.elapsed += scaled;
    this.stats.time = this.elapsed;

    // 连杀衰减
    if (this.comboTimer > 0) {
      this.comboTimer -= scaled;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    // 热度衰减
    this.heat = Math.max(0, this.heat - CFG.gameplay.heatDecay * scaled);

    if (this.phase === RUN_PHASE.DEPLOY) {
      // 落地即开始
      if (p.state.grounded || this.elapsed > 2.5) this.phase = RUN_PHASE.OBJECTIVES;
      return;
    }

    // 目标交互
    this._updateObjectives(scaled, p);

    // 补给站
    this._updateSupplyStations(scaled, p);

    // 撤离
    this._updateExtraction(scaled, p);
  }

  _updateObjectives(dt, p) {
    if (this.phase !== RUN_PHASE.OBJECTIVES && this.phase !== RUN_PHASE.EXTRACT_READY) return;
    this.nearObjective = null;
    let remaining = 0;
    for (const o of this.objectives) {
      if (o.done) continue;
      remaining++;
      const d = M.dist3(p.pos, o.pos);
      if (d > o.radius + 4) continue;
      this.nearObjective = o;
      if (!o.done) {
        p._interactProgress = (p._interactProgress || 0);
        // destroy 必须用武器打坏实体；其余任务必须按住交互执行夺取/破坏/回收，
        // 不再只是走进圆圈站着等待读条。
        if (p.state.grounded && o.type !== 'destroy' && this.objectiveInteractDown) {
          const rate = 1 / Math.max(2.0, 6.5 - this.tier * 0.35);
          o.progress = M.clamp01(o.progress + dt * rate);
          if (o.progress >= 1) {
            this._completeObjective(o);
          }
        }
      }
    }
    if (remaining === 0 && !this.bossPending && this.phase === RUN_PHASE.OBJECTIVES) {
      if (this.tier === 10) { this.end(true); return; }
      this.phase = RUN_PHASE.EXTRACT_READY;
      this._activateExtracts();
      Events.emit('ui:message', {
        title: '全部目标已摧毁', sub: '撤离航道已开启 —— 前往撤离点', kind: 'good',
      });
      Events.emit('audio:play', { name: 'objective_complete' });
    }
  }

  _completeObjective(o) {
    if (o.done) return;
    o.done = true;
    o.progress = 1;
    const worldObjective = this.world && typeof this.world.objectives === 'function'
      ? this.world.objectives().find((x) => x.id === o.id) : null;
    if (worldObjective) { worldObjective.done = true; worldObjective.progress = 1; }
    this.stats.objectives++;
    const alloy = Math.round(CFG.gameplay.objectiveAlloy * (1 + (this.tier - 1) * 0.35)
      * (this.mods ? (this.mods.meta.alloyFindMul || 1) : 1));
    this.addAlloy(alloy);
    this.addScore(CFG.gameplay.scorePerObjective);
    // 完成目标给一次升级机会
    this.pendingUpgradeOffer = true;
    Events.emit('objective:complete', { label: o.label, id: o.id });
    if (o.type === 'recover' || o.type === 'capture') {
      Events.emit('objective:loot', { id: o.id, type: o.type, itemId: 'intel_core' });
    }
    Events.emit('audio:play', { name: 'objective_complete' });
    Events.emit('ui:message', {
      title: '目标完成', sub: `${o.label} —— 获得 ${alloy} 合金与一次改件选择`, kind: 'good',
    });
    this._emitObjectiveProgress();
  }

  /** 玩家手动上报目标进度（例如用武器打爆目标物） */
  damageObjective(id, amount) {
    const o = this.objectives.find((x) => x.id === id);
    if (!o || o.done) return;
    o.hp -= amount;
    o.progress = M.clamp01(1 - o.hp / 100);
    if (o.hp <= 0) this._completeObjective(o);
    else this._emitObjectiveProgress();
  }

  /** 世界命中点附近的 destroy 目标会真实承受枪械伤害。 */
  damageObjectiveAt(point, amount) {
    if (!point) return false;
    let best = null, bestD = Infinity;
    for (const o of this.objectives) {
      if (o.done || o.type !== 'destroy') continue;
      const d = M.dist3(point, o.pos);
      if (d <= Math.max(2.2, Math.min(4, o.radius || 3)) && d < bestD) { best = o; bestD = d; }
    }
    if (!best) return false;
    this.damageObjective(best.id, Math.max(1, +amount || 1));
    return true;
  }

  _emitObjectiveProgress() {
    const total = this.objectives.length;
    const done = this.objectives.filter((o) => o.done).length;
    const next = this.objectives.find((o) => !o.done);
    Events.emit('objective:progress', {
      done, total, label: next ? next.label : '前往撤离点',
    });
  }

  objectiveProgress() {
    const total = this.objectives.length || 1;
    const done = this.objectives.filter((o) => o.done).length;
    return { done, total, label: this.currentObjectiveLabel() };
  }

  currentObjectiveLabel() {
    if (this.phase === RUN_PHASE.EXTRACT_READY || this.phase === RUN_PHASE.EXTRACTING) {
      return '撤离至指定航道';
    }
    const next = this.objectives.find((o) => !o.done);
    return next ? next.label : '目标已全部完成';
  }

  currentObjectivePoint() {
    const next = this.objectives.find((o) => !o.done);
    return next ? next.pos : (this.activeExtract ? this.activeExtract.pos : null);
  }

  _activateExtracts() {
    this.extractPoints = (this.world.extractPoints() || []).map((e) => ({ ...e, active: true }));
    // 选离玩家最近的一个作为当前撤离点（其余保留用于 HUD 指向）
    const p = this.player;
    let best = null, bestD = Infinity;
    for (const e of this.extractPoints) {
      const d = M.dist3(p.pos, e.pos);
      if (d < bestD) { bestD = d; best = e; }
    }
    this.activeExtract = best || (this.extractPoints[0] || null);
    if (this.activeExtract) {
      Events.emit('ui:message', {
        title: '撤离点已标记', sub: '在全息信标范围内滞留以完成撤离', kind: 'info',
      });
    }
  }

  _updateExtraction(dt, p) {
    if (this.phase !== RUN_PHASE.EXTRACT_READY && this.phase !== RUN_PHASE.EXTRACTING) return;
    if (!this.activeExtract) return;
    const d = M.dist3(p.pos, this.activeExtract.pos);
    const inZone = d <= this.activeExtract.radius;
    if (inZone && p.alive) {
      if (this.phase === RUN_PHASE.EXTRACT_READY) {
        this.phase = RUN_PHASE.EXTRACTING;
        Events.emit('audio:play', { name: 'extract_countdown' });
        Events.emit('ui:message', { title: '撤离中', sub: '保持站位 —— 敌方正在逼近', kind: 'warn' });
      }
      // 被击中会打断读条（压力来源）
      const disturbed = p.state.speed > 0.5 ? 0.55 : 1.0;
      this.extractHold += dt * disturbed;
      if (this.extractHold >= this.extractRequired) {
        this.end(true);
      }
    } else {
      if (this.phase === RUN_PHASE.EXTRACTING) {
        this.phase = RUN_PHASE.EXTRACT_READY;
        Events.emit('ui:message', { title: '撤离中断', sub: '离开信标范围', kind: 'warn' });
      }
      this.extractHold = Math.max(0, this.extractHold - dt * 0.55);
    }
  }

  get extractProgress() {
    return M.clamp01(this.extractHold / Math.max(0.01, this.extractRequired));
  }

  extractTimeLeft() {
    if (this.phase !== RUN_PHASE.EXTRACTING && this.phase !== RUN_PHASE.EXTRACT_READY) return null;
    if (!this.activeExtract || this.extractHold <= 0) return null;
    return Math.max(0, this.extractRequired - this.extractHold);
  }

  _updateSupplyStations(dt, p) {
    this.nearSupplyStation = null;
    for (const s of this.supplyStations) {
      if (s.used) continue;
      if (M.dist3(p.pos, s.pos) <= s.radius) { this.nearSupplyStation = s; break; }
    }
    void dt; void p;
  }

  // ---------------------------------------------------------------- 经济

  addAlloy(n) {
    const v = Math.max(0, Math.round(n));
    this.alloy += v;
    return v;
  }

  spendAlloy(n) {
    if (n > this.alloy) return false;
    this.alloy -= n;
    return true;
  }

  addScore(n) {
    const mul = this.mods ? (this.mods.meta.scoreMul || 1) : 1;
    this.score += Math.round(n * mul * (1 + this.heat * 0.5) * (1 + this.combo * 0.06));
  }

  get comboDamageMul() {
    return 1 + Math.min(10, this.combo) * 0.04;
  }

  debugState() {
    return {
      phase: this.phase,
      tier: this.tier,
      elapsed: Math.round(this.elapsed * 10) / 10,
      alloy: this.alloy,
      score: Math.round(this.score),
      kills: this.kills,
      headshots: this.headshots,
      combo: this.combo,
      comboMax: this.comboMax,
      heat: Math.round(this.heat * 100) / 100,
      objectivesDone: this.objectives.filter((o) => o.done).length,
      objectivesTotal: this.objectives.length,
      objectiveLabel: this.currentObjectiveLabel(),
      extractProgress: Math.round(this.extractProgress * 100) / 100,
      damageDealt: Math.round(this.damageDealt),
      damageTaken: Math.round(this.damageTaken),
    };
  }
}

export { OBJECTIVE_VERBS };
export default Run;
