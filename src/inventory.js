// ==== inventory.js — 搜打撤式背包与世界掉落物 ====
// 设计目标：
//   * Tab 打开 6×4 背包；格子支持拖动换位、右键丢弃、拖出面板丢弃。
//   * 地面掉落物不是发光占位点：每种物品都有独立程序化模型与颜色轮廓。
//   * 世界掉落和背包状态由同一系统维护，避免“看得见但捡不到/丢了不生成”。

import * as M from './core/math.js';
import * as Events from './core/events.js';

export const BACKPACK_SIZE = 24;

export const LOOT_DEFS = {
  medkit: {
    id: 'medkit', name: '医疗包', category: '无限补给', rarity: 'common', stack: Infinity, infinite: true, healIndex: 0,
    desc: '3.0 秒读条后将生命恢复至 100%；期间移速降至 35%，切枪、开火、开镜或换弹会打断。',
    effect: '生命恢复至满值 · 无限次数', usage: '轻按 5 使用当前选中道具；长按 5 打开轮盘；背包内单击也可使用。',
    model: [
      { shape: 'box', pos: [0, 0.12, 0], size: [0.34, 0.22, 0.24], color: [0.82, 0.86, 0.88] },
      { shape: 'box', pos: [0, 0.245, 0], size: [0.16, 0.035, 0.10], color: [0.12, 0.16, 0.18] },
      { shape: 'box', pos: [0, 0.12, -0.13], size: [0.055, 0.15, 0.025], color: [0.92, 0.12, 0.10], emissive: 0.12 },
      { shape: 'box', pos: [0, 0.12, -0.145], size: [0.15, 0.055, 0.025], color: [0.92, 0.12, 0.10], emissive: 0.12 },
    ],
  },
  shield_battery: {
    id: 'shield_battery', name: '护盾电池', category: '无限补给', rarity: 'rare', stack: Infinity, infinite: true, healIndex: 1,
    desc: '2.5 秒读条后将护盾恢复至 100%；期间移速降至 35%，切枪、开火、开镜或换弹会打断。',
    effect: '护盾恢复至满值 · 无限次数', usage: '轻按 5 使用当前选中道具；长按 5 打开轮盘；背包内单击也可使用。',
    model: [
      { shape: 'cylinder', pos: [0, 0.18, 0], size: [0.16, 0.36, 0.16], color: [0.06, 0.24, 0.60] },
      { shape: 'cylinder', pos: [0, 0.36, 0], size: [0.19, 0.035, 0.19], color: [0.32, 0.90, 1.0], emissive: 0.65 },
      { shape: 'cylinder', pos: [0, 0.02, 0], size: [0.19, 0.035, 0.19], color: [0.10, 0.46, 0.78], emissive: 0.30 },
    ],
  },
  syringe: {
    id: 'syringe', name: '注射器', category: '无限补给', rarity: 'common', stack: Infinity, infinite: true, healIndex: 2,
    desc: '1.0 秒注射后恢复 25 点生命；读条结束才生效，期间移速降至 35%，切枪、开火、开镜或换弹会打断。',
    effect: '生命 +25 · 1.0 秒 · 无限次数', usage: '轻按 5 使用当前选中道具；长按 5 打开轮盘；背包内单击也可使用。',
    model: [
      { shape: 'cylinder', pos: [0, 0.15, 0], size: [0.065, 0.30, 0.065], color: [0.78, 0.88, 0.92] },
      { shape: 'cylinder', pos: [0, 0.31, 0], size: [0.095, 0.028, 0.095], color: [0.86, 0.16, 0.13], emissive: 0.18 },
      { shape: 'cylinder', pos: [0, -0.015, 0], size: [0.025, 0.075, 0.025], color: [0.72, 0.78, 0.82] },
      { shape: 'box', pos: [0, 0.35, 0], size: [0.18, 0.025, 0.055], color: [0.30, 0.34, 0.38] },
    ],
  },
  shield_cell: {
    id: 'shield_cell', name: '小型护盾电池', category: '无限补给', rarity: 'rare', stack: Infinity, infinite: true, healIndex: 3,
    desc: '1.0 秒接入后恢复 25 点护盾；读条结束才生效，期间移速降至 35%，切枪、开火、开镜或换弹会打断。',
    effect: '护盾 +25 · 1.0 秒 · 无限次数', usage: '轻按 5 使用当前选中道具；长按 5 打开轮盘；背包内单击也可使用。',
    model: [
      { shape: 'cylinder', pos: [0, 0.105, 0], size: [0.12, 0.21, 0.12], color: [0.07, 0.31, 0.68] },
      { shape: 'cylinder', pos: [0, 0.225, 0], size: [0.145, 0.030, 0.145], color: [0.34, 0.91, 1.0], emissive: 0.70 },
      { shape: 'box', pos: [0, 0.105, -0.07], size: [0.075, 0.085, 0.020], color: [0.48, 0.88, 1.0], emissive: 0.45 },
    ],
  },
  light_mag: {
    id: 'light_mag', name: '轻型扩容弹匣 II', category: '配件', rarity: 'rare', stack: 2, attachment: { slot: 'mag', rank: 2, magAdd: 5 },
    desc: '为 R-99 增加 5 发弹容量，基础弹匣由 24 发提升至 29 发。',
    effect: 'R-99 弹匣 +5', usage: '拖到 R-99 卡片或单击安装；把已装配件拖回空格或右键即可卸下。', equipSlot: 'mag', compatible: ['r99'],
    model: [
      { shape: 'box', pos: [0, 0.15, 0], size: [0.16, 0.30, 0.11], rot: [0.12, 0, 0], color: [0.72, 0.78, 0.84] },
      { shape: 'box', pos: [0, 0.31, -0.01], size: [0.19, 0.035, 0.14], color: [0.18, 0.22, 0.26] },
      { shape: 'box', pos: [0.085, 0.16, -0.06], size: [0.018, 0.22, 0.018], color: [0.35, 0.88, 1.0], emissive: 0.45 },
    ],
  },
  heavy_mag: {
    id: 'heavy_mag', name: '重型扩容弹匣 II', category: '配件', rarity: 'rare', stack: 2, attachment: { slot: 'mag', rank: 2, magAdd: 5 },
    desc: '为平行步枪增加 5 发弹容量，基础弹匣由 35 发提升至 40 发。',
    effect: '平行步枪弹匣 +5', usage: '拖到平行步枪卡片或单击安装；把已装配件拖回空格或右键即可卸下。', equipSlot: 'mag', compatible: ['flatline'],
    model: [
      { shape: 'box', pos: [0, 0.15, 0], size: [0.20, 0.30, 0.13], rot: [0.16, 0, 0], color: [0.34, 0.27, 0.20] },
      { shape: 'box', pos: [0, 0.31, -0.01], size: [0.23, 0.04, 0.16], color: [0.12, 0.10, 0.09] },
      { shape: 'box', pos: [-0.105, 0.16, -0.07], size: [0.018, 0.22, 0.018], color: [1.0, 0.56, 0.18], emissive: 0.35 },
    ],
  },
  sniper_cell: {
    id: 'sniper_cell', name: '狙击充能电芯 II', category: '配件', rarity: 'rare', stack: 3, attachment: { slot: 'charge', rank: 2, chargeTimeMul: 0.78 },
    desc: '改良哨兵供能回路，使按 B 后的整匣充能读条缩短 22%。',
    effect: '哨兵充能时间 ×0.78', usage: '拖到哨兵狙击步枪卡片或单击安装；可拖回背包卸下。', equipSlot: 'charge', compatible: ['sentinel'],
    model: [
      { shape: 'cylinder', pos: [0, 0.11, 0], size: [0.22, 0.22, 0.22], color: [0.025, 0.08, 0.22] },
      { shape: 'sphere', pos: [0, 0.12, 0], size: [0.12, 0.12, 0.12], color: [0.32, 0.72, 1.0], emissive: 0.8 },
      { shape: 'box', pos: [0, 0.23, 0], size: [0.08, 0.04, 0.18], color: [0.12, 0.30, 0.58] },
    ],
  },
  light_mag_1: {
    id: 'light_mag_1', name: '轻型扩容弹匣 I', category: '配件', rarity: 'common', stack: 2,
    desc: '一级轻型弹匣，为 R-99 增加 3 发弹容量，基础 24 发提升至 27 发。', effect: 'R-99 弹匣 +3',
    usage: '拖到 R-99 卡片安装；高级弹匣可替换它，卸下后回到背包。', equipSlot: 'mag', compatible: ['r99'],
    attachment: { slot: 'mag', rank: 1, magAdd: 3 },
    model: [{ shape: 'box', pos: [0, .15, 0], size: [.15, .28, .10], color: [.55, .60, .64] }],
  },
  light_mag_3: {
    id: 'light_mag_3', name: '轻型扩容弹匣 III', category: '配件', rarity: 'epic', stack: 2,
    desc: '三级轻型弹匣，为 R-99 增加 8 发弹容量，基础 24 发提升至 32 发。', effect: 'R-99 弹匣 +8',
    usage: '拖到 R-99 卡片安装；替换低级弹匣时旧配件会自动回到背包。', equipSlot: 'mag', compatible: ['r99'],
    attachment: { slot: 'mag', rank: 3, magAdd: 8 },
    model: [{ shape: 'box', pos: [0, .16, 0], size: [.18, .32, .12], color: [.50, .22, .78], emissive: .18 }],
  },
  heavy_mag_1: {
    id: 'heavy_mag_1', name: '重型扩容弹匣 I', category: '配件', rarity: 'common', stack: 2,
    desc: '一级重型弹匣，为平行步枪增加 3 发弹容量，基础 35 发提升至 38 发。', effect: '平行步枪弹匣 +3',
    usage: '拖到平行步枪卡片安装；高级弹匣可替换它，卸下后回到背包。', equipSlot: 'mag', compatible: ['flatline'],
    attachment: { slot: 'mag', rank: 1, magAdd: 3 }, model: [{ shape: 'box', pos: [0, .15, 0], size: [.18, .28, .12], color: [.42, .38, .32] }],
  },
  heavy_mag_3: {
    id: 'heavy_mag_3', name: '重型扩容弹匣 III', category: '配件', rarity: 'epic', stack: 2,
    desc: '三级重型弹匣，为平行步枪增加 8 发弹容量，基础 35 发提升至 43 发。', effect: '平行步枪弹匣 +8',
    usage: '拖到平行步枪卡片安装；替换低级弹匣时旧配件会自动回到背包。', equipSlot: 'mag', compatible: ['flatline'],
    attachment: { slot: 'mag', rank: 3, magAdd: 8 }, model: [{ shape: 'box', pos: [0, .16, 0], size: [.22, .32, .14], color: [.58, .25, .78], emissive: .16 }],
  },
  sniper_cell_1: {
    id: 'sniper_cell_1', name: '狙击充能电芯 I', category: '配件', rarity: 'common', stack: 3,
    desc: '一级供能电芯，使哨兵整匣充能读条缩短 12%，强化弹伤害规则保持不变。', effect: '哨兵充能时间 ×0.88',
    usage: '拖到哨兵卡片安装；高级电芯可替换它，卸下后回到背包。', equipSlot: 'charge', compatible: ['sentinel'],
    attachment: { slot: 'charge', rank: 1, chargeTimeMul: .88 }, model: [{ shape: 'sphere', pos: [0, .12, 0], size: [.18, .18, .18], color: [.32, .58, .72], emissive: .35 }],
  },
  sniper_cell_3: {
    id: 'sniper_cell_3', name: '狙击充能电芯 III', category: '配件', rarity: 'epic', stack: 3,
    desc: '三级供能电芯，使哨兵整匣充能读条缩短 32%，强化弹伤害规则保持不变。', effect: '哨兵充能时间 ×0.68',
    usage: '拖到哨兵卡片安装；替换低级电芯时旧配件会自动回到背包。', equipSlot: 'charge', compatible: ['sentinel'],
    attachment: { slot: 'charge', rank: 3, chargeTimeMul: .68 }, model: [{ shape: 'sphere', pos: [0, .12, 0], size: [.23, .23, .23], color: [.48, .24, 1], emissive: .85 }],
  },
  optic_1x: {
    id: 'optic_1x', name: '1× 全息瞄具', category: '瞄具', rarity: 'rare', stack: 1,
    desc: '安装后获得更宽的 1× ADS 视野，同时将瞄准晃动降至 72%，并进一步收紧开镜散布。',
    effect: '更宽 ADS 视野 · 晃动 -28% · 开镜散布降低', usage: '拖到兼容枪械卡片或单击安装；可拖回背包卸下。',
    equipSlot: 'optic', compatible: ['r99', 'flatline', 'volt', 'peacekeeper'],
    model: [
      { shape: 'box', pos: [0, 0.04, 0], size: [0.28, 0.08, 0.18], color: [0.10, 0.13, 0.16] },
      { shape: 'box', pos: [-0.12, 0.17, 0], size: [0.035, 0.24, 0.05], color: [0.16, 0.20, 0.24] },
      { shape: 'box', pos: [0.12, 0.17, 0], size: [0.035, 0.24, 0.05], color: [0.16, 0.20, 0.24] },
      { shape: 'box', pos: [0, 0.29, 0], size: [0.27, 0.035, 0.05], color: [0.18, 0.24, 0.28] },
      { shape: 'sphere', pos: [0, 0.17, -0.03], size: [0.035, 0.035, 0.02], color: [0.30, 0.92, 1.0], emissive: 0.9 },
    ],
  },
  tactical_knife: {
    id: 'tactical_knife', name: '战术刀', category: '近战武器', rarity: 'epic', stack: 1,
    desc: '装备后将 3 号槽的徒手拳击替换为战术刀挥砍，并提高 30% 近战伤害。',
    effect: '近战伤害 ×1.30 · 启用刀具模型/动作', usage: '拖到 3 号近战槽或单击安装；可拖回背包卸下。',
    equipSlot: 'melee', compatible: ['melee'],
    model: [
      { shape: 'box', pos: [0, 0.10, 0.08], size: [0.07, 0.07, 0.22], rot: [0.12, 0, 0], color: [0.055, 0.065, 0.075] },
      { shape: 'box', pos: [0, 0.12, -0.04], size: [0.16, 0.035, 0.06], color: [0.12, 0.14, 0.16] },
      { shape: 'box', pos: [0, 0.15, -0.23], size: [0.09, 0.025, 0.34], rot: [-0.08, 0, 0], color: [0.70, 0.78, 0.84] },
      { shape: 'box', pos: [0.035, 0.165, -0.23], size: [0.018, 0.022, 0.27], rot: [-0.08, 0, 0], color: [0.92, 0.97, 1.0], emissive: 0.18 },
    ],
  },
  weapon_r99: weaponLoot('weapon_r99', 'R-99 冲锋枪', 'r99', 'rare', '高射速轻型冲锋枪，24 发基础弹匣，拾取后可装备到主武器或副武器槽。', [.76, .82, .88]),
  weapon_flatline: weaponLoot('weapon_flatline', '平行步枪', 'flatline', 'rare', '稳定的重型突击步枪，单发 22 点伤害，拾取后可装备到主武器或副武器槽。', [.30, .25, .20]),
  weapon_volt: weaponLoot('weapon_volt', 'Volt 冲锋枪', 'volt', 'epic', '能量冲锋枪，拥有 35 发弹匣与低后坐，拾取后可装备并真实开火。', [.18, .62, .82]),
  weapon_peacekeeper: weaponLoot('weapon_peacekeeper', '和平捍卫者霰弹枪', 'peacekeeper', 'epic', '近距离高爆发泵动霰弹枪，6 发弹匣，拾取后可装备并发射多枚弹丸。', [.36, .68, .62]),
  weapon_longbow: weaponLoot('weapon_longbow', '长弓精确步枪', 'longbow', 'epic', '中远距离精确射手步枪，5 发弹匣，拾取后可装备并使用独立弹药状态开火。', [.30, .36, .52]),
  weapon_sentinel: weaponLoot('weapon_sentinel', '哨兵狙击步枪', 'sentinel', 'legendary', '4 倍镜栓动狙击步枪，可整匣充能强化，适合装备到额外武器槽。', [.08, .18, .48]),
  armor_plate: {
    id: 'armor_plate', name: '复合装甲板', category: '护甲', rarity: 'epic', stack: 3,
    desc: '一次性护甲升级材料。单击消耗 1 块，永久增加本次远征 25 点护盾上限并补满新增护盾格。',
    effect: '本局护盾上限 +25（最多额外 +50）', usage: '背包内单击使用；达到 125 基础护盾上限时不会消耗。', consumable: 'armor',
    model: [
      { shape: 'box', pos: [0, 0.11, 0], size: [0.34, 0.22, 0.08], rot: [0, 0, 0.08], color: [0.18, 0.38, 0.62] },
      { shape: 'box', pos: [0, 0.12, -0.055], size: [0.24, 0.12, 0.025], color: [0.36, 0.78, 1.0], emissive: 0.30 },
      { shape: 'box', pos: [-0.15, 0.11, 0], size: [0.025, 0.18, 0.12], color: [0.08, 0.12, 0.18] },
      { shape: 'box', pos: [0.15, 0.11, 0], size: [0.025, 0.18, 0.12], color: [0.08, 0.12, 0.18] },
    ],
  },
  intel_core: {
    id: 'intel_core', name: '情报核心', category: '任务物资', rarity: 'legendary', stack: 2,
    desc: '加密工业数据核心。单击解码并消耗 1 个，立即获得 500 基础分与 25 合金结算价值。',
    effect: '远征基础分 +500 · 合金 +25', usage: '背包内单击解码；右键或拖出背包可丢弃。', consumable: 'intel',
    model: [
      { shape: 'sphere', pos: [0, 0.18, 0], size: [0.24, 0.24, 0.24], color: [0.10, 0.12, 0.16] },
      { shape: 'cylinder', pos: [0, 0.18, 0], size: [0.34, 0.055, 0.34], color: [1.0, 0.56, 0.10], emissive: 0.55 },
      { shape: 'sphere', pos: [0, 0.18, 0], size: [0.105, 0.105, 0.105], color: [1.0, 0.82, 0.22], emissive: 0.95 },
    ],
  },
};

