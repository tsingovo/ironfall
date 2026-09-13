// ==== upgrades.js — 肉鸽改件系统：稀有度抽取、合金经济与外骨骼属性修正 ====
//
// 设计意图（钢铁远征 / 拾荒者视角）：
//   1. 玩家是在钢铁远征废墟里捡垃圾的拾荒者，靠从敌人残骸上拆下的“模块化外骨骼改件”临时变强。
//      所以每个改件都是硬件味儿的名字（伺服、作动器、电容、弹芯），而不是抽象buff。
//   2. 本模块是全项目唯一的属性修正来源，只对外输出一份 modifiers，交给两个消费者：
//        player.setModifiers(mods)   读 mods.move.*    —— 移动 / 生存 / 玩家侧机制
//        weapons.addModifiers(mods)  读 mods.weapon.*  —— 枪械 / 弹道侧机制
//        mods.meta.* 由 run.js 与补给站 UI 读取（合金掉落、价格、幸运）。
//   3. 修正键分两类，显式登记在 MUL_KEYS / ADD_KEYS 里：
//        MUL_KEYS：基准值 1，多来源“相乘”。两个 +20% 伤害 = 1.2 * 1.2 = 1.44（不是 1.4）。
//        ADD_KEYS：基准值 0，多来源“相加”。两个 +1 冲刺次数 = 2。
//      MODIFIER_DEFAULTS 由这两张表自动生成，保证与 modifiers 严格 key-for-key 一致。
//   4. def.apply(stacks) 返回“该改件在当前层数下、相对零改件的总增量 patch”：
//        乘算键用 mulPer(base, stacks) = base^stacks（同一改件叠层同样是相乘）
//        加算键用 addPer(step, stacks) = step * stacks
//      跨改件之间的合并由 UpgradeSystem._computeModifiers() 完成（乘算键相乘、加算键相加）。
//   5. 一切随机都走注入的 rng()，同一 seed 完全可复现（自动化测试 / 录像回放 / 每日挑战）。
//   6. rollOffers() 只在补给站打开时调用，禁止放进每帧路径；applyAll() 也只在购买/重置时调用。
//   7. 广播契约事件：'upgrade:offer' {offers} 与 'upgrade:picked' {id}。
//      HUD 会直接调用 pick()，所以事件必须由本模块自己发，UI/音频才能被动收到（见核心/事件表）。

import { emit } from './core/events.js';

export const RARITIES = {
  common: { name: '通用', color: '#9aa7b4', weight: 100, priceMul: 1 },
  rare: { name: '精良', color: '#4aa3ff', weight: 45, priceMul: 1.9 },
  epic: { name: '史诗', color: '#b06bff', weight: 16, priceMul: 3.4 },
  legendary: { name: '传说', color: '#ffb03a', weight: 4.5, priceMul: 6.2 },
};

// 组顺序固定，用于确定性遍历（对象键顺序 + Map 插入顺序 = 可复现）
const GROUP_ORDER = ['move', 'weapon', 'meta'];
const TAG_ORDER = ['move', 'weapon', 'survival', 'mech'];

// 乘算键：基准 1。玩家侧（move）与枪械侧（weapon）分开登记，meta 供 run/UI 使用。
export const MUL_KEYS = {
  move: new Set([
    'walkSpeedMul',          // 步行/地面速度
    'sprintSpeedMul',        // 疾跑速度
    'sprintWindupMul',       // 疾跑加速斜坡时长（<1 更快到满速）
    'maxSpeedMul',           // 全局水平速度上限
    'slideSpeedMul',         // 滑铲初速
    'slideFrictionMul',      // 滑铲摩擦（<1 更滑更远）
    'slideDownhillMul',      // 下坡加速
    'wallRunTimeMul',        // 蹬墙跑时长上限
    'wallRunStickMul',       // 贴墙吸附力
    'wallJumpMul',           // 蹬墙跳推力
    'wallClimbSpeedMul',     // 墙爬速度
    'grappleRangeMul',       // 抓钩射程
    'grapplePullMul',        // 抓钩牵引力
    'dashCooldownMul',       // 冲刺冷却（<1 更快）
    'doubleJumpMul',         // 二段跳高度
    'airControlMul',         // 空中控制
    'airAccelMul',           // 空中加速
    'gravityMul',            // 重力（<1 更飘）
    'jumpVelMul',            // 起跳初速
    'mantleSpeedMul',        // 攀爬/翻越速度
    'bunnyHopMul',           // 连跳落地速度保留
    'shieldRegenRateMul',    // 护盾恢复速度
    'shieldRegenDelayMul',   // 护盾恢复延迟（<1 更快开始回盾）
    'cheatDeathCooldownMul', // 不死鸟冷却（<1 更短）
  ]),
  weapon: new Set([
    'damageMul',             // 基础伤害
    'damageHeadMul',         // 爆头伤害
    'rpmMul',                // 射速
    'reloadTimeMul',         // 换弹时间（<1 更快）
    'spreadMul',             // 散布
    'recoilMul',             // 后坐力
    'adsTimeMul',            // 开镜时间（<1 更快）
    'rangeMul',              // 有效射程
    'falloffMinMul',         // 远距伤害下限
    'moveSpreadMul',         // 移动中射击散布
    'switchSpeedMul',        // 切枪时间（<1 更快）
    'firstShotSpreadMul',    // 首发散布
    'critDamageMul',         // 暴击伤害倍率
  ]),
  meta: new Set([
    'alloyFindMul',          // 合金拾取量
    'priceMul',              // 补给站价格（<1 打折）
  ]),
};

