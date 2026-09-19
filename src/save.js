// ==== save.js — 存档与远征元进度 ====
// 浏览器 localStorage 持久化：元进度（合金、远征点数、永久改件、统计）+ 当前局快照。

const META_KEY = 'ironfall.meta.v1';
const RUN_KEY = 'ironfall.run.v1';
const SETTINGS_KEY = 'ironfall.settings.v1';
const META_VERSION = 2;
export const CAMPAIGN_TIER_COUNT = 10;

/** 永久改件（用远征点数购买，跨局生效） */
export const PERKS = {
  servo_legs: {
    id: 'servo_legs', name: '伺服义肢', desc: '+6% 基础移动速度（永久）', cost: 3, maxStacks: 4,
    effect: (s) => ({ move: { walkSpeedMul: 1 + 0.06 * s } }),
  },
  plate_carrier: {
    id: 'plate_carrier', name: '复合装甲板', desc: '+15 最大生命（永久）', cost: 3, maxStacks: 5,
    effect: (s) => ({ move: { maxHealthAdd: 15 * s } }),
  },
  cell_bank: {
    id: 'cell_bank', name: '电容阵列', desc: '+12 最大护盾（永久）', cost: 4, maxStacks: 5,
    effect: (s) => ({ move: { maxShieldAdd: 12 * s } }),
  },
  scavenger: {
    id: 'scavenger', name: '拾荒者协议', desc: '+12% 合金获取（永久）', cost: 3, maxStacks: 5,
    effect: (s) => ({ meta: { alloyFindMul: 1 + 0.12 * s } }),
  },
  dash_module: {
    id: 'dash_module', name: '冲刺电容模组', desc: '空中冲刺次数 +1（永久）', cost: 6, maxStacks: 2,
    effect: (s) => ({ move: { dashChargesAdd: s } }),
  },
  grapple_spool: {
    id: 'grapple_spool', name: '加长绞盘', desc: '+20% 抓钩射程（永久）', cost: 4, maxStacks: 3,
    effect: (s) => ({ move: { grappleRangeMul: 1 + 0.20 * s } }),
  },
  fire_control: {
    id: 'fire_control', name: '火控芯片', desc: '+5% 武器伤害（永久）', cost: 5, maxStacks: 5,
    effect: (s) => ({ weapon: { damageMul: 1 + 0.05 * s } }),
  },
  trauma_kit: {
    id: 'trauma_kit', name: '战地医疗包', desc: '击杀回复 4 点生命（永久）', cost: 4, maxStacks: 4,
    effect: (s) => ({ move: { lifestealOnKillAdd: 4 * s } }),
  },
  extract_beacon: {
    id: 'extract_beacon', name: '撤离信标强化', desc: '撤离读条时间 -20%（永久）', cost: 5, maxStacks: 3,
    effect: (s) => ({ meta: { extractTimeMul: Math.pow(0.8, s) } }),
  },
  luck_chip: {
    id: 'luck_chip', name: '幸运算法', desc: '改件稀有度提升（永久）', cost: 6, maxStacks: 3,
    effect: (s) => ({ meta: { luckAdd: s * 0.6 } }),
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
    unlocked: { tiers: 1, currentTier: 1 },
    stash: { items: {}, lastExtractedLoadout: {} },
    settings: null,
    version: META_VERSION,
  };
}

function clampTier(value) {
  const n = Number.isFinite(+value) ? Math.trunc(+value) : 1;
  return Math.max(1, Math.min(CAMPAIGN_TIER_COUNT, n));
}

function normalizeItems(items) {
  const out = {};
  const add = (id, count) => {
    if (typeof id !== 'string' || !id || !Number.isFinite(+count)) return;
    const n = Math.max(0, Math.trunc(+count));
    if (n) out[id] = (out[id] || 0) + n;
  };
  if (Array.isArray(items)) {
    for (const entry of items) if (entry) add(entry.itemId || entry.id, entry.count == null ? 1 : entry.count);
  } else if (items && typeof items === 'object') {
    for (const [id, count] of Object.entries(items)) add(id, count);
  }
  return out;
}

