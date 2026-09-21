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
      if (p.byPlayer === false) return; // 自爆不伪装为玩家击杀/刷奖励
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

    this._offDie = Events.on('player:die', (event = {}) => {
      if (!event.pvp) this.stats.deaths++;
      // Individual network deaths never settle or reset the shared expedition.
      if (this.opts.isMultiplayer?.()) return;
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
    this.bossExtraction = this.objectives.length === 0;
    this.bossPending = this.bossExtraction;
    this.supplyStations = (this.world.supplyStations() || []).map((s) => ({ ...s, used: false }));

    Events.emit('run:start', { runId: this.runId, tier: this.tier });
    if (this.objectives.length === 0 && !this.bossPending) {
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

  /**
   * 任务进度推进。
   *
   * 联机下的权威规则（重要）：
   *   · **只有房主计算进度**。客机完全依赖房主广播的权威值（见 net/session.js
   *     的 _applyRunState），自己不再累加 —— 否则两端各算各的必然分歧。
   *   · 房主把"所有正在交互的玩家"都算进来（本机玩家 + 各房客的远程代理），
   *     所以队友按住 E 同样能推进，而不是只有房主一个人能推。
   *     这是"队友无法做任务 / 任务进度不共享"的根因。
   *
   * `this.objectiveInteractors` 由 main.js 每个物理步刷新。
   */
  _updateObjectives(dt, p) {
    if (this.phase !== RUN_PHASE.OBJECTIVES && this.phase !== RUN_PHASE.EXTRACT_READY) return;
    this.nearObjective = null;
    let remaining = 0;

    // 参与推进的玩家：未注入时退化为"只有本机玩家"（单机行为不变）
    const actors = Array.isArray(this.objectiveInteractors) && this.objectiveInteractors.length
      ? this.objectiveInteractors : (p ? [p] : []);
    const authoritative = this.authoritativeObjectives !== false;

    // 先清上一帧的"谁在交互"，再按本帧重新标记
    for (const o of this.objectives) o.interactBy = null;

    for (const o of this.objectives) {
      if (o.done) continue;
      remaining++;

      for (const actor of actors) {
        if (!actor || !actor.pos || actor.alive === false) continue;
        const d = M.dist3(actor.pos, o.pos);
        if (d > o.radius + 4) continue;

        // 提示用的"最近任务"以本机玩家为准
        if (actor === p) this.nearObjective = o;

        // 客机不本地推进（权威值来自房主），但仍记录 interactBy 供 HUD 显示
        if (!authoritative) {
          if (actor.interacting && o.type !== 'destroy') o.interactBy = actor === p ? 'self' : (actor.netId || 'ally');
          continue;
        }

        // destroy 必须用武器打坏实体；其余任务必须按住交互执行夺取/破坏/回收，
        // 不再只是走进圆圈站着等待读条。
        //
        // 交互判定兼容两种入口：
        //   · actor.interacting —— 由 main.js 的 _objectiveInteractors() 每步写入，
        //     联机时各房客的远程代理也带这个字段
        //   · this.objectiveInteractDown —— 旧的单一开关（只代表本机玩家），
        //     保留它是为了不破坏既有自测与外部调用
        const interacting = !!actor.interacting
          || (actor === p && !!this.objectiveInteractDown);
        if (interacting && actor.state && actor.state.grounded && o.type !== 'destroy') {
          const rate = 1 / Math.max(2.0, 6.5 - this.tier * 0.35);
          o.progress = M.clamp01(o.progress + dt * rate);
          if (!o.interactBy) o.interactBy = actor === p ? 'self' : (actor.netId || 'ally');
          if (o.progress >= 1) {
            this._completeObjective(o);
            break;                         // 该目标已完成，不必再让其他人累加
          }
        }
      }
    }
    if (authoritative && remaining === 0 && !this.bossPending && this.phase === RUN_PHASE.OBJECTIVES) {
      this.phase = RUN_PHASE.EXTRACT_READY;
      this._activateExtracts();
      Events.emit('ui:message', {
        title: '撤离航道已开启', sub: '到达任意撤离点即可通关', kind: 'good',
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
    if (this.bossExtraction) return this.bossPending ? '击败本层首领' : '前往任意撤离点';
    if (this.phase === RUN_PHASE.EXTRACT_READY || this.phase === RUN_PHASE.EXTRACTING) {
      return '撤离至指定航道';
    }
    const next = this.objectives.find((o) => !o.done);
    return next ? next.label : '目标已全部完成';
  }

  currentObjectivePoint() {
    if (this.bossExtraction) return null;
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
        title: '撤离点已标记', sub: this.bossExtraction ? '在任意绿色撤离信标内坚持 2 秒' : '在全息信标范围内滞留以完成撤离', kind: 'info',
      });
    }
  }

  _updateExtraction(dt, p) {
    if (this.phase !== RUN_PHASE.EXTRACT_READY && this.phase !== RUN_PHASE.EXTRACTING) return;
    if (!this.activeExtract) return;

    // 联机权威规则与任务进度一致：**只有房主推进撤离读条**，
    // 且任何一位站在信标范围内的玩家都能推进（队友也能拉撤离）。
    // 客机只用房主广播的 extractHold 显示，不自己累加，避免两端分歧。
    if (this.authoritativeObjectives === false) return;

    const actors = Array.isArray(this.objectiveInteractors) && this.objectiveInteractors.length
      ? this.objectiveInteractors : (p ? [p] : []);

    if (this.bossExtraction) {
      if (this.bossPending) return;
      const reached = this.extractPoints.find(point => point.active && actors.some(actor =>
        actor?.alive !== false && actor?.pos && M.dist3(actor.pos, point.pos) <= point.radius));
      const required = 2.0;
      if (reached) {
        this.activeExtract = reached;
        if (this.phase === RUN_PHASE.EXTRACT_READY) {
          this.phase = RUN_PHASE.EXTRACTING;
          Events.emit('audio:play', { name: 'extract_countdown' });
          Events.emit('ui:message', { title: '撤离校验中', sub: '在信标内坚持 2 秒', kind: 'warn' });
        }
        this.extractHold += dt;
        if (this.extractHold >= required) { this.extractHold = required; this.end(true); }
      } else {
        if (this.phase === RUN_PHASE.EXTRACTING) {
          this.phase = RUN_PHASE.EXTRACT_READY;
          Events.emit('ui:message', { title: '撤离中断', sub: '返回任意绿色撤离信标', kind: 'warn' });
        }
        this.extractHold = 0;
      }
      return;
    }

    let anyoneInZone = false;
    let disturbed = 0;
    for (const actor of actors) {
      if (!actor || !actor.pos || actor.alive === false) continue;
      const d = M.dist3(actor.pos, this.activeExtract.pos);
      if (d > this.activeExtract.radius) continue;
      anyoneInZone = true;
      // 被击中会打断读条（压力来源）；统计最慢的那位
      const speed = (actor.state && Number.isFinite(actor.state.speed)) ? actor.state.speed : 0;
      disturbed = Math.max(disturbed, speed > 0.5 ? 0.55 : 1.0);
      if (actor === p) this.nearExtract = true;
    }

    if (anyoneInZone) {
      if (this.phase === RUN_PHASE.EXTRACT_READY) {
        this.phase = RUN_PHASE.EXTRACTING;
        Events.emit('audio:play', { name: 'extract_countdown' });
        Events.emit('ui:message', { title: '撤离中', sub: '保持站位 —— 敌方正在逼近', kind: 'warn' });
      }
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
    const required = this.bossExtraction ? 2.0 : this.extractRequired;
    return M.clamp01(this.extractHold / Math.max(0.01, required));
  }

  extractTimeLeft() {
    if (this.phase !== RUN_PHASE.EXTRACTING && this.phase !== RUN_PHASE.EXTRACT_READY) return null;
    if (!this.activeExtract || this.extractHold <= 0) return null;
    return Math.max(0, (this.bossExtraction ? 2.0 : this.extractRequired) - this.extractHold);
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