// 加算键：基准 0。
export const ADD_KEYS = {
  move: new Set([
    'dashChargesAdd',          // 冲刺次数
    'stepHeightAdd',           // 台阶高度（米）
    'landImpactResistAdd',     // 落地冲击抗性（0..1，1 = 免疫落地伤害）
    'maxHealthAdd',            // 最大生命
    'maxShieldAdd',            // 最大护盾
    'lifestealOnKillAdd',      // 击杀回血
    'healOnHeadshotKillAdd',   // 爆头击杀额外回血
    'lowHpDamageResistAdd',    // 低血线伤害抗性（0..1）
    'healthOnSlideKillAdd',    // 滑铲击杀回血
    'cheatDeathAdd',           // 致死免疫层数（0/1，玩家侧按布尔消费）
    'dashResetOnKillAdd',      // 击杀刷新冲刺次数
    'thornsAdd',               // 受击反弹伤害
  ]),
  weapon: new Set([
    'magSizeAdd',                 // 弹匣容量
    'penetrationAdd',             // 子弹穿透数
    'critChanceAdd',              // 暴击率（0..1）
    'explosiveRoundsAdd',         // 爆裂弹等级
    'chainLightningAdd',          // 连锁闪电目标数
    'slowOnHitAdd',               // 命中减速比例（0..1）
    'bleedDotAdd',                // 流血每秒伤害
    'ammoRefundOnHeadshotAdd',    // 爆头回弹数
    'comboDamagePerKillAdd',      // 连杀每层增伤（0.06 = +6%）
    'comboMaxAdd',                // 连杀最大层数
    'comboWindowAdd',             // 连杀窗口（秒）
    'speedToDamageAdd',           // 移速转伤害系数
    'momentumFireRateAdd',        // 动量转射速系数
  ]),
  meta: new Set([
    'luckAdd',               // 幸运：提高高稀有度出现率
  ]),
};

function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

// 由 MUL_KEYS / ADD_KEYS 自动生成，杜绝“默认值和键表不一致”这类事故
function buildModifierDefaults() {
  const out = {};
  for (const group of GROUP_ORDER) {
    out[group] = {};
    for (const key of MUL_KEYS[group]) out[group][key] = 1;
    for (const key of ADD_KEYS[group]) out[group][key] = 0;
  }
  return out;
}

// 唯一契约：modifiers 的规范零值对象（深冻结，谁也别想改）
export const MODIFIER_DEFAULTS = deepFreeze(buildModifierDefaults());

// 乘算键叠层：base^stacks（两层 +18% = 1.18 * 1.18）
function mulPer(base, stacks) {
  return Math.pow(base, stacks);
}

// 加算键叠层：线性叠加
function addPer(step, stacks) {
  return step * stacks;
}