function weaponLoot(id, name, weaponId, rarity, desc, color) {
  return {
    id, name, weaponId, category: '武器', rarity, stack: 1, desc,
    effect: `装备 ${name} · 保留独立弹匣与射击数据`,
    usage: '单击自动装备，或拖到 1/2/4 号武器卡片；被替换武器会回到背包。',
    model: [
      { shape: 'box', pos: [0, .16, 0], size: [.16, .18, .68], color },
      { shape: 'box', pos: [0, .16, -.41], size: [.07, .07, .28], color: [.10, .12, .14] },
      { shape: 'box', pos: [.08, .05, .05], size: [.07, .20, .13], color: [.14, .16, .18] },
    ],
  };
}

const LOOT_IDS = Object.keys(LOOT_DEFS);
const RARITY_COLOR = {
  common: '#aeb9c3', rare: '#58b8ff', epic: '#b77aff', legendary: '#ffb13b',
};

export class InventorySystem {
  constructor(engine, root, opts = {}) {
    this.engine = engine;
    this.root = root || null;
    this.weapons = opts.weapons || null;
    this.weaponDefs = opts.weaponDefs || null;
    this.player = opts.player || null;
    this.run = opts.run || null;
    this.onUseHealing = typeof opts.onUseHealing === 'function' ? opts.onUseHealing : null;
    this.slots = new Array(BACKPACK_SIZE).fill(null);
    this.drops = [];
    this.open = false;
    this.nearDrop = null;
    this._nextDropId = 1;
    this._time = 0;
    this._dragFrom = -1;
    this._dragHandled = false;
    this._els = null;
    this._buildUI();
  }

