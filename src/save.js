// ==== save.js — 存档与远征元进度 ====
// 浏览器 localStorage 持久化：元进度（合金、远征点数、永久改件、统计）+ 当前局快照。

const META_KEY = 'ironfall.meta.v1';
const RUN_KEY = 'ironfall.run.v1';
const SETTINGS_KEY = 'ironfall.settings.v1';

/** 永久改件（用远征点数购买，跨局生效） */
export const PERKS = {
  servo_legs: {
    id: 'servo_legs', name: '伺服义肢', desc: '+6% 基础移动速度（永久）', cost: 3, maxStacks: 4,
    effect: (s) => ({ moveSpeedMul: 1 + 0.06 * s }),
  },
  plate_carrier: {
    id: 'plate_carrier', name: '复合装甲板', desc: '+15 最大生命（永久）', cost: 3, maxStacks: 5,
    effect: (s) => ({ maxHealthAdd: 15 * s }),
  },
  cell_bank: {
    id: 'cell_bank', name: '电容阵列', desc: '+12 最大护盾（永久）', cost: 4, maxStacks: 5,
    effect: (s) => ({ maxShieldAdd: 12 * s }),
  },
  scavenger: {
    id: 'scavenger', name: '拾荒者协议', desc: '+12% 合金获取（永久）', cost: 3, maxStacks: 5,
    effect: (s) => ({ alloyMul: 1 + 0.12 * s }),
  },
  dash_module: {
    id: 'dash_module', name: '冲刺电容模组', desc: '空中冲刺次数 +1（永久）', cost: 6, maxStacks: 2,
    effect: (s) => ({ dashChargesAdd: s }),
  },
  grapple_spool: {
    id: 'grapple_spool', name: '加长绞盘', desc: '+20% 抓钩射程（永久）', cost: 4, maxStacks: 3,
    effect: (s) => ({ grappleRangeMul: 1 + 0.20 * s }),
  },
  fire_control: {
    id: 'fire_control', name: '火控芯片', desc: '+5% 武器伤害（永久）', cost: 5, maxStacks: 5,
    effect: (s) => ({ damageMul: 1 + 0.05 * s }),
  },
  trauma_kit: {
    id: 'trauma_kit', name: '战地医疗包', desc: '击杀回复 4 点生命（永久）', cost: 4, maxStacks: 4,
    effect: (s) => ({ lifestealOnKillAdd: 4 * s }),
  },
  extract_beacon: {
    id: 'extract_beacon', name: '撤离信标强化', desc: '撤离读条时间 -20%（永久）', cost: 5, maxStacks: 3,
    effect: (s) => ({ extractTimeMul: Math.pow(0.8, s) }),
  },
  luck_chip: {
    id: 'luck_chip', name: '幸运算法', desc: '改件稀有度提升（永久）', cost: 6, maxStacks: 3,
    effect: (s) => ({ luckAdd: s * 0.6 }),
  },
};

function defaultMeta() {
  return {
    alloy: 0,
    points: 0,
    perks: {},
    stats: {
      runs: 0, extractions: 0, deaths: 0, kills: 0, headshots: 0,
      bestTier: 0, bestTime: 0, bestKills: 0, bestScore: 0, totalAlloy: 0,
    },
    unlocked: { tiers: 3 },
    settings: null,
    version: 1,
  };
}

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    // 隐私模式下 localStorage 存在但写入会抛异常
    const t = '__ironfall_probe__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch (_e) {
    return null;
  }
}

export const Save = {
  metaKey: META_KEY,
  runKey: RUN_KEY,
  settingsKey: SETTINGS_KEY,

  available() { return safeStorage() !== null; },

  load() {
    const st = safeStorage();
    if (!st) return defaultMeta();
    try {
      const raw = st.getItem(META_KEY);
      if (!raw) return defaultMeta();
      const parsed = JSON.parse(raw);
      const base = defaultMeta();
      // 逐字段合并，容忍旧版本缺字段
      return {
        ...base,
        ...parsed,
        stats: { ...base.stats, ...(parsed.stats || {}) },
        unlocked: { ...base.unlocked, ...(parsed.unlocked || {}) },
        perks: { ...(parsed.perks || {}) },
      };
    } catch (_e) {
      return defaultMeta();
    }
  },

  save(state) {
    const st = safeStorage();
    if (!st) return false;
    try {
      st.setItem(META_KEY, JSON.stringify(state));
      return true;
    } catch (_e) {
      return false;
    }
  },

  reset() {
    const st = safeStorage();
    if (!st) return;
    try {
      st.removeItem(META_KEY);
      st.removeItem(RUN_KEY);
    } catch (_e) { /* 忽略 */ }
  },

  loadSettings() {
    const st = safeStorage();
    if (!st) return null;
    try {
      const raw = st.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) { return null; }
  },

  saveSettings(settings) {
    const st = safeStorage();
    if (!st) return false;
    try {
      st.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return true;
    } catch (_e) { return false; }
  },

  clearRun() {
    const st = safeStorage();
    if (!st) return;
    try { st.removeItem(RUN_KEY); } catch (_e) { /* 忽略 */ }
  },
};