// 兜底：任何改动都不能让数值变成 NaN/Infinity 污染消费者
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export const UPGRADES = deepFreeze({
  // ---------------------------------------------------------------- 机动 22 件
  slide_servo: {
    id: 'slide_servo',
    name: '滑铲伺服缸',
    desc: '+18% 滑铲初速',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['friction_pad', 'slide_reaper'],
    apply: (stacks) => ({ move: { slideSpeedMul: mulPer(1.18, stacks) } }),
  },
  friction_pad: {
    id: 'friction_pad',
    name: '低阻合金滑板',
    desc: '-14% 滑铲摩擦，滑得更远',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['slide_servo', 'downhill_gyro'],
    apply: (stacks) => ({ move: { slideFrictionMul: mulPer(0.86, stacks) } }),
  },
  downhill_gyro: {
    id: 'downhill_gyro',
    name: '下坡陀螺仪',
    desc: '+25% 下坡加速',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['slide_servo', 'friction_pad'],
    apply: (stacks) => ({ move: { slideDownhillMul: mulPer(1.25, stacks) } }),
  },
  wallrun_capacitor: {
    id: 'wallrun_capacitor',
    name: '蹬墙电容',
    desc: '+22% 蹬墙跑时长',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['mag_clamp', 'walljump_piston'],
    apply: (stacks) => ({ move: { wallRunTimeMul: mulPer(1.22, stacks) } }),
  },
  mag_clamp: {
    id: 'mag_clamp',
    name: '磁力贴墙夹',
    desc: '+30% 贴墙吸附力',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['wallrun_capacitor', 'walljump_piston'],
    apply: (stacks) => ({ move: { wallRunStickMul: mulPer(1.3, stacks) } }),
  },
  walljump_piston: {
    id: 'walljump_piston',
    name: '蹬墙跳活塞',
    desc: '+18% 蹬墙跳推力',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['move'],
    synergy: ['wallrun_capacitor', 'air_thruster'],
    apply: (stacks) => ({ move: { wallJumpMul: mulPer(1.18, stacks) } }),
  },
  climb_actuator: {
    id: 'climb_actuator',
    name: '攀爬作动器',
    desc: '+20% 墙爬速度',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['wallrun_capacitor', 'mag_clamp'],
    apply: (stacks) => ({ move: { wallClimbSpeedMul: mulPer(1.2, stacks) } }),
  },
  grapple_winch: {
    id: 'grapple_winch',
    name: '抓钩绞盘',
    desc: '+20% 抓钩射程',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['grapple_servo'],
    apply: (stacks) => ({ move: { grappleRangeMul: mulPer(1.2, stacks) } }),
  },
  grapple_servo: {
    id: 'grapple_servo',
    name: '抓钩牵引伺服',
    desc: '+16% 抓钩牵引力',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['grapple_winch', 'air_gyro'],
    apply: (stacks) => ({ move: { grapplePullMul: mulPer(1.16, stacks) } }),
  },
  dash_cell: {
    id: 'dash_cell',
    name: '冲刺电池组',
    desc: '+1 冲刺次数',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['move'],
    synergy: ['dash_coolant', 'kill_dash_reset'],
    apply: (stacks) => ({ move: { dashChargesAdd: addPer(1, stacks) } }),
  },
  dash_coolant: {
    id: 'dash_coolant',
    name: '冲刺冷却剂',
    desc: '-14% 冲刺冷却',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['dash_cell', 'kill_dash_reset'],
    apply: (stacks) => ({ move: { dashCooldownMul: mulPer(0.86, stacks) } }),
  },
  jump_vent: {
    id: 'jump_vent',
    name: '二段跳喷口',
    desc: '+20% 二段跳高度',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['jump_servo', 'air_gyro'],
    apply: (stacks) => ({ move: { doubleJumpMul: mulPer(1.2, stacks) } }),
  },
  jump_servo: {
    id: 'jump_servo',
    name: '跳跃伺服',
    desc: '+12% 起跳初速',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['jump_vent', 'bunnyhop_spring'],
    apply: (stacks) => ({ move: { jumpVelMul: mulPer(1.12, stacks) } }),
  },
  air_gyro: {
    id: 'air_gyro',
    name: '空中陀螺稳定器',
    desc: '+18% 空中控制',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['air_thruster', 'move_brace'],
    apply: (stacks) => ({ move: { airControlMul: mulPer(1.18, stacks) } }),
  },
  air_thruster: {
    id: 'air_thruster',
    name: '空中推进器',
    desc: '+22% 空中加速',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['air_gyro', 'grav_damper'],
    apply: (stacks) => ({ move: { airAccelMul: mulPer(1.22, stacks) } }),
  },
  grav_damper: {
    id: 'grav_damper',
    name: '重力阻尼器',
    desc: '-12% 重力，滞空更久',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['move'],
    synergy: ['air_thruster', 'bunnyhop_spring'],
    apply: (stacks) => ({ move: { gravityMul: mulPer(0.88, stacks) } }),
  },
  overdrive_core: {
    id: 'overdrive_core',
    name: '超载核心',
    desc: '+15% 最大速度（走/跑同时生效）',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['move'],
    synergy: ['kinetic_converter', 'sprint_windup'],
    apply: (stacks) => {
      const mul = mulPer(1.15, stacks);
      return { move: { maxSpeedMul: mul, walkSpeedMul: mul, sprintSpeedMul: mul } };
    },
  },
  sprint_windup: {
    id: 'sprint_windup',
    name: '疾跑起爆器',
    desc: '-20% 疾跑加速时间',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['overdrive_core'],
    apply: (stacks) => ({ move: { sprintWindupMul: mulPer(0.8, stacks) } }),
  },
  bunnyhop_spring: {
    id: 'bunnyhop_spring',
    name: '连跳弹簧',
    desc: '+12% 落地速度保留',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['move'],
    synergy: ['grav_damper', 'impact_gel'],
    apply: (stacks) => ({ move: { bunnyHopMul: mulPer(1.12, stacks) } }),
  },
  step_actuator: {
    id: 'step_actuator',
    name: '台阶作动器',
    desc: '+0.18m 台阶高度，+20% 翻越速度',
    rarity: 'common',
    maxStacks: 6,
    tags: ['move'],
    synergy: ['climb_actuator'],
    apply: (stacks) => ({
      move: { stepHeightAdd: addPer(0.18, stacks), mantleSpeedMul: mulPer(1.2, stacks) },
    }),
  },
  impact_gel: {
    id: 'impact_gel',
    name: '落地缓冲凝胶',
    desc: '+35% 落地冲击抗性（叠满可免落地伤害）',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['move'],
    synergy: ['bunnyhop_spring'],
    apply: (stacks) => ({ move: { landImpactResistAdd: addPer(0.35, stacks) } }),
  },
  lightweight_frame: {
    id: 'lightweight_frame',
    name: '轻质骨架',
    desc: '+10% 移动速度，-15 最大生命',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['move', 'survival'],
    synergy: ['overdrive_core', 'hp_plating'],
    apply: (stacks) => ({
      move: { walkSpeedMul: mulPer(1.1, stacks), maxHealthAdd: addPer(-15, stacks) },
    }),
  },

  // ---------------------------------------------------------------- 武器 16 件
  damage_core: {
    id: 'damage_core',
    name: '弹头增压核心',
    desc: '+18% 武器伤害',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['hollow_point', 'headshot_optics'],
    apply: (stacks) => ({ weapon: { damageMul: mulPer(1.18, stacks) } }),
  },
  headshot_optics: {
    id: 'headshot_optics',
    name: '猎头光学组件',
    desc: '+25% 爆头伤害',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['damage_core', 'headhunter_med'],
    apply: (stacks) => ({ weapon: { damageHeadMul: mulPer(1.25, stacks) } }),
  },
  rpm_governor: {
    id: 'rpm_governor',
    name: '射速调速器',
    desc: '+12% 射速',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['mag_expander', 'overpressure'],
    apply: (stacks) => ({ weapon: { rpmMul: mulPer(1.12, stacks) } }),
  },
  mag_expander: {
    id: 'mag_expander',
    name: '弹匣扩容仓',
    desc: '+4 弹匣容量',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['reload_servo'],
    apply: (stacks) => ({ weapon: { magSizeAdd: addPer(4, stacks) } }),
  },
  reload_servo: {
    id: 'reload_servo',
    name: '快速换弹伺服',
    desc: '-14% 换弹时间',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['mag_expander', 'quick_switch'],
    apply: (stacks) => ({ weapon: { reloadTimeMul: mulPer(0.86, stacks) } }),
  },
  spread_stab: {
    id: 'spread_stab',
    name: '散布稳定器',
    desc: '-15% 散布',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['move_brace', 'recoil_comp'],
    apply: (stacks) => ({ weapon: { spreadMul: mulPer(0.85, stacks) } }),
  },
  recoil_comp: {
    id: 'recoil_comp',
    name: '后坐补偿器',
    desc: '-18% 后坐力',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['spread_stab', 'overpressure'],
    apply: (stacks) => ({ weapon: { recoilMul: mulPer(0.82, stacks) } }),
  },
  ads_actuator: {
    id: 'ads_actuator',
    name: '开镜作动器',
    desc: '-20% 开镜时间',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['spread_stab', 'first_shot'],
    apply: (stacks) => ({ weapon: { adsTimeMul: mulPer(0.8, stacks) } }),
  },
  penetrator: {
    id: 'penetrator',
    name: '穿甲弹芯',
    desc: '+1 子弹穿透',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['weapon'],
    synergy: ['damage_core', 'range_barrel'],
    apply: (stacks) => ({ weapon: { penetrationAdd: addPer(1, stacks) } }),
  },
  range_barrel: {
    id: 'range_barrel',
    name: '长管加速枪管',
    desc: '+20% 有效射程，+8% 远距伤害下限',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['damage_core', 'penetrator'],
    apply: (stacks) => ({
      weapon: { rangeMul: mulPer(1.2, stacks), falloffMinMul: mulPer(1.08, stacks) },
    }),
  },
  move_brace: {
    id: 'move_brace',
    name: '移动稳定支架',
    desc: '-25% 移动中射击散布',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['spread_stab', 'air_gyro'],
    apply: (stacks) => ({ weapon: { moveSpreadMul: mulPer(0.75, stacks) } }),
  },
  quick_switch: {
    id: 'quick_switch',
    name: '快速切枪机构',
    desc: '-18% 切枪时间',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['reload_servo'],
    apply: (stacks) => ({ weapon: { switchSpeedMul: mulPer(0.82, stacks) } }),
  },
  first_shot: {
    id: 'first_shot',
    name: '首发精度校准',
    desc: '-30% 首发散布',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['spread_stab', 'ads_actuator'],
    apply: (stacks) => ({ weapon: { firstShotSpreadMul: mulPer(0.7, stacks) } }),
  },
  hollow_point: {
    id: 'hollow_point',
    name: '空尖弹头',
    desc: '+12% 伤害，-10% 射程',
    rarity: 'common',
    maxStacks: 6,
    tags: ['weapon'],
    synergy: ['damage_core', 'headshot_optics'],
    apply: (stacks) => ({
      weapon: { damageMul: mulPer(1.12, stacks), rangeMul: mulPer(0.9, stacks) },
    }),
  },
  overpressure: {
    id: 'overpressure',
    name: '过压装药',
    desc: '+15% 射速，+12% 后坐力',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['weapon'],
    synergy: ['rpm_governor', 'recoil_comp'],
    apply: (stacks) => ({
      weapon: { rpmMul: mulPer(1.15, stacks), recoilMul: mulPer(1.12, stacks) },
    }),
  },
  glass_cannon: {
    id: 'glass_cannon',
    name: '玻璃炮协议',
    desc: '+25% 伤害，-20 最大护盾',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['weapon', 'survival'],
    synergy: ['damage_core', 'shield_cap'],
    apply: (stacks) => ({
      weapon: { damageMul: mulPer(1.25, stacks) },
      move: { maxShieldAdd: addPer(-20, stacks) },
    }),
  },

  // ---------------------------------------------------------------- 生存 9 件
  hp_plating: {
    id: 'hp_plating',
    name: '生命镀层',
    desc: '+20 最大生命',
    rarity: 'common',
    maxStacks: 6,
    tags: ['survival'],
    synergy: ['last_stand', 'lifesteal_core'],
    apply: (stacks) => ({ move: { maxHealthAdd: addPer(20, stacks) } }),
  },
  shield_cap: {
    id: 'shield_cap',
    name: '护盾电容组',
    desc: '+25 最大护盾',
    rarity: 'common',
    maxStacks: 6,
    tags: ['survival'],
    synergy: ['shield_regen', 'shield_delay'],
    apply: (stacks) => ({ move: { maxShieldAdd: addPer(25, stacks) } }),
  },
  shield_regen: {
    id: 'shield_regen',
    name: '护盾再生器',
    desc: '+25% 护盾恢复速度',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['survival'],
    synergy: ['shield_delay', 'shield_cap'],
    apply: (stacks) => ({ move: { shieldRegenRateMul: mulPer(1.25, stacks) } }),
  },
  shield_delay: {
    id: 'shield_delay',
    name: '护盾快启模块',
    desc: '-18% 护盾恢复延迟',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['survival'],
    synergy: ['shield_regen', 'shield_cap'],
    apply: (stacks) => ({ move: { shieldRegenDelayMul: mulPer(0.82, stacks) } }),
  },
  lifesteal_core: {
    id: 'lifesteal_core',
    name: '汲血核心',
    desc: '每次击杀回复 6 生命',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['survival'],
    synergy: ['slide_reaper', 'headhunter_med'],
    apply: (stacks) => ({ move: { lifestealOnKillAdd: addPer(6, stacks) } }),
  },
  headhunter_med: {
    id: 'headhunter_med',
    name: '猎头医疗包',
    desc: '爆头击杀额外回复 12 生命',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['survival', 'weapon'],
    synergy: ['headshot_optics', 'lifesteal_core'],
    apply: (stacks) => ({ move: { healOnHeadshotKillAdd: addPer(12, stacks) } }),
  },
  last_stand: {
    id: 'last_stand',
    name: '绝境装甲',
    desc: '生命低于 35% 时 +18% 伤害抗性',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['survival'],
    synergy: ['hp_plating', 'thorns_hull'],
    apply: (stacks) => ({ move: { lowHpDamageResistAdd: addPer(0.18, stacks) } }),
  },
  phoenix_cell: {
    id: 'phoenix_cell',
    name: '不死鸟电芯',
    desc: '获得 1 次致死免疫（90 秒冷却），每多 1 层冷却 -15%',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['survival', 'mech'],
    synergy: ['last_stand', 'hp_plating'],
    apply: (stacks) => ({
      move: {
        cheatDeathAdd: Math.min(1, stacks),
        cheatDeathCooldownMul: mulPer(0.85, Math.max(0, stacks - 1)),
      },
    }),
  },
  slide_reaper: {
    id: 'slide_reaper',
    name: '滑铲收割者',
    desc: '滑铲击杀回复 10 生命',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['survival', 'move'],
    synergy: ['slide_servo', 'lifesteal_core'],
    apply: (stacks) => ({ move: { healthOnSlideKillAdd: addPer(10, stacks) } }),
  },

  // ---------------------------------------------------------------- 机制 14 件
  kill_dash_reset: {
    id: 'kill_dash_reset',
    name: '击杀刷新回路',
    desc: '击杀立即刷新 1 次冲刺',
    rarity: 'epic',
    maxStacks: 1,
    tags: ['mech', 'move'],
    synergy: ['dash_cell', 'dash_coolant'],
    apply: (stacks) => ({ move: { dashResetOnKillAdd: addPer(1, stacks) } }),
  },
  ammo_siphon: {
    id: 'ammo_siphon',
    name: '弹药虹吸器',
    desc: '爆头命中回 2 发备弹',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech', 'weapon'],
    synergy: ['first_shot', 'headshot_optics'],
    apply: (stacks) => ({ weapon: { ammoRefundOnHeadshotAdd: addPer(2, stacks) } }),
  },
  kill_combo: {
    id: 'kill_combo',
    name: '连杀算力核心',
    desc: '每次击杀 +6% 伤害，最多 5 层，窗口 4 秒',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['mech', 'weapon'],
    synergy: ['rpm_governor', 'damage_core'],
    apply: (stacks) => ({
      weapon: {
        comboDamagePerKillAdd: addPer(0.06, stacks),
        comboMaxAdd: addPer(5, stacks),
        comboWindowAdd: addPer(4, stacks),
      },
    }),
  },
  crit_matrix: {
    id: 'crit_matrix',
    name: '暴击矩阵',
    desc: '+12% 暴击率，+10% 暴击伤害',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech', 'weapon'],
    synergy: ['rpm_governor', 'headshot_optics'],
    apply: (stacks) => ({
      weapon: { critChanceAdd: addPer(0.12, stacks), critDamageMul: mulPer(1.1, stacks) },
    }),
  },
  explosive_rounds: {
    id: 'explosive_rounds',
    name: '爆裂弹头',
    desc: '命中触发 1 级爆炸（半径 2m）',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['mech', 'weapon'],
    synergy: ['damage_core', 'chain_arc'],
    apply: (stacks) => ({ weapon: { explosiveRoundsAdd: addPer(1, stacks) } }),
  },
  chain_arc: {
    id: 'chain_arc',
    name: '链式电弧',
    desc: '+1 连锁闪电目标',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['mech', 'weapon'],
    synergy: ['explosive_rounds', 'crit_matrix'],
    apply: (stacks) => ({ weapon: { chainLightningAdd: addPer(1, stacks) } }),
  },
  cryo_tip: {
    id: 'cryo_tip',
    name: '低温弹尖',
    desc: '命中减速 18%，持续 1.5 秒',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['mech', 'weapon'],
    synergy: ['bleed_serration', 'chain_arc'],
    apply: (stacks) => ({ weapon: { slowOnHitAdd: addPer(0.18, stacks) } }),
  },
  bleed_serration: {
    id: 'bleed_serration',
    name: '放血锯齿',
    desc: '命中造成 4/秒 流血，持续 3 秒',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech', 'weapon'],
    synergy: ['cryo_tip', 'rpm_governor'],
    apply: (stacks) => ({ weapon: { bleedDotAdd: addPer(4, stacks) } }),
  },
  thorns_hull: {
    id: 'thorns_hull',
    name: '荆棘外壳',
    desc: '受击反弹 12 伤害',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech', 'survival'],
    synergy: ['last_stand', 'hp_plating'],
    apply: (stacks) => ({ move: { thornsAdd: addPer(12, stacks) } }),
  },
  kinetic_converter: {
    id: 'kinetic_converter',
    name: '动能转换器',
    desc: '移速转化为伤害，每层上限 +10%（最多 +30%）',
    rarity: 'legendary',
    maxStacks: 3,
    tags: ['mech', 'weapon'],
    synergy: ['overdrive_core', 'momentum_governor'],
    apply: (stacks) => ({ weapon: { speedToDamageAdd: addPer(0.1, stacks) } }),
  },
  momentum_governor: {
    id: 'momentum_governor',
    name: '动量调速器',
    desc: '移速转化为射速，每层 +8%',
    rarity: 'epic',
    maxStacks: 4,
    tags: ['mech', 'weapon'],
    synergy: ['overdrive_core', 'kinetic_converter'],
    apply: (stacks) => ({ weapon: { momentumFireRateAdd: addPer(0.08, stacks) } }),
  },
  scavenger_magnet: {
    id: 'scavenger_magnet',
    name: '拾荒磁力场',
    desc: '+20% 合金拾取',
    rarity: 'common',
    maxStacks: 6,
    tags: ['mech'],
    synergy: ['lucky_charm', 'bulk_discount'],
    apply: (stacks) => ({ meta: { alloyFindMul: mulPer(1.2, stacks) } }),
  },
  lucky_charm: {
    id: 'lucky_charm',
    name: '幸运齿轮',
    desc: '+8% 幸运（提高高稀有度改件出现率）',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech'],
    synergy: ['scavenger_magnet', 'bulk_discount'],
    apply: (stacks) => ({ meta: { luckAdd: addPer(0.08, stacks) } }),
  },
  bulk_discount: {
    id: 'bulk_discount',
    name: '批量采购协议',
    desc: '-6% 补给站价格',
    rarity: 'rare',
    maxStacks: 5,
    tags: ['mech'],
    synergy: ['scavenger_magnet', 'lucky_charm'],
    apply: (stacks) => ({ meta: { priceMul: mulPer(0.94, stacks) } }),
  },
});