function normalizeLoadout(loadout) {
  const out = {};
  if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return out;
  for (const [weaponId, slots] of Object.entries(loadout)) {
    if (typeof weaponId !== 'string' || !slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const clean = {};
    for (const [slot, itemId] of Object.entries(slots)) {
      if (typeof slot === 'string' && typeof itemId === 'string' && itemId) clean[slot] = itemId;
    }
    if (Object.keys(clean).length) out[weaponId] = clean;
  }
  return out;
}

function loadoutItems(loadout) {
  const out = {};
  for (const slots of Object.values(loadout || {})) {
    for (const itemId of Object.values(slots || {})) out[itemId] = (out[itemId] || 0) + 1;
  }
  return out;
}

function normalizeStash(stash) {
  return {
    items: normalizeItems(stash && stash.items),
    lastExtractedLoadout: normalizeLoadout(stash && stash.lastExtractedLoadout),
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
      const unlockedTiers = clampTier(parsed && parsed.unlocked && parsed.unlocked.tiers);
      const requestedTier = parsed && parsed.unlocked && parsed.unlocked.currentTier;
      // 逐字段合并，容忍旧版本缺字段
      return {
        ...base,
        ...parsed,
        stats: { ...base.stats, ...(parsed.stats || {}) },
        unlocked: {
          tiers: unlockedTiers,
          currentTier: Math.min(unlockedTiers, clampTier(requestedTier || 1)),
        },
        perks: { ...(parsed.perks || {}) },
        stash: normalizeStash(parsed.stash),
        version: META_VERSION,
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
    const unlockedTiers = clampTier(d.unlocked && d.unlocked.tiers);
    this.unlocked = {
      tiers: unlockedTiers,
      currentTier: Math.min(unlockedTiers, clampTier(d.unlocked && d.unlocked.currentTier)),
    };
    this.stash = normalizeStash(d.stash);
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
      meta: { alloyFindMul: 1, luckAdd: 0, extractTimeMul: 1 },
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

  /** 当前可进入的战役关卡（1..10）。 */
  currentTier() { return this.unlocked.currentTier; }

  maxUnlockedTier() { return this.unlocked.tiers; }

  isTierUnlocked(tier) {
    const n = Math.trunc(+tier);
    return Number.isFinite(n) && n >= 1 && n <= this.unlocked.tiers && n <= CAMPAIGN_TIER_COUNT;
  }

  /** 解锁指定关卡；返回最终解锁上限。不会越过第 10 关。 */
  unlockTier(tier) {
    const next = clampTier(tier);
    if (next > this.unlocked.tiers) {
      this.unlocked.tiers = next;
      this._dirty = true;
    }
    return this.unlocked.tiers;
  }

  /** 选择已解锁关卡。锁定关卡不会悄悄改写当前选择。 */
  setCurrentTier(tier) {
    const next = Math.trunc(+tier);
    if (!this.isTierUnlocked(next)) return false;
    if (next !== this.unlocked.currentTier) {
      this.unlocked.currentTier = next;
      this._dirty = true;
    }
    return true;
  }

  /**
   * 成功完成一关后的战役推进，返回**新的当前关卡**。
   *
   * 第 10 关（CAMPAIGN_TIER_COUNT）之后循环回第 1 关：十层远征是闭环的，
   * 打通后重新开始，但已解锁的层数与元进度全部保留。
   * 之前的注释写成「第 10 关停留在第 10 关」，与实现不符，已更正。
   */
  advanceCampaign(completedTier = this.unlocked.currentTier) {
    const completed = clampTier(completedTier);
    const next = completed === CAMPAIGN_TIER_COUNT ? 1 : completed + 1;
    this.unlockTier(next);
    this.unlocked.currentTier = next;
    this._dirty = true;
    return next;
  }

  /** 仓库只保存有限物品；无限医疗补给应由调用方排除，Infinity 也会在此被拒绝。 */
  stashSnapshot() {
    return {
      items: { ...this.stash.items },
      lastExtractedLoadout: Object.fromEntries(Object.entries(this.stash.lastExtractedLoadout)
        .map(([weaponId, slots]) => [weaponId, { ...slots }])),
    };
  }

  /**
   * 把成功撤离的有限背包物品和已装配件存入局外仓库。
   * carry = { items: [{itemId,count}] | Record<string,number>, attachments: {weaponId:{slot:itemId}} }
   * 已装配件会作为实体物品入库，同时保留最近一次撤离的装配位置快照。
   */
  storeCarry(carry = {}) {
    const items = normalizeItems(carry.items);
    const loadout = normalizeLoadout(carry.attachments || carry.loadout);
    const equipped = loadoutItems(loadout);
    for (const [id, count] of Object.entries(items)) this.stash.items[id] = (this.stash.items[id] || 0) + count;
    for (const [id, count] of Object.entries(equipped)) this.stash.items[id] = (this.stash.items[id] || 0) + count;
    this.stash.lastExtractedLoadout = loadout;
    this._dirty = true;
    return { itemsStored: Object.values(items).reduce((a, b) => a + b, 0), attachmentsStored: Object.values(equipped).reduce((a, b) => a + b, 0) };
  }

  canConsumeCarry(carry = {}) {
    const need = normalizeItems(carry.items);
    const equipped = loadoutItems(normalizeLoadout(carry.attachments || carry.loadout));
    for (const [id, count] of Object.entries(equipped)) need[id] = (need[id] || 0) + count;
    return Object.entries(need).every(([id, count]) => (this.stash.items[id] || 0) >= count);
  }

  /** 原子消费：任一物品不足时不扣除任何内容。 */
  consumeCarry(carry = {}) {
    const items = normalizeItems(carry.items);
    const attachments = normalizeLoadout(carry.attachments || carry.loadout);
    const need = { ...items };
    for (const [id, count] of Object.entries(loadoutItems(attachments))) need[id] = (need[id] || 0) + count;
    if (!Object.entries(need).every(([id, count]) => (this.stash.items[id] || 0) >= count)) return null;
    for (const [id, count] of Object.entries(need)) {
      const remain = this.stash.items[id] - count;
      if (remain > 0) this.stash.items[id] = remain;
      else delete this.stash.items[id];
    }
    this._dirty = true;
    return { items, attachments };
  }

  clearStash() {
    this.stash = normalizeStash(null);
    this._dirty = true;
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
      this.advanceCampaign(result.tier || this.unlocked.currentTier);
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
      stash: this.stashSnapshot(),
      version: META_VERSION,
    };
  }

  fromJSON(o) {
    const m = new MetaProgress(o);
    this.alloy = m.alloy;
    this.points = m.points;
    this.perks = m.perks;
    this.stats = m.stats;
    this.unlocked = m.unlocked;
    this.stash = m.stash;
    return this;
  }

  reset() {
    const d = defaultMeta();
    this.alloy = d.alloy;
    this.points = d.points;
    this.perks = {};
    this.stats = d.stats;
    this.unlocked = d.unlocked;
    this.stash = d.stash;
    Save.reset();
  }

  debugState() {
    return {
      alloy: this.alloy,
      points: this.points,
      perks: { ...this.perks },
      stats: { ...this.stats },
      maxTier: this.unlocked.tiers,
      currentTier: this.unlocked.currentTier,
      stash: this.stashSnapshot(),
    };
  }
}

export default { Save, MetaProgress, PERKS, CAMPAIGN_TIER_COUNT };