/** 元进度对象（带购买逻辑与统计聚合） */
export class MetaProgress {
  constructor(data) {
    const d = data || Save.load();
    this.alloy = d.alloy || 0;
    this.points = d.points || 0;
    this.perks = { ...(d.perks || {}) };
    this.stats = {
      runs: 0, extractions: 0, deaths: 0, kills: 0, headshots: 0,
      bestTier: 0, bestTime: 0, bestKills: 0, bestScore: 0, totalAlloy: 0,
      ...(d.stats || {}),
    };
    this.unlocked = { tiers: 3, ...(d.unlocked || {}) };
    this._dirty = false;
  }

  addAlloy(n) {
    const v = Math.max(0, Math.round(n));
    this.alloy += v;
    this.stats.totalAlloy += v;
    this._dirty = true;
    return v;
  }

  spendAlloy(n) {
    if (n > this.alloy) return false;
    this.alloy -= n;
    this._dirty = true;
    return true;
  }

  addPoints(n) {
    const v = Math.max(0, Math.round(n));
    this.points += v;
    this._dirty = true;
    return v;
  }

  canBuy(perkId) {
    const p = PERKS[perkId];
    if (!p) return false;
    const owned = this.perks[perkId] || 0;
    if (owned >= p.maxStacks) return false;
    const cost = this.perkCost(perkId);
    return this.points >= cost;
  }

  /** 价格随已购买层数递增 */
  perkCost(perkId) {
    const p = PERKS[perkId];
    if (!p) return Infinity;
    const owned = this.perks[perkId] || 0;
    return Math.round(p.cost * Math.pow(1.6, owned));
  }

  buy(perkId) {
    if (!this.canBuy(perkId)) return false;
    const cost = this.perkCost(perkId);
    this.points -= cost;
    this.perks[perkId] = (this.perks[perkId] || 0) + 1;
    this._dirty = true;
    return true;
  }

  /** 汇总永久加成，结构与 modifiers 对齐（供 main.js 叠加） */
  perkModifiers() {
    const out = {
      move: {
        walkSpeedMul: 1, maxSpeedMul: 1, maxHealthAdd: 0, maxShieldAdd: 0,
        dashChargesAdd: 0, grappleRangeMul: 1, lifestealOnKillAdd: 0,
      },
      weapon: { damageMul: 1 },
      meta: { alloyMul: 1, luckAdd: 0, extractTimeMul: 1 },
    };
    for (const id of Object.keys(this.perks)) {
      const p = PERKS[id];
      if (!p) continue;
      const e = p.effect(this.perks[id]) || {};
      for (const group of Object.keys(e)) {
        for (const k of Object.keys(e[group])) {
          const v = e[group][k];
          // 乘算键相乘，加算键相加
          if (typeof v !== 'number') continue;
          if (out[group][k] == null) out[group][k] = v;
          else if (k.endsWith('Mul')) out[group][k] *= v;
          else out[group][k] += v;
        }
      }
    }
    // walkSpeedMul 也作用于冲刺
    out.move.sprintSpeedMul = out.move.walkSpeedMul;
    return out;
  }

  recordRun(result) {
    this.stats.runs++;
    if (result.extracted) this.stats.extractions++;
    else this.stats.deaths++;
    this.stats.kills += result.kills || 0;
    this.stats.headshots += result.headshots || 0;
    if ((result.tier || 0) > this.stats.bestTier) this.stats.bestTier = result.tier;
    if ((result.time || 0) > this.stats.bestTime) this.stats.bestTime = result.time;
    if ((result.kills || 0) > this.stats.bestKills) this.stats.bestKills = result.kills;
    if ((result.score || 0) > this.stats.bestScore) this.stats.bestScore = result.score;
    // 撤离成功才给远征点数与合金入库
    let earnedPoints = 0;
    if (result.extracted) {
      earnedPoints = 1 + Math.max(0, (result.tier || 1) - 1);
      this.addPoints(earnedPoints);
      this.alloy += Math.round((result.alloy || 0) * 0.5);
      // 解锁下一层
      const nextTier = (result.tier || 1) + 1;
      if (nextTier > this.unlocked.tiers) this.unlocked.tiers = nextTier;
    } else {
      // 阵亡：保留少量合金
      this.alloy += Math.round((result.alloy || 0) * 0.15);
    }
    this._dirty = true;
    this.persist();
    return earnedPoints;
  }

  persist() {
    Save.save(this.toJSON());
    this._dirty = false;
  }

  toJSON() {
    return {
      alloy: this.alloy,
      points: this.points,
      perks: { ...this.perks },
      stats: { ...this.stats },
      unlocked: { ...this.unlocked },
      version: 1,
    };
  }

  fromJSON(o) {
    const m = new MetaProgress(o);
    this.alloy = m.alloy;
    this.points = m.points;
    this.perks = m.perks;
    this.stats = m.stats;
    this.unlocked = m.unlocked;
    return this;
  }

  reset() {
    const d = defaultMeta();
    this.alloy = d.alloy;
    this.points = d.points;
    this.perks = {};
    this.stats = d.stats;
    this.unlocked = d.unlocked;
    Save.reset();
  }

  debugState() {
    return {
      alloy: this.alloy,
      points: this.points,
      perks: { ...this.perks },
      stats: { ...this.stats },
      maxTier: this.unlocked.tiers,
    };
  }
}

export default { Save, MetaProgress, PERKS };