  reset(world, seed = 1, opts = {}) {
    this.slots.fill(null);
    this.drops.length = 0;
    this.nearDrop = null;
    if (this.weapons && typeof this.weapons.clearLootAttachments === 'function') this.weapons.clearLootAttachments();
    this.setOpen(false);
    // 给第一轮背包操作留出可验证内容，同时仍要求玩家去地图上搜更高价值物品。
    this.add('medkit', 1);
    this.add('shield_battery', 1);
    this.add('syringe', 1);
    this.add('shield_cell', 1);
    this.seedWorldLoot(world, seed);
    if (opts && opts.carry) this.importCarry(opts.carry);
    this.renderUI();
  }

  /** 导出撤离时可带出的有限物资，以及当前四个武器槽实际安装的配件。 */
  exportCarry() {
    const totals = new Map();
    for (const s of this.slots) {
      const def = s && LOOT_DEFS[s.itemId];
      if (!def || def.infinite || !Number.isFinite(s.count) || s.count <= 0) continue;
      totals.set(s.itemId, (totals.get(s.itemId) || 0) + Math.floor(s.count));
    }
    const attachments = {};
    const equippedIds = new Set((this.weapons && this.weapons.slots || []).map(s => s && s.id).filter(Boolean));
    // 制式四槽无需占仓库；远征中换上的稀有枪械则作为真实战利品带出。
    for (const weaponId of equippedIds) {
      if (!['r99', 'flatline', 'melee', 'sentinel'].includes(weaponId) && LOOT_DEFS[`weapon_${weaponId}`]) {
        totals.set(`weapon_${weaponId}`, (totals.get(`weapon_${weaponId}`) || 0) + 1);
      }
    }
    if (this.weapons && typeof this.weapons.getAttachments === 'function') {
      for (const weaponId of equippedIds) {
        for (const [slot, itemId] of Object.entries(this.weapons.getAttachments(weaponId))) {
          if (itemId && LOOT_DEFS[itemId] && LOOT_DEFS[itemId].equipSlot === slot) {
            if (!attachments[weaponId]) attachments[weaponId] = {};
            attachments[weaponId][slot] = itemId;
          }
        }
      }
    }
    return { version: 1, items: [...totals].map(([itemId, count]) => ({ itemId, count })), attachments };
  }