const MAX_OFFERS = 6;            // 一次最多陈列几个改件（HUD 是三选一，留出余量）
const BASE_PRICE = 50;           // 通用改件基准价，稀有度乘 RARITIES[x].priceMul
const LUCK_BIAS = { common: 0, rare: 1, epic: 2, legendary: 3 };  // 幸运对稀有度的放大斜率

// 软保底：出现过但没买的改件，权重乘 1/(1+出现次数)。
// 刻意用“调和衰减”而不是指数衰减：指数衰减（0.5^n）在长期会把所有改件的出现率拉平，
// 把稀有度权重排序彻底抹掉（实测 common 反而少于 rare）；调和衰减的稳态出现次数 ∝ 权重，
// 既能给货架新鲜感，又能保住“通用多、传说少”的稀有度手感。
function pityMul(seen) {
  return 1 / (1 + seen);
}
const BASE_CHEAT_DEATH_CD = 90;  // 不死鸟基础冷却（秒），仅用于 HUD 展示

export class UpgradeSystem {
  constructor(player = null, weapons = null, opts = {}) {
    this.player = player;
    this.weapons = weapons;

    this._rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

    this.baseRerollCost = Math.max(0, num(opts.baseRerollCost, 60));
    this.rerollGrowth = Math.max(1, num(opts.rerollGrowth, 1.75));
    this.baseFreeRolls = Math.max(0, Math.floor(num(opts.freeRolls, 1)));
    // 游戏可选择“免费强化”模式：保留报价/稀有度信息，但购买与刷新不扣合金。
    // 默认仍为原经济规则，便于录像/单元测试与外部调用保持兼容。
    this.freeUpgrades = opts.freeUpgrades === true;
    this.offerCount = Math.max(1, Math.min(MAX_OFFERS, Math.floor(num(opts.offerCount, 3))));
    this.guaranteeChance = Math.min(1, Math.max(0, num(opts.guaranteeChance, 0.6)));
    this.tier = Math.max(1, Math.floor(num(opts.tier, 1)));

    this.alloy = Math.max(0, num(opts.alloy, 0));
    this.rerollCost = this.baseRerollCost;
    this.freeRolls = this.baseFreeRolls;
    this.stationIndex = 0;
    this.invalidKeyCount = 0;
    this.cheatDeathCooldown = BASE_CHEAT_DEATH_CD;   // 供 HUD 读取（乘 cheatDeathCooldownMul 由 player 决定）

    this._owned = new Map();        // id -> stacks（Map 插入顺序 = 购买顺序，确定性）
    this._offerCounts = new Map();  // id -> 已出现但未购买次数（软保底用）
    this._offers = [];
    this._modifiers = this._computeModifiers();
    // 构造即推送一份“零改件”基准：消费者不需要自带默认值
    this._applyToConsumers(this._modifiers);
  }

  // ------------------------------------------------------------ 对外状态

  get modifiers() {
    // 防御性拷贝：外部（HUD/调试）拿到的东西永远改不脏内部状态
    return cloneModifiers(this._modifiers);
  }

  get owned() {
    const list = [];
    for (const [id, stacks] of this._owned) list.push({ id, stacks });
    return list;
  }

  // 存读档 / 录像回放：允许从 JSON 还原改件（非法 id 丢弃，层数夹紧到 maxStacks）
  set owned(list) {
    this._owned.clear();
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (!entry || typeof entry.id !== 'string') continue;
        const def = UPGRADES[entry.id];
        if (!def) continue;
        const stacks = Math.max(0, Math.min(def.maxStacks, Math.floor(num(entry.stacks, 0))));
        if (stacks > 0) this._owned.set(def.id, stacks);
      }
    }
    this.applyAll();
  }

  debugState() {
    return {
      alloy: this.alloy,
      ownedCount: this._owned.size,          // 已拥有改件种类数
      ownedStacks: this._ownedStacks(),      // 已拥有总层数（额外字段，便于调试）
      offerCount: this._offers.length,
      rerollCost: this.rerollCost,
      freeRolls: this.freeRolls,
      freeUpgrades: this.freeUpgrades,
      modifierKeys: this.modifierKeys(),     // 'move.walkSpeedMul' 形式的键名数组
      invalidKeyCount: this.invalidKeyCount,
    };
  }

  modifierKeys() {
    const keys = [];
    for (const group of GROUP_ORDER) {
      for (const key of Object.keys(MODIFIER_DEFAULTS[group])) keys.push(`${group}.${key}`);
    }
    return keys;
  }

  // ------------------------------------------------------------ 经济

  addAlloy(n) {
    const amount = num(n, 0);
    if (amount > 0) {
      this.alloy += amount;
      this._refreshLocked();   // 钱变多了，货架上买得起的东西要解锁
    }
    return this.alloy;
  }

  spend(n) {
    const amount = num(n, 0);
    if (amount < 0 || this.alloy < amount) return false;
    this.alloy -= amount;
    this._refreshLocked();
    return true;
  }

  // ------------------------------------------------------------ 抽取

  // 打开一个新的补给站：重新陈列，并重置本轮 reroll 行情（免费次数 + 起始价）
  rollOffers(count = this.offerCount, rng) {
    const r = this._resolveRng(rng);
    this.stationIndex += 1;
    this.rerollCost = this.baseRerollCost;
    this.freeRolls = this.baseFreeRolls;
    this._offers = this._generate(count, r);
    this._emit('upgrade:offer', { offers: this._offers });
    return this._offers;
  }

  // 刷新货架：游戏免费模式直接换新；默认经济模式仍按免费次数/价格执行。
  reroll(rng) {
    const r = this._resolveRng(rng);
    if (this.freeUpgrades) {
      this._offers = this._generate(this.offerCount, r);
      this._emit('upgrade:offer', { offers: this._offers });
      return this._offers;
    }
    if (this.freeRolls > 0) {
      this.freeRolls -= 1;
    } else {
      if (this.alloy < this.rerollCost) return this._offers;   // 合金不足：货架保持不变，也不涨价
      this.alloy -= this.rerollCost;
      this.rerollCost = Math.round(this.rerollCost * this.rerollGrowth);
    }
    this._offers = this._generate(this.offerCount, r);
    this._emit('upgrade:offer', { offers: this._offers });
    return this._offers;
  }

  // 购买：从货架上取走该改件，免费模式不扣合金；随后叠层并重算 modifiers。
  pick(id) {
    let index = -1;
    for (let i = 0; i < this._offers.length; i++) {
      if (this._offers[i].id === id) { index = i; break; }
    }
    if (index < 0) return false;                       // 不在货架上（已买过 / 不是本期货）
    const offer = this._offers[index];
    const stacks = this._owned.get(id) || 0;
    if (stacks >= offer.def.maxStacks) return false;   // 已满层
    if (!this.freeUpgrades && this.alloy < offer.price) return false; // 免费模式不检查余额
    if (!this.freeUpgrades) this.alloy -= offer.price;
    this._owned.set(id, stacks + 1);
    this._offerCounts.delete(id);                      // 买到了，软保底计数清零
    this._offers.splice(index, 1);                     // 货架上的这一格被取走
    this._refreshLocked();
    this.applyAll();
    this._emit('upgrade:picked', { id });
    return true;
  }

  // ------------------------------------------------------------ 修正值计算

  // 重新计算并把**全新**的 modifiers 推给两个消费者（调用频率很低：购买/重置/读档）
  applyAll() {
    this._applyToConsumers(this._computeModifiers());
  }

  reset(options = {}) {
    this._owned.clear();
    this._offerCounts.clear();
    this._offers = [];
    this.rerollCost = this.baseRerollCost;
    this.freeRolls = this.baseFreeRolls;
    this.stationIndex = 0;
    if (!options.keepAlloy) this.alloy = 0;
    this.applyAll();
  }

  // ------------------------------------------------------------ 内部实现

  _resolveRng(rng) {
    return typeof rng === 'function' ? rng : this._rng;
  }

  _ownedStacks() {
    let total = 0;
    for (const stacks of this._owned.values()) total += stacks;
    return total;
  }

  // 契约事件广播：走 core/events.js 总线，同时保留 opts.onEvent 直连钩子（便于单元测试/回放）
  _emit(type, payload) {
    emit(type, payload);
    if (this.onEvent) this.onEvent(type, payload);
  }

  _refreshLocked() {
    for (const offer of this._offers) offer.locked = offer.price > this.alloy;
  }

  // 组装候选池：排除已满层的改件；池空则说明这一局已经刷无可刷
  _eligiblePool() {
    const pool = [];
    for (const id of Object.keys(UPGRADES)) {
      const def = UPGRADES[id];
      const stacks = this._owned.get(id) || 0;
      if (stacks >= def.maxStacks) continue;
      pool.push(def);
    }
    return pool;
  }

  // 权重 = 稀有度基础权重 * 软保底衰减 * 幸运加成
  _weightOf(def, luck) {
    const rarity = RARITIES[def.rarity];
    const seen = this._offerCounts.get(def.id) || 0;
    const pity = pityMul(seen);
    const luckMul = 1 + luck * LUCK_BIAS[def.rarity];
    const weight = rarity.weight * pity * luckMul;
    return weight > 0 ? weight : 0;
  }

  _weightedPick(list, luck, rng) {
    if (list.length === 0) return null;
    let total = 0;
    for (const def of list) total += this._weightOf(def, luck);
    if (total <= 0) return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
    let roll = rng() * total;
    for (const def of list) {
      roll -= this._weightOf(def, luck);
      if (roll <= 0) return def;
    }
    return list[list.length - 1];
  }

  // 玩家投入最深的标签（按层数加权），用于“构筑向心力”：保证货架上有能接着搭的改件
  _investedTag() {
    if (this._owned.size === 0) return null;
    const score = { move: 0, weapon: 0, survival: 0, mech: 0 };
    for (const [id, stacks] of this._owned) {
      const def = UPGRADES[id];
      if (!def) continue;
      for (const tag of def.tags) score[tag] += stacks;
    }
    let best = null;
    let bestScore = 0;
    for (const tag of TAG_ORDER) {          // 固定顺序 = 平票时确定性取舍
      if (score[tag] > bestScore) { bestScore = score[tag]; best = tag; }
    }
    return best;
  }

  _generate(count, rng) {
    const size = Math.max(0, Math.min(MAX_OFFERS, Math.floor(num(count, this.offerCount))));
    if (size === 0) return [];
    const pool = this._eligiblePool();
    if (pool.length === 0) return [];

    const luck = this._modifiers.meta.luckAdd;
    const chosen = [];
    const used = new Set();

    // 约 60% 概率把第一格留给“已投入标签”，让构筑能滚雪球；否则纯随机
    const invested = this._investedTag();
    if (invested && rng() < this.guaranteeChance) {
      const tagPool = pool.filter((def) => def.tags.indexOf(invested) >= 0);
      if (tagPool.length > 0) {
        const def = this._weightedPick(tagPool, luck, rng);
        if (def) { chosen.push(def); used.add(def.id); }
      }
    }

    while (chosen.length < size) {
      const candidates = pool.filter((def) => !used.has(def.id));
      if (candidates.length === 0) break;      // 池子刷干：宁少不重复
      // 用专门的排除式抽取，让加权路径和回退路径都只在未选候选内运行；
      // 只要 eligible pool 足够，货架就一定能填满请求的槽位。
      const picked = this._pickExcluding(candidates, luck, rng, used);
      if (!picked) break;
      chosen.push(picked);
      used.add(picked.id);
    }

    const offers = [];
    for (const def of chosen) offers.push(this._makeOffer(def, rng));
    for (const offer of offers) {
      // 未购买即计入软保底：下次它出现的权重减半，保证货架有新鲜感
      this._offerCounts.set(offer.id, (this._offerCounts.get(offer.id) || 0) + 1);
    }
    return offers;
  }

  /**
   * 从候选里按权重抽一个，并保证不与 used 重复。
   * 抽取失败时回退到未使用候选中的均匀随机，因此循环一定能推进。
   */
  _pickExcluding(candidates, luck, rng, used) {
    if (candidates.length === 0) return null;
    let total = 0;
    for (let i = 0; i < candidates.length; i++) total += this._weightOf(candidates[i], luck);
    if (total > 0) {
      let roll = rng() * total;
      for (let i = 0; i < candidates.length; i++) {
        roll -= this._weightOf(candidates[i], luck);
        if (roll <= 0) {
          const c = candidates[i];
          if (!used.has(c.id)) return c;
        }
      }
    }
    // 回退：均匀挑一个未用过的（权重全为 0 或抽中了已用项时走这里）
    const fresh = candidates.filter((def) => !used.has(def.id));
    if (fresh.length === 0) return null;
    return fresh[Math.min(fresh.length - 1, Math.floor(rng() * fresh.length))];
  }

  _makeOffer(def, rng) {
    const rarity = RARITIES[def.rarity];
    const jitter = 0.92 + rng() * 0.16;                       // ±8% 行情抖动，同一个改件价格不是死的
    const tierScale = 1 + (this.tier - 1) * 0.12;             // 远征越深，物价越高
    const price = Math.max(1, Math.round(
      BASE_PRICE * rarity.priceMul * this._modifiers.meta.priceMul * jitter * tierScale,
    ));
    // 游戏内免费强化模式仍保留稀有度与原始经济算法的确定性抽取，
    // 但对外报价明确为 0，避免 HUD/调试状态出现“显示收费、实际免费”的矛盾。
    if (this.freeUpgrades) return { id: def.id, def, rarity: def.rarity, price: 0, locked: false };
    return { id: def.id, def, rarity: def.rarity, price, locked: price > this.alloy };
  }

  _computeModifiers() {
    const mods = {};
    for (const group of GROUP_ORDER) {
      mods[group] = {};
      const defaults = MODIFIER_DEFAULTS[group];
      for (const key of Object.keys(defaults)) mods[group][key] = defaults[key];
    }

    for (const [id, stacks] of this._owned) {
      const def = UPGRADES[id];
      if (!def || stacks <= 0) continue;
      const patch = def.apply(stacks);
      if (!patch) continue;
      for (const group of GROUP_ORDER) {
        const groupPatch = patch[group];
        if (!groupPatch) continue;
        for (const key of Object.keys(groupPatch)) {
          const value = groupPatch[key];
          if (!Number.isFinite(value)) { this.invalidKeyCount += 1; continue; }
          if (MUL_KEYS[group].has(key)) mods[group][key] *= value;         // 乘算：多来源相乘
          else if (ADD_KEYS[group].has(key)) mods[group][key] += value;    // 加算：多来源相加
          else this.invalidKeyCount += 1;                                  // 未登记键：绝不写进 modifiers
        }
      }
    }
    return mods;
  }

  _applyToConsumers(mods) {
    this._modifiers = mods;
    // 各推一份独立拷贝：player 与 weapons 之间不可能通过共享引用互相污染
    if (this.player && typeof this.player.setModifiers === 'function') {
      this.player.setModifiers(cloneModifiers(mods));
    }
    if (this.weapons && typeof this.weapons.addModifiers === 'function') {
      this.weapons.addModifiers(cloneModifiers(mods));
    }
  }
}

// 逐组逐键浅拷贝即可（值都是 number）
function cloneModifiers(mods) {
  const out = {};
  for (const group of GROUP_ORDER) {
    const src = mods[group];
    const dst = {};
    if (src) for (const key of Object.keys(src)) dst[key] = src[key];
    out[group] = dst;
  }
  return out;
}