  /** 清除部署物资而保留四种无限战术补给。 */
  clearFiniteCarry() {
    let removed = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i], def = s && LOOT_DEFS[s.itemId];
      if (s && (!def || !def.infinite)) { removed += Number.isFinite(s.count) ? s.count : 0; this.slots[i] = null; }
    }
    this.renderUI();
    return removed;
  }

  /** 从局外仓库恢复物资。坏数据、未知物品与不兼容配件均安全忽略。 */
  importCarry(carry) {
    const result = { items: 0, attachments: 0, ignored: 0 };
    if (!carry || typeof carry !== 'object') return result;
    const itemRows = Array.isArray(carry.items) ? carry.items
      : Object.entries(carry.items && typeof carry.items === 'object' ? carry.items : {}).map(([itemId, count]) => ({ itemId, count }));
    for (const row of itemRows) {
      const def = row && LOOT_DEFS[row.itemId];
      const count = row && Number.isFinite(row.count) ? Math.max(0, Math.min(999, Math.floor(row.count))) : 0;
      if (!def || def.infinite || count <= 0) { result.ignored++; continue; }
      const n = this.add(row.itemId, count); result.items += n;
      if (n < count) result.ignored += count - n;
    }
    const attachmentRows = Array.isArray(carry.attachments) ? carry.attachments : [];
    if (carry.attachments && typeof carry.attachments === 'object' && !Array.isArray(carry.attachments)) {
      for (const [weaponId, slots] of Object.entries(carry.attachments)) {
        if (!slots || typeof slots !== 'object') continue;
        for (const [slot, itemId] of Object.entries(slots)) attachmentRows.push({ weaponId, slot, itemId });
      }
    }
    for (const row of attachmentRows) {
      const def = row && LOOT_DEFS[row.itemId];
      if (!def || !def.equipSlot || def.equipSlot !== row.slot || !this.weapons
        || typeof this.weapons.installAttachment !== 'function') { result.ignored++; continue; }
      const r = this.weapons.installAttachment(row.itemId, row.weaponId);
      if (r.ok) result.attachments++; else result.ignored++;
    }
    this.renderUI();
    return result;
  }

  setGameplayContext(ctx = {}) {
    if (ctx.player) this.player = ctx.player;
    if (ctx.run) this.run = ctx.run;
    if (typeof ctx.onUseHealing === 'function') this.onUseHealing = ctx.onUseHealing;
  }

  seedWorldLoot(world, seed = 1) {
    if (!world || typeof world.groundHeight !== 'function') return;
    const rng = M.mulberry32((seed ^ 0x1A2B3C4D) >>> 0);
    const anchors = [];
    for (const p of (world.spawnPoints ? world.spawnPoints() : [])) anchors.push(p);
    for (const o of (world.objectives ? world.objectives() : [])) anchors.push(o.pos || o);
    for (const s of (world.supplyStations ? world.supplyStations() : [])) anchors.push(s.pos || s);
    if (anchors.length === 0) anchors.push([0, world.groundHeight(0, 0), 0]);
    const total = Math.min(32, Math.max(16, anchors.length * 4));
    for (let i = 0; i < total; i++) {
      const a = anchors[i % anchors.length];
      const angle = rng() * Math.PI * 2;
      const radius = 3.0 + rng() * 8.0;
      let x = a[0] + Math.cos(angle) * radius;
      let z = a[2] + Math.sin(angle) * radius;
      const placement = [x, world.groundHeight(x, z) + 5, z];
      if (typeof world.snapToGround === 'function') world.snapToGround(placement, 0.06);
      // 危险池内的战利品会诱导玩家踩岩浆；改用导航开放点，保证可拾取。
      if ((world.hazardAt && world.hazardAt(placement)) && world.randomNavPoint) {
        const nav = world.randomNavPoint(rng);
        placement[0] = nav[0]; placement[1] = nav[1] + 0.06; placement[2] = nav[2];
      }
      x = placement[0]; z = placement[2];
      const roll = rng();
      // 医疗包/电池本身为无限战术补给，不再生成无意义的重复地面掉落。
      // 每张地图保证三把非默认武器各有一件实体掉落，不能依赖低概率随机后
      // 出现整局都拿不到隐藏枪的情况。
      const id = i < 3 ? ['weapon_volt', 'weapon_peacekeeper', 'weapon_longbow'][i]
        : roll > 0.965 ? ['weapon_volt', 'weapon_peacekeeper', 'weapon_longbow'][i % 3]
        : roll > 0.91 ? 'intel_core'
        : roll > 0.75 ? 'armor_plate'
          : roll > 0.59 ? 'tactical_knife'
            : roll > 0.43 ? 'optic_1x'
              : roll > 0.27 ? ['sniper_cell_1', 'sniper_cell', 'sniper_cell_3'][i % 3]
                : roll > 0.13 ? ['heavy_mag_1', 'heavy_mag', 'heavy_mag_3'][i % 3]
                  : ['light_mag_1', 'light_mag', 'light_mag_3'][i % 3];
      this.spawn(id, 1, [x, placement[1], z], { spawned: 0 });
    }
  }

  spawn(itemId, count, pos, opts = {}) {
    const def = LOOT_DEFS[itemId];
    if (!def || !pos) return null;
    const drop = {
      uid: this._nextDropId++, itemId, count: Math.max(1, count | 0),
      pos: new Float32Array([+pos[0] || 0, +pos[1] || 0, +pos[2] || 0]),
      yaw: opts.yaw == null ? ((this._nextDropId * 1.618) % (Math.PI * 2)) : opts.yaw,
      spawned: opts.spawned == null ? this._time : opts.spawned,
    };
    this.drops.push(drop);
    return drop;
  }

  spawnEnemyDrop(enemy, world) {
    if (!enemy || !enemy.pos) return null;
    const n = ((enemy.id || this._nextDropId) * 2654435761) >>> 0;
    if ((n % 100) >= 48) return null;
    const table = ['light_mag_1', 'light_mag', 'light_mag_3', 'heavy_mag_1', 'heavy_mag', 'heavy_mag_3',
      'sniper_cell_1', 'sniper_cell', 'sniper_cell_3', 'optic_1x', 'tactical_knife', 'armor_plate',
      'weapon_volt', 'weapon_peacekeeper', 'weapon_longbow'];
    const id = table[n % table.length];
    const y = world && world.groundHeight ? world.groundHeight(enemy.pos[0], enemy.pos[2]) + 0.08 : enemy.pos[1];
    return this.spawn(id, 1, [enemy.pos[0], y, enemy.pos[2]]);
  }

  add(itemId, count = 1) {
    const def = LOOT_DEFS[itemId];
    if (!def) return 0;
    if (def.infinite) {
      // 无限补给仅保留一个固定入口。拾取旧版本地图里的同名掉落也不会
      // 生成有限堆叠，从而确保背包展示与实际使用逻辑始终一致。
      const existing = this.slots.find((s) => s && s.itemId === itemId);
      if (existing) existing.count = Infinity;
      else {
        const empty = this.slots.findIndex((s) => !s);
        if (empty < 0) return 0;
        this.slots[empty] = { itemId, count: Infinity };
      }
      this.renderUI();
      return Number.isFinite(count) ? Math.max(0, count | 0) : 1;
    }
    const requested = Math.max(0, count | 0);
    let remain = requested;
    for (let i = 0; i < this.slots.length && remain > 0; i++) {
      const s = this.slots[i];
      if (!s || s.itemId !== itemId || s.count >= def.stack) continue;
      const take = Math.min(remain, def.stack - s.count);
      s.count += take; remain -= take;
    }
    for (let i = 0; i < this.slots.length && remain > 0; i++) {
      if (this.slots[i]) continue;
      const take = Math.min(remain, def.stack);
      this.slots[i] = { itemId, count: take };
      remain -= take;
    }
    this.renderUI();
    return requested - remain;
  }

  moveOrSwap(from, to) {
    if (from < 0 || to < 0 || from >= this.slots.length || to >= this.slots.length || from === to) return false;
    const a = this.slots[from];
    if (!a) return false;
    const b = this.slots[to];
    const def = LOOT_DEFS[a.itemId];
    if (b && b.itemId === a.itemId && b.count < def.stack) {
      const n = Math.min(a.count, def.stack - b.count);
      b.count += n; a.count -= n;
      if (a.count <= 0) this.slots[from] = null;
    } else {
      this.slots[to] = a;
      this.slots[from] = b;
    }
    this.renderUI();
    return true;
  }

  /** 双击自动安装，或拖到武器卡片时按 targetWeaponId 精确安装。 */
  equipSlot(index, targetWeaponId = null, targetSlot = null) {
    const s = this.slots[index];
    const def = s && LOOT_DEFS[s.itemId];
    if (s && def && def.weaponId) return this.equipWeaponSlot(index, targetSlot);
    if (!s || !def || !def.equipSlot || !this.weapons || typeof this.weapons.installAttachment !== 'function') {
      Events.emit('ui:message', { title: '不能安装', sub: def ? `${def.name} 不是武器配件` : '该格为空', kind: 'warn' });
      return { ok: false, reason: 'not_attachment' };
    }
    const result = this.weapons.installAttachment(s.itemId, targetWeaponId);
    if (!result.ok) {
      Events.emit('ui:message', {
        title: result.reason === 'equipped' ? '已经安装' : '无法安装',
        sub: result.reason === 'equipped' ? def.name
          : (result.reason === 'lower_rank' ? '已装备同级或更高级配件，请先卸下' : '当前没有兼容武器'), kind: 'warn',
      });
      return result;
    }
    s.count--;
    if (s.count <= 0) this.slots[index] = null;
    if (result.replaced) this.add(result.replaced, 1);
    this.renderUI();
    const weaponDef = this.weaponDefs && this.weaponDefs[result.weaponId];
    Events.emit('audio:play', { name: 'ui_click', gain: 0.7, rate: 1.18 });
    Events.emit('ui:message', {
      title: '配件已安装', sub: `${def.name} → ${weaponDef ? (weaponDef.nameCN || weaponDef.name) : result.weaponId}`, kind: 'good',
    });
    return result;
  }

  /** 将地面/背包武器真正装入 1、2、4 号槽，并把被替换武器退回背包。 */
  equipWeaponSlot(index, targetSlot = null) {
    const s = this.slots[index];
    const def = s && LOOT_DEFS[s.itemId];
    if (!def || !def.weaponId || !this.weapons || typeof this.weapons.installLootWeapon !== 'function') {
      return { ok: false, reason: 'not_weapon' };
    }
    const result = this.weapons.installLootWeapon(def.weaponId, targetSlot);
    if (!result.ok) return result;
    s.count--;
    if (s.count <= 0) this.slots[index] = null;
    if (result.replaced) this.add(`weapon_${result.replaced}`, 1);
    this.renderUI();
    Events.emit('audio:play', { name: 'ui_click', gain: .8, rate: .82 });
    Events.emit('ui:message', { title: '武器已装备', sub: `${def.name} → ${result.slot + 1} 号槽`, kind: 'good' });
    return result;
  }

  /** 单击统一入口：配件安装、无限治疗和消耗品都必须产生真实游戏效果。 */
  activateSlot(index) {
    const s = this.slots[index];
    const def = s && LOOT_DEFS[s.itemId];
    if (!s || !def) return { ok: false, reason: 'empty' };
    if (def.weaponId) return this.equipWeaponSlot(index);
    if (def.equipSlot) return this.equipSlot(index);
    if (Number.isInteger(def.healIndex)) {
      const ok = !!(this.onUseHealing && this.onUseHealing(def.healIndex));
      return { ok, reason: ok ? 'healing' : 'unavailable', itemId: def.id };
    }
    if (def.consumable === 'armor') {
      const p = this.player || this._playerForDrop;
      if (!p || !p.alive) return { ok: false, reason: 'no_player', itemId: def.id };
      const added = typeof p.increaseShieldCapacity === 'function'
        ? p.increaseShieldCapacity(25) : 0;
      if (added <= 0) {
        Events.emit('ui:message', { title: '装甲已达上限', sub: '本局装甲板最多提供额外 50 点护盾上限', kind: 'warn' });
        return { ok: false, reason: 'capacity_full', itemId: def.id };
      }
      this._consumeOne(index);
      Events.emit('audio:play', { name: 'shield_battery_complete', gain: 0.72, rate: 1.18 });
      Events.emit('ui:message', { title: '护盾装甲升级', sub: `最大护盾 +${added} · 新增 1 格`, kind: 'good' });
      return { ok: true, reason: 'used', itemId: def.id, maxShieldAdded: added };
    }
    if (def.consumable === 'intel') {
      if (!this.run) return { ok: false, reason: 'no_run', itemId: def.id };
      this.run.addScore(500);
      this.run.addAlloy(25);
      this._consumeOne(index);
      Events.emit('audio:play', { name: 'pickup_alloy', gain: 0.82, rate: 1.12 });
      Events.emit('ui:message', { title: '情报核心已解码', sub: '远征分数 +500 · 合金 +25', kind: 'good' });
      return { ok: true, reason: 'decoded', itemId: def.id, score: 500, alloy: 25 };
    }
    return { ok: false, reason: 'no_action', itemId: def.id };
  }

  _consumeOne(index) {
    const s = this.slots[index];
    if (!s || !Number.isFinite(s.count)) return false;
    s.count--;
    if (s.count <= 0) this.slots[index] = null;
    this.renderUI();
    return true;
  }

  /** 从武器槽卸下配件，放进指定空格；未指定时使用第一个空格。 */
  unequipAttachment(weaponId, slot, targetIndex = -1) {
    if (!this.weapons || typeof this.weapons.uninstallAttachment !== 'function') return { ok: false, reason: 'unsupported' };
    let dst = Number.isInteger(targetIndex) ? targetIndex : -1;
    if (dst < 0) dst = this.slots.findIndex((s) => !s);
    if (dst < 0 || dst >= this.slots.length || this.slots[dst]) {
      Events.emit('ui:message', { title: '背包已满', sub: '没有空格可卸下配件', kind: 'warn' });
      return { ok: false, reason: 'full' };
    }
    const result = this.weapons.uninstallAttachment(weaponId, slot);
    if (!result.ok) return result;
    this.slots[dst] = { itemId: result.itemId, count: 1 };
    this.renderUI();
    const def = LOOT_DEFS[result.itemId];
    Events.emit('audio:play', { name: 'ui_click', gain: 0.62, rate: 0.92 });
    Events.emit('ui:message', { title: '配件已卸下', sub: def ? def.name : result.itemId, kind: 'info' });
    return { ...result, targetIndex: dst };
  }

  dropSlot(index, player, count = Infinity) {
    const s = this.slots[index];
    if (!s || !player) return false;
    const def = LOOT_DEFS[s.itemId];
    if (def && def.infinite) {
      Events.emit('ui:message', { title: '无限补给', sub: `${def.name}不会耗尽，也不需要丢弃`, kind: 'info' });
      return false;
    }
    const n = Math.min(s.count, Number.isFinite(count) ? Math.max(1, count | 0) : s.count);
    const f = player.forward || [0, 0, -1];
    const p = player.pos || [0, 0, 0];
    this.spawn(s.itemId, n, [p[0] + f[0] * 1.45, p[1] + 0.18, p[2] + f[2] * 1.45], { yaw: player.yaw || 0 });
    s.count -= n;
    if (s.count <= 0) this.slots[index] = null;
    this.renderUI();
    Events.emit('audio:play', { name: 'loot_drop', gain: 0.72 });
    return true;
  }

  update(dt, player) {
    this._time += dt;
    this.nearDrop = null;
    if (!player || !player.pos) return;
    let bestD2 = 2.7 * 2.7;
    for (const d of this.drops) {
      const dx = d.pos[0] - player.pos[0];
      const dy = d.pos[1] - player.pos[1];
      const dz = d.pos[2] - player.pos[2];
      const d2 = dx * dx + dy * dy * 0.35 + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; this.nearDrop = d; }
    }
  }

  pickupNearest(player) {
    const d = this.nearDrop;
    if (!d) return { ok: false, reason: 'none' };
    const added = this.add(d.itemId, d.count);
    if (added <= 0) return { ok: false, reason: 'full', def: LOOT_DEFS[d.itemId] };
    d.count -= added;
    if (d.count <= 0) {
      const i = this.drops.indexOf(d);
      if (i >= 0) this.drops.splice(i, 1);
      this.nearDrop = null;
    }
    return { ok: true, added, remaining: d.count, def: LOOT_DEFS[d.itemId] };
  }

  setOpen(open, player) {
    this.open = !!open;
    if (this._els) this._els.overlay.classList.toggle('inventory-overlay--on', this.open);
    if (this.open) this.renderUI();
    else this._hideTooltip();
    this._playerForDrop = player || this._playerForDrop || null;
  }

  render(engine) {
    if (!engine || this.drops.length === 0) return;
    const meshes = engine.sharedMeshes || {};
    const root = new Float32Array(16);
    const local = new Float32Array(16);
    const out = new Float32Array(16);
    for (const d of this.drops) {
      const def = LOOT_DEFS[d.itemId];
      if (!def) continue;
      const bob = Math.sin(this._time * 2.2 + d.uid) * 0.055;
      M.m4Compose([d.pos[0], d.pos[1] + bob, d.pos[2]], d.yaw + this._time * 0.32, 0, 0, 1, root);
      for (const p of def.model) {
        const rot = p.rot || [0, 0, 0];
        M.m4Compose(p.pos, rot[1] || 0, rot[0] || 0, rot[2] || 0, p.size, local);
        M.m4Mul(root, local, out);
        const mesh = p.shape === 'sphere' ? meshes.sphere
          : p.shape === 'cylinder' ? meshes.cylinder : meshes.cube;
        if (mesh) engine.drawInstanced(mesh, out, 1, {
          color: p.color, emissive: p.emissive || 0, cull: false,
        });
      }
      // 物品脚下的小型发光底座让掉落可找，但不取代物品本体。
      M.m4Compose([d.pos[0], d.pos[1] - 0.015, d.pos[2]], 0, 0, 0, [0.42, 0.025, 0.42], out);
      if (meshes.cylinder) engine.drawInstanced(meshes.cylinder, out, 1, {
        color: rarityRgb(def.rarity), emissive: 0.42, cull: false,
      });
    }
  }

  _buildUI() {
    if (!this.root || typeof document === 'undefined') return;
    const overlay = document.createElement('div');
    overlay.id = 'inventory-overlay';
    overlay.className = 'inventory-overlay';
    overlay.innerHTML = `
      <section class="inventory-panel" role="dialog" aria-label="远征背包">
        <header class="inventory-head"><div><b>远征背包</b><span>单击使用/安装 · 拖动整理 · 右键或拖出丢弃</span></div><strong id="inventory-capacity">0 / ${BACKPACK_SIZE}</strong></header>
        <div class="inventory-loadout" id="inventory-loadout"></div>
        <div class="inventory-grid" id="inventory-grid"></div>
        <div class="inventory-drop-zone" id="inventory-drop-zone">拖到这里丢弃</div>
        <footer><span>E 拾取地图物资</span><span>Tab / Esc 关闭</span></footer>
      </section>
      <aside class="inventory-tooltip" id="inventory-tooltip" role="tooltip" aria-hidden="true"></aside>`;
    this.root.appendChild(overlay);
    const grid = overlay.querySelector('#inventory-grid');
    const slots = [];
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'inventory-slot';
      el.dataset.index = String(i);
      el.draggable = false;
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.dropSlot(i, this._playerForDrop);
      });
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (ev.button !== 0 || this._dragFrom >= 0) return;
        this.activateSlot(i);
      });
      el.addEventListener('mouseenter', (ev) => {
        const s = this.slots[i];
        if (s && LOOT_DEFS[s.itemId]) this._showTooltip(LOOT_DEFS[s.itemId], ev, { count: s.count });
      });
      el.addEventListener('mousemove', (ev) => this._positionTooltip(ev));
      el.addEventListener('mouseleave', () => this._hideTooltip());
      el.addEventListener('dragstart', (ev) => {
        if (!this.slots[i]) { ev.preventDefault(); return; }
        this._dragFrom = i; this._dragHandled = false;
        el.classList.add('inventory-slot--dragging');
        try { ev.dataTransfer.setData('text/plain', String(i)); ev.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
      });
      el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('inventory-slot--over'); });
      el.addEventListener('dragleave', () => el.classList.remove('inventory-slot--over'));
      el.addEventListener('drop', (ev) => {
        ev.preventDefault(); el.classList.remove('inventory-slot--over');
        let payload = '';
        try { payload = ev.dataTransfer.getData('text/plain') || ''; } catch (_e) {}
        if (payload.startsWith('attachment:')) {
          const [, weaponId, slot] = payload.split(':');
          this._dragHandled = !!this.unequipAttachment(weaponId, slot, i).ok;
        } else {
          const from = /^\d+$/.test(payload) ? Number(payload) : this._dragFrom;
          this._dragHandled = this.moveOrSwap(from, i);
        }
      });
      el.addEventListener('dragend', (ev) => {
        el.classList.remove('inventory-slot--dragging');
        const panel = overlay.querySelector('.inventory-panel');
        const r = panel.getBoundingClientRect();
        const outside = ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
        if (!this._dragHandled && outside) this.dropSlot(this._dragFrom, this._playerForDrop);
        this._dragFrom = -1; this._dragHandled = false;
      });
      grid.appendChild(el);
      slots.push(el);
    }
    const dz = overlay.querySelector('#inventory-drop-zone');
    dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('inventory-drop-zone--over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('inventory-drop-zone--over'));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault(); dz.classList.remove('inventory-drop-zone--over');
      this._dragHandled = this.dropSlot(this._dragFrom, this._playerForDrop);
    });
    this._els = {
      overlay, grid, slots, capacity: overlay.querySelector('#inventory-capacity'),
      loadout: overlay.querySelector('#inventory-loadout'), dropZone: dz,
      tooltip: overlay.querySelector('#inventory-tooltip'),
    };
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.renderUI();
  }

  renderUI() {
    if (!this._els) return;
    let used = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const el = this._els.slots[i];
      el.textContent = '';
      el.className = 'inventory-slot';
      el.removeAttribute('aria-label');
      el.draggable = !!s;
      if (!s) continue;
      const def = LOOT_DEFS[s.itemId];
      if (!def.infinite) used++;
      el.classList.add('inventory-slot--filled', 'inventory-slot--' + def.rarity);
      if (def.infinite) el.classList.add('inventory-slot--utility');
      el.draggable = !def.infinite;
      el.setAttribute('aria-label', `${def.name}：${def.desc}`);
      const icon = document.createElement('i');
      icon.className = 'inventory-item-icon inventory-item-icon--' + def.id;
      icon.textContent = itemGlyph(def.id);
      const name = document.createElement('span'); name.textContent = def.name;
      const count = document.createElement('b');
      count.textContent = def.infinite || !Number.isFinite(s.count) ? '∞' : (s.count > 1 ? '×' + s.count : '');
      el.append(icon, name, count);
    }
    this._els.capacity.textContent = `${used} / ${BACKPACK_SIZE}`;
    this._els.capacity.classList.toggle('inventory-capacity--full', used >= BACKPACK_SIZE);
    const loadout = this.weapons && this.weapons.slots ? this.weapons.slots : [];
    const labels = ['主武器', '副武器', '近战', '额外武器'];
    this._els.loadout.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const w = loadout[i];
      const def = w && this.weaponDefs ? this.weaponDefs[w.id] : null;
      const box = document.createElement('div');
      box.className = 'inventory-weapon-slot' + (this.weapons && this.weapons.slotIndex === i ? ' inventory-weapon-slot--active' : '');
      box.dataset.weaponId = w && w.id ? w.id : '';
      const fallback = w && w.id ? w.id.toUpperCase() : (i === 2 ? '近战武器' : '空');
      box.innerHTML = `<em>${i + 1}</em><span>${labels[i]}</span><b>${def ? (def.nameCN || def.name) : fallback}</b>`;
      if (w && w.id) {
        box.addEventListener('dragover', (ev) => { ev.preventDefault(); box.classList.add('inventory-weapon-slot--over'); });
        box.addEventListener('dragleave', () => box.classList.remove('inventory-weapon-slot--over'));
        box.addEventListener('drop', (ev) => {
          ev.preventDefault(); box.classList.remove('inventory-weapon-slot--over');
          let payload = '';
          try { payload = ev.dataTransfer.getData('text/plain') || ''; } catch (_e) {}
          if (!/^\d+$/.test(payload)) return;
          const result = this.equipSlot(Number(payload), w.id, i);
          this._dragHandled = !!result.ok;
        });
      }
      if (w && this.weapons && typeof this.weapons.getAttachments === 'function') {
        const attached = Object.entries(this.weapons.getAttachments(w.id)).filter(([, id]) => !!id);
        const mod = document.createElement('small');
        mod.className = 'inventory-attachment-list';
        if (!attached.length) mod.textContent = '拖入兼容配件';
        for (const [slot, id] of attached) {
          const chip = document.createElement('i');
          chip.className = 'inventory-attachment-chip';
          chip.textContent = LOOT_DEFS[id] ? LOOT_DEFS[id].name : id;
          chip.setAttribute('aria-label', `${LOOT_DEFS[id] ? LOOT_DEFS[id].name : id}，已装备`);
          chip.draggable = true;
          chip.addEventListener('mouseenter', (ev) => {
            if (LOOT_DEFS[id]) this._showTooltip(LOOT_DEFS[id], ev, { equipped: true, weaponId: w.id });
          });
          chip.addEventListener('mousemove', (ev) => this._positionTooltip(ev));
          chip.addEventListener('mouseleave', () => this._hideTooltip());
          chip.addEventListener('dragstart', (ev) => {
            this._dragHandled = false;
            try { ev.dataTransfer.setData('text/plain', `attachment:${w.id}:${slot}`); ev.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
          });
          chip.addEventListener('contextmenu', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            this.unequipAttachment(w.id, slot);
          });
          mod.appendChild(chip);
        }
        box.appendChild(mod);
      }
      this._els.loadout.appendChild(box);
    }
  }

  _showTooltip(def, ev, extra = {}) {
    const el = this._els && this._els.tooltip;
    if (!el || !def) return;
    const rarityName = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }[def.rarity] || def.rarity;
    const compatible = (def.compatible || []).map((id) => {
      const w = this.weaponDefs && this.weaponDefs[id];
      return w ? (w.nameCN || w.name || id) : id;
    });
    el.textContent = '';
    const head = document.createElement('header');
    const name = document.createElement('b'); name.textContent = def.name;
    const meta = document.createElement('span'); meta.textContent = `${rarityName} · ${def.category}`;
    head.append(name, meta);
    const desc = document.createElement('p'); desc.textContent = def.desc;
    const effect = document.createElement('strong'); effect.textContent = def.effect || '已启用对应物品效果';
    const details = document.createElement('div');
    const countText = def.infinite || !Number.isFinite(extra.count) ? '数量：∞（不占容量）'
      : (Number.isFinite(extra.count) ? `当前堆叠：${extra.count} / ${def.stack}` : '');
    const compatText = compatible.length ? `兼容：${compatible.join('、')}` : '';
    const equippedText = extra.equipped ? '状态：已装备（右键或拖回背包卸下）' : '';
    details.textContent = [countText, compatText, equippedText].filter(Boolean).join('\n');
    const usage = document.createElement('small'); usage.textContent = def.usage || '右键或拖出背包可丢弃。';
    el.append(head, effect, desc, details, usage);
    el.style.setProperty('--item-rarity', RARITY_COLOR[def.rarity] || '#aeb9c3');
    el.classList.add('inventory-tooltip--on');
    el.setAttribute('aria-hidden', 'false');
    this._positionTooltip(ev);
  }

  _positionTooltip(ev) {
    const el = this._els && this._els.tooltip;
    if (!el || !el.classList.contains('inventory-tooltip--on') || !ev) return;
    const pad = 14;
    const width = el.offsetWidth || 340;
    const height = el.offsetHeight || 220;
    let x = ev.clientX + 18;
    let y = ev.clientY + 18;
    if (x + width + pad > window.innerWidth) x = ev.clientX - width - 18;
    if (y + height + pad > window.innerHeight) y = ev.clientY - height - 18;
    el.style.left = `${Math.max(pad, x)}px`;
    el.style.top = `${Math.max(pad, y)}px`;
  }

  _hideTooltip() {
    const el = this._els && this._els.tooltip;
    if (!el) return;
    el.classList.remove('inventory-tooltip--on');
    el.setAttribute('aria-hidden', 'true');
  }

  debugState() {
    return {
      open: this.open,
      used: this.slots.filter((s) => s && !(LOOT_DEFS[s.itemId] && LOOT_DEFS[s.itemId].infinite)).length,
      capacity: BACKPACK_SIZE,
      drops: this.drops.length,
      nearDrop: this.nearDrop ? this.nearDrop.itemId : null,
      items: this.slots.filter(Boolean).map((s) => ({ itemId: s.itemId, count: s.count })),
    };
  }
}

function rarityRgb(rarity) {
  if (rarity === 'legendary') return [1.0, 0.58, 0.12];
  if (rarity === 'epic') return [0.62, 0.24, 1.0];
  if (rarity === 'rare') return [0.18, 0.62, 1.0];
  return [0.54, 0.62, 0.68];
}

function itemGlyph(id) {
  return id === 'medkit' ? '+' : id === 'shield_battery' ? '⬡'
    : id === 'syringe' ? '↥' : id === 'shield_cell' ? '◇'
    : id === 'optic_1x' ? '◎' : id === 'tactical_knife' ? '†' : id === 'armor_plate' ? '▰'
      : id === 'intel_core' ? '◆' : id === 'sniper_cell' ? '◉' : '▥';
}

export const INVENTORY_RARITY_COLOR = RARITY_COLOR;
