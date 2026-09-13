// ==== test-upgrades.mjs — upgrades.js 的无 DOM 自检（在项目根目录运行：node tools/test-upgrades.mjs）====
// 覆盖：改件定义合法性、抽取良构性/多样性/软保底、200 次购买与叠层、修正值合并语义、
//       合金经济（含 reroll 涨价与买不起的拒绝路径）、reset 归零、owned 的 JSON 往返。
// 全部随机来自固定 seed 的 mulberry32，因此本测试是确定性的：同样输入永远同样结果。

import {
  UPGRADES,
  UpgradeSystem,
  RARITIES,
  MODIFIER_DEFAULTS,
  MUL_KEYS,
  ADD_KEYS,
} from '../src/upgrades.js';
import { on, clear } from '../src/core/events.js';

const GROUPS = ['move', 'weapon', 'meta'];
const TAGS = ['move', 'weapon', 'survival', 'mech'];

// ---------------------------------------------------------------- 测试骨架

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail = '') {
  const index = String(passed + failed + 1).padStart(2, '0');
  if (ok) {
    passed += 1;
    console.log(`PASS  ${index}  ${label}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`FAIL  ${index}  ${label}${detail ? '  — ' + detail : ''}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------- 工具

// 契约 core/math.js 里的同一个 PRNG，测试自带一份以保持零依赖
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function closeTo(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function modsClose(a, b, eps = 1e-9) {
  for (const g of GROUPS) {
    for (const k of Object.keys(MODIFIER_DEFAULTS[g])) {
      if (!closeTo(a[g][k], b[g][k], eps)) return false;
    }
  }
  return true;
}

// 记录消费者收到的最后一份 modifiers，并统计推送次数
function makePlayer() {
  return {
    lastMods: null,
    modCalls: 0,
    setModifiers(mods) {
      this.lastMods = mods;
      this.modCalls += 1;
    },
  };
}

function makeWeapons() {
  return {
    lastMods: null,
    modCalls: 0,
    addModifiers(mods) {
      this.lastMods = mods;
      this.modCalls += 1;
    },
  };
}

function makeSystem(opts = {}) {
  const player = makePlayer();
  const weapons = makeWeapons();
  const sys = new UpgradeSystem(player, weapons, opts);
  return { sys, player, weapons };
}

// 反复开新货架直到目标改件出现（rollOffers 免费），用于“买到某个指定改件”
function rollUntilOffered(sys, id, rng, maxTries = 800) {
  for (let i = 0; i < maxTries; i++) {
    const offers = sys.rollOffers(3, rng);
    for (const offer of offers) if (offer.id === id) return offer;
  }
  return null;
}

function buyOne(sys, id, rng) {
  const offer = rollUntilOffered(sys, id, rng);
  if (!offer) return false;
  return sys.pick(id);
}

// ---------------------------------------------------------------- 1. 模块形态

section('1. 模块导出与改件定义');

check('导出 UPGRADES / UpgradeSystem / RARITIES / MODIFIER_DEFAULTS', Boolean(
  UPGRADES && typeof UpgradeSystem === 'function' && RARITIES && MODIFIER_DEFAULTS,
));

const rarityIds = Object.keys(RARITIES);
const RARITY_COLORS = {
  common: '#9aa7b4', rare: '#4aa3ff', epic: '#b06bff', legendary: '#ffb03a',
};
let rarityOk = deepEqual(rarityIds.slice().sort(), ['common', 'epic', 'legendary', 'rare']);
let rarityDetail = '';
for (const id of rarityIds) {
  const r = RARITIES[id];
  if (!r || typeof r.name !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.color)) {
    rarityOk = false;
    rarityDetail = `${id} 字段缺失`;
  } else if (r.color !== RARITY_COLORS[id]) {
    rarityOk = false;
    rarityDetail = `${id} 颜色 ${r.color} != 契约 ${RARITY_COLORS[id]}`;
  } else if (!(r.weight > 0) || !(r.priceMul > 0)) {
    rarityOk = false;
    rarityDetail = `${id} 权重/价格倍率非法`;
  }
}
check('RARITIES 四档、颜色符合契约、weight/priceMul 均为正', rarityOk, rarityDetail || rarityIds.join('/'));

const upgradeIds = Object.keys(UPGRADES);
check('改件数量 ≥ 30（契约要求 ≥ 24）', upgradeIds.length >= 30, `${upgradeIds.length} 件`);

const idUnique = new Set(upgradeIds).size === upgradeIds.length;
const idMatchBad = [];
for (const key of upgradeIds) {
  if (UPGRADES[key].id !== key) idMatchBad.push(key);
}
check('改件 id 唯一且 def.id 与键名一致', idUnique && idMatchBad.length === 0,
  idMatchBad.length ? `不一致: ${idMatchBad.join(',')}` : `${upgradeIds.length} 个唯一 id`);

const tagCount = { move: 0, weapon: 0, survival: 0, mech: 0 };
const defProblems = [];
for (const key of upgradeIds) {
  const def = UPGRADES[key];
  const where = `[${key}]`;
  if (typeof def.name !== 'string' || !/[\u4e00-\u9fa5]/.test(def.name)) defProblems.push(`${where} name 非中文`);
  if (typeof def.desc !== 'string' || !/[\u4e00-\u9fa5]/.test(def.desc) || !/\d/.test(def.desc)) {
    defProblems.push(`${where} desc 缺少中文或具体数值`);
  }
  if (!RARITIES[def.rarity]) defProblems.push(`${where} rarity 非法: ${def.rarity}`);
  if (!Number.isInteger(def.maxStacks) || def.maxStacks < 1) defProblems.push(`${where} maxStacks 非法`);
  if (!Array.isArray(def.tags) || def.tags.length === 0) {
    defProblems.push(`${where} tags 为空`);
  } else {
    for (const t of def.tags) {
      if (TAGS.indexOf(t) < 0) defProblems.push(`${where} 未知 tag: ${t}`);
      else tagCount[t] += 1;
    }
  }
  if (!Array.isArray(def.synergy)) {
    defProblems.push(`${where} synergy 不是数组`);
  } else {
    for (const s of def.synergy) {
      if (s === key) defProblems.push(`${where} synergy 指向自己`);
      else if (!UPGRADES[s]) defProblems.push(`${where} synergy 指向不存在的 ${s}`);
    }
  }
  if (typeof def.apply !== 'function') defProblems.push(`${where} apply 不是函数`);
}
check('每个改件的 name/desc/rarity/maxStacks/tags/synergy/apply 均合规', defProblems.length === 0,
  defProblems.length ? defProblems.slice(0, 4).join(' | ') : `${upgradeIds.length} 件全部合规`);

check('四类 tag（机动/武器/生存/机制）都有改件覆盖', TAGS.every((t) => tagCount[t] > 0),
  TAGS.map((t) => `${t}:${tagCount[t]}`).join('  '));

// ---------------------------------------------------------------- 2. 修正值契约

section('2. MODIFIER_DEFAULTS / MUL_KEYS / ADD_KEYS 契约');

const deepFrozen = Object.isFrozen(MODIFIER_DEFAULTS)
  && GROUPS.every((g) => Object.isFrozen(MODIFIER_DEFAULTS[g]));
let frozenThrew = false;
try {
  MODIFIER_DEFAULTS.move.walkSpeedMul = 99;
} catch (err) {
  frozenThrew = true;
}
check('MODIFIER_DEFAULTS 深冻结且写入抛错', deepFrozen && frozenThrew && MODIFIER_DEFAULTS.move.walkSpeedMul === 1);

const overlap = [];
const union = new Set();
const mulBad = [];
const addBad = [];
for (const g of GROUPS) {
  for (const k of MUL_KEYS[g]) {
    union.add(`${g}.${k}`);
    if (ADD_KEYS[g].has(k)) overlap.push(`${g}.${k}`);
    if (MODIFIER_DEFAULTS[g][k] !== 1) mulBad.push(`${g}.${k}=${MODIFIER_DEFAULTS[g][k]}`);
  }
  for (const k of ADD_KEYS[g]) {
    union.add(`${g}.${k}`);
    if (MODIFIER_DEFAULTS[g][k] !== 0) addBad.push(`${g}.${k}=${MODIFIER_DEFAULTS[g][k]}`);
  }
}
check('MUL_KEYS 与 ADD_KEYS 不重叠', overlap.length === 0, overlap.join(','));
check('MUL_KEYS 默认值全为 1', mulBad.length === 0, mulBad.slice(0, 4).join(','));
check('ADD_KEYS 默认值全为 0', addBad.length === 0, addBad.slice(0, 4).join(','));

const defaultKeys = new Set();
for (const g of GROUPS) for (const k of Object.keys(MODIFIER_DEFAULTS[g])) defaultKeys.add(`${g}.${k}`);
const unionMatches = union.size === defaultKeys.size && [...union].every((k) => defaultKeys.has(k));
check('键表并集与 MODIFIER_DEFAULTS 严格 key-for-key 一致', unionMatches, `${union.size} keys`);

// apply() 只允许产出已登记的键
const applyProblems = [];
const producedKeys = new Set();
for (const key of upgradeIds) {
  const def = UPGRADES[key];
  for (let s = 1; s <= def.maxStacks; s++) {
    const patch = def.apply(s);
    if (!patch || typeof patch !== 'object') {
      applyProblems.push(`${key}@${s} 未返回对象`);
      continue;
    }
    for (const g of Object.keys(patch)) {
      if (GROUPS.indexOf(g) < 0) {
        applyProblems.push(`${key}@${s} 未知分组 ${g}`);
        continue;
      }
      const gp = patch[g];
      if (!gp) continue;
      for (const k of Object.keys(gp)) {
        const path = `${g}.${k}`;
        producedKeys.add(path);
        const value = gp[k];
        if (!defaultKeys.has(path)) applyProblems.push(`${key}@${s} 产出未登记键 ${path}`);
        else if (!Number.isFinite(value)) applyProblems.push(`${key}@${s} ${path} 非有限数`);
        else if (MUL_KEYS[g].has(k) && !(value > 0)) applyProblems.push(`${key}@${s} 乘算键 ${path}=${value} 必须 > 0`);
      }
    }
  }
}
check('所有 apply(1..maxStacks) 只返回 MODIFIER_DEFAULTS 中的键且数值合法',
  applyProblems.length === 0, applyProblems.slice(0, 4).join(' | ') || `${producedKeys.size} 个键被产出`);

const unusedKeys = [...defaultKeys].filter((k) => !producedKeys.has(k));
check('每个默认修正键都至少被一件改件产出', unusedKeys.length === 0, unusedKeys.join(','));

// 需求点名的机制覆盖：每个键都必须真的有改件提供
const REQUIRED = {
  '机动 (move)': [
    'move.slideSpeedMul', 'move.slideFrictionMul', 'move.slideDownhillMul', 'move.wallRunTimeMul',
    'move.wallRunStickMul', 'move.wallJumpMul', 'move.grappleRangeMul', 'move.grapplePullMul',
    'move.dashChargesAdd', 'move.dashCooldownMul', 'move.doubleJumpMul', 'move.airControlMul',
    'move.airAccelMul', 'move.gravityMul', 'move.maxSpeedMul', 'move.stepHeightAdd',
    'move.mantleSpeedMul', 'move.bunnyHopMul', 'move.landImpactResistAdd', 'move.sprintWindupMul',
  ],
  '武器 (weapon)': [
    'weapon.damageMul', 'weapon.damageHeadMul', 'weapon.rpmMul', 'weapon.magSizeAdd',
    'weapon.reloadTimeMul', 'weapon.spreadMul', 'weapon.recoilMul', 'weapon.adsTimeMul',
    'weapon.penetrationAdd', 'weapon.rangeMul', 'weapon.moveSpreadMul', 'weapon.switchSpeedMul',
    'weapon.firstShotSpreadMul',
  ],
  '生存 (survival)': [
    'move.maxHealthAdd', 'move.maxShieldAdd', 'move.shieldRegenRateMul', 'move.shieldRegenDelayMul',
    'move.lifestealOnKillAdd', 'move.healOnHeadshotKillAdd', 'move.lowHpDamageResistAdd',
    'move.cheatDeathAdd', 'move.healthOnSlideKillAdd',
  ],
  '机制 (mech)': [
    'move.dashResetOnKillAdd', 'weapon.ammoRefundOnHeadshotAdd', 'weapon.comboDamagePerKillAdd',
    'weapon.critChanceAdd', 'weapon.explosiveRoundsAdd', 'weapon.chainLightningAdd',
    'weapon.slowOnHitAdd', 'weapon.bleedDotAdd', 'move.thornsAdd', 'weapon.speedToDamageAdd',
    'weapon.momentumFireRateAdd', 'meta.alloyFindMul', 'meta.luckAdd', 'meta.priceMul',
  ],
};
for (const label of Object.keys(REQUIRED)) {
  const missing = REQUIRED[label].filter((k) => !producedKeys.has(k));
  check(`${label} 需求清单全部有改件支撑`, missing.length === 0,
    missing.length ? `缺少 ${missing.join(',')}` : `${REQUIRED[label].length} 项`);
}

// ---------------------------------------------------------------- 3. 抽取

section('3. rollOffers：良构性 / 多样性 / 软保底 / 确定性');

const rollRng = mulberry32(0x1f2e3d4c);
const rollCtx = makeSystem({ rng: rollRng });
const maxedId = 'kill_dash_reset';
rollCtx.sys.owned = [{ id: maxedId, stacks: UPGRADES[maxedId].maxStacks }];
const OFFER_COUNT = 3;
const ROLLS = 400;
let badLength = 0;
let badDuplicate = 0;
let badShape = 0;
let badPrice = 0;
let badLock = 0;
let maxedAppeared = 0;
const seenIds = new Set();
const seenRarities = new Set();
const firstShapeError = [];

for (let i = 0; i < ROLLS; i++) {
  const offers = rollCtx.sys.rollOffers(OFFER_COUNT, rollRng);
  if (!Array.isArray(offers) || offers.length < 1 || offers.length > OFFER_COUNT) badLength += 1;
  const ids = new Set();
  for (const offer of offers) {
    if (ids.has(offer.id)) badDuplicate += 1;
    ids.add(offer.id);
    const def = UPGRADES[offer.id];
    if (!def || offer.def !== def || offer.rarity !== def.rarity
      || typeof offer.locked !== 'boolean' || !Number.isInteger(offer.price)) {
      badShape += 1;
      if (firstShapeError.length < 3) firstShapeError.push(String(offer && offer.id));
    }
    if (!(offer.price > 0)) badPrice += 1;
    if (offer.locked !== (offer.price > rollCtx.sys.alloy)) badLock += 1;
    if (offer.id === maxedId) maxedAppeared += 1;
    seenIds.add(offer.id);
    seenRarities.add(offer.rarity);
  }
}
check(`400 次抽取每次都返回 1..${OFFER_COUNT} 个 offer`, badLength === 0, `异常 ${badLength} 次`);
check('400 次抽取每期内均无重复 id', badDuplicate === 0, `重复 ${badDuplicate} 次`);
check('每个 offer 形如 {id, def, rarity, price, locked} 且 def 引用正确', badShape === 0,
  firstShapeError.join(',') || `${ROLLS * OFFER_COUNT} 个 offer 全合规`);
check('价格恒为正整数（稀有度/折扣/行情抖动后仍合法）', badPrice === 0);
check('locked 恒等于“当前合金买不起”', badLock === 0);
check(`已满层改件不再出现在货架上（${maxedId}）`, maxedAppeared === 0, `出现 ${maxedAppeared} 次`);
check('抽取有足够多样性（400 期内出现 ≥ 20 种不同改件）', seenIds.size >= 20,
  `${seenIds.size}/${upgradeIds.length} 种`);
check('稀有度分布覆盖 ≥ 3 档', seenRarities.size >= 3, [...seenRarities].join('/'));

// 稀有度权重：低稀有度应显著多于传说
const rarityTally = {};
for (let i = 0; i < 2000; i++) {
  for (const offer of rollCtx.sys.rollOffers(3, mulberry32(1000 + i))) {
    rarityTally[offer.rarity] = (rarityTally[offer.rarity] || 0) + 1;
  }
}
check('稀有度权重生效：common 出现次数远多于 legendary',
  (rarityTally.common || 0) > (rarityTally.legendary || 0) * 4,
  Object.keys(rarityTally).map((k) => `${k}:${rarityTally[k]}`).join(' '));

// 构筑向心力：注入 rng 恒为 0 → 必然触发保底，第一格必须是已投入标签
const cohesionCtx = makeSystem({ rng: () => 0 });
cohesionCtx.sys.owned = [{ id: 'damage_core', stacks: 2 }];
const forced = cohesionCtx.sys.rollOffers(3, () => 0);
check('保底触发时货架上必有“已投入标签”的改件（rng=0 强制触发）',
  forced.length > 0 && forced[0].def.tags.indexOf('weapon') >= 0,
  forced.map((o) => `${o.id}[${o.def.tags.join('+')}]`).join(' '));

// 经验频率：应不低于 60% 下限，且高于关掉保底的基线
const EMPIRICAL = 400;
function cohesionRate(guarantee) {
  const ctx = makeSystem({ guaranteeChance: guarantee, rng: mulberry32(0x5eed) });
  ctx.sys.owned = [{ id: 'damage_core', stacks: 2 }];
  const rng = mulberry32(0xabc123);
  let hits = 0;
  for (let i = 0; i < EMPIRICAL; i++) {
    const offers = ctx.sys.rollOffers(3, rng);
    if (offers.some((o) => o.def.tags.indexOf('weapon') >= 0)) hits += 1;
  }
  return hits / EMPIRICAL;
}
const rateGuaranteed = cohesionRate(0.6);
const ratePlain = cohesionRate(0);
check(`构筑向心力出现率 ≥ 60%（实测 ${(rateGuaranteed * 100).toFixed(1)}%）`, rateGuaranteed >= 0.6);
check(`保底开关确实提升向心力（${(ratePlain * 100).toFixed(1)}% → ${(rateGuaranteed * 100).toFixed(1)}%）`,
  rateGuaranteed > ratePlain);

// count 夹紧 + 候选池刷干时不重复
const clampCtx = makeSystem({ rng: mulberry32(11) });
const many = clampCtx.sys.rollOffers(99, mulberry32(12));
check('rollOffers(count) 上限被夹紧且无重复', many.length >= 3 && many.length <= 8
  && new Set(many.map((o) => o.id)).size === many.length, `${many.length} 个`);

const dryCtx = makeSystem({ rng: mulberry32(13) });
const keepIds = upgradeIds.slice(0, 2);
dryCtx.sys.owned = upgradeIds.filter((id) => keepIds.indexOf(id) < 0)
  .map((id) => ({ id, stacks: UPGRADES[id].maxStacks }));
const dryOffers = dryCtx.sys.rollOffers(5, mulberry32(14));
check('候选池只剩 2 件时货架只给 2 件且不重复',
  dryOffers.length === 2 && new Set(dryOffers.map((o) => o.id)).size === 2,
  dryOffers.map((o) => o.id).join(','));

const emptyCtx = makeSystem({ rng: mulberry32(15) });
emptyCtx.sys.owned = upgradeIds.map((id) => ({ id, stacks: UPGRADES[id].maxStacks }));
const emptyOffers = emptyCtx.sys.rollOffers(3, mulberry32(16));
check('全部满层时返回空货架（不报错、不重复）', Array.isArray(emptyOffers) && emptyOffers.length === 0);
check('空货架上 pick 任何 id 都返回 false',
  emptyCtx.sys.pick(upgradeIds[0]) === false && emptyCtx.sys.owned.length === upgradeIds.length);

// 确定性：同 seed 两套系统 50 期抽取完全一致
const detA = makeSystem({ rng: mulberry32(0xdeadbeef) });
const detB = makeSystem({ rng: mulberry32(0xdeadbeef) });
const seqA = [];
const seqB = [];
for (let i = 0; i < 50; i++) {
  for (const o of detA.sys.rollOffers(3, mulberry32(i + 7))) seqA.push(`${o.id}:${o.price}`);
  for (const o of detB.sys.rollOffers(3, mulberry32(i + 7))) seqB.push(`${o.id}:${o.price}`);
}
check('注入相同 rng 时抽取完全可复现（同 seed 同结果）', deepEqual(seqA, seqB), `${seqA.length} 条记录`);

// ---------------------------------------------------------------- 4. 购买与叠层

section('4. 购买 200 次：叠层 / owned 计数 / 消费者推送');

const buyRng = mulberry32(0x600df00d);
const buyCtx = makeSystem({ rng: buyRng, baseRerollCost: 60 });
const sys = buyCtx.sys;
const player = buyCtx.player;
const weapons = buyCtx.weapons;
sys.addAlloy(1e9);

const capacity = upgradeIds.reduce((sum, id) => sum + UPGRADES[id].maxStacks, 0);
check('总可叠层容量 ≥ 240（足够吃下 200 次购买）', capacity >= 240, `${capacity} 层`);

let offers = sys.rollOffers(3, buyRng);
let buyFailures = 0;
let ledgerErrors = 0;
let freshErrors = 0;
let contentErrors = 0;
let removalErrors = 0;
let bought = 0;
const expectedOwned = new Map();

for (let i = 0; i < 200; i++) {
  if (offers.length === 0) {
    offers = sys.rollOffers(3, buyRng);
    if (offers.length === 0) { buyFailures += 1; break; }
  }
  const target = offers[Math.min(offers.length - 1, Math.floor(buyRng() * offers.length))];
  const alloyBefore = sys.alloy;
  const price = target.price;
  const stacksBefore = expectedOwned.get(target.id) || 0;
  const offersBefore = offers.length;

  const ok = sys.pick(target.id);
  if (!ok) { buyFailures += 1; continue; }
  bought += 1;

  if (sys.alloy !== alloyBefore - price) ledgerErrors += 1;
  if ((sys.owned.find((o) => o.id === target.id) || { stacks: 0 }).stacks !== stacksBefore + 1) ledgerErrors += 1;
  expectedOwned.set(target.id, stacksBefore + 1);
  if (offers.length !== offersBefore - 1) removalErrors += 1;

  // 每次 applyAll 都必须推送全新的、互相独立的 modifiers 对象
  const afterPickPlayer = player.lastMods;
  const afterPickWeapons = weapons.lastMods;
  sys.applyAll();
  if (player.lastMods === afterPickPlayer || weapons.lastMods === afterPickWeapons
    || player.lastMods === weapons.lastMods || afterPickPlayer === afterPickWeapons) freshErrors += 1;
  if (!modsClose(player.lastMods, sys.modifiers) || !modsClose(weapons.lastMods, sys.modifiers)) contentErrors += 1;
}

check('200 次购买全部成功（合金充足）', buyFailures === 0 && bought === 200, `成功 ${bought}/200`);
check('每次购买都精确扣款且该改件层数 +1', ledgerErrors === 0, `账目异常 ${ledgerErrors} 次`);
check('购买后该改件立刻从货架移除（不重复出售）', removalErrors === 0, `异常 ${removalErrors} 次`);
check('applyAll() 每次都推送全新且互不相同的 modifiers 对象（player ≠ weapons）',
  freshErrors === 0, `异常 ${freshErrors} 次`);
check('每次推送的内容都与 this.modifiers 深等（player/weapons 拿到的都是完整快照）',
  contentErrors === 0, `异常 ${contentErrors} 次`);

const actualOwned = new Map(sys.owned.map((o) => [o.id, o.stacks]));
let ownedMismatch = actualOwned.size === expectedOwned.size ? 0 : 1;
let totalStacks = 0;
let overMax = 0;
for (const [id, stacks] of expectedOwned) {
  if (actualOwned.get(id) !== stacks) ownedMismatch += 1;
  totalStacks += stacks;
  if (stacks > UPGRADES[id].maxStacks) overMax += 1;
}
check('owned 计数完全正确：总层数 200、无超上限、无遗漏',
  ownedMismatch === 0 && totalStacks === 200 && overMax === 0,
  `${actualOwned.size} 种 / ${totalStacks} 层`);
check('系统从未遇到未登记键（invalidKeyCount = 0）', sys.debugState().invalidKeyCount === 0);

// 同一改件叠两层：乘算而非加算
const stackRng = mulberry32(0x51ac);
const stackCtx = makeSystem({ rng: stackRng });
stackCtx.sys.addAlloy(100000);
const twice = buyOne(stackCtx.sys, 'damage_core', stackRng) && buyOne(stackCtx.sys, 'damage_core', stackRng);
check('同一改件可连续购买叠到 2 层', twice && stackCtx.sys.owned[0].stacks === 2);
check('两层 +18% 伤害按乘算合并 = 1.18 * 1.18 = 1.3924',
  closeTo(stackCtx.sys.modifiers.weapon.damageMul, Math.pow(1.18, 2)),
  `damageMul=${stackCtx.sys.modifiers.weapon.damageMul}`);

// 不同改件之间的乘算合并
const mixedCtx = makeSystem({ rng: mulberry32(0x7a1b) });
mixedCtx.sys.addAlloy(100000);
buyOne(mixedCtx.sys, 'damage_core', stackRng);
buyOne(mixedCtx.sys, 'hollow_point', stackRng);
check('跨改件乘算：damage_core(+18%) × hollow_point(+12%) = 1.3216，且 hollow_point 的 -10% 射程是乘算键',
  closeTo(mixedCtx.sys.modifiers.weapon.damageMul, 1.18 * 1.12)
  && closeTo(mixedCtx.sys.modifiers.weapon.rangeMul, 0.9),
  `damageMul=${mixedCtx.sys.modifiers.weapon.damageMul} rangeMul=${mixedCtx.sys.modifiers.weapon.rangeMul}`);

// 加算键线性叠加
const addRng = mulberry32(0xadd1);
const addCtx = makeSystem({ rng: addRng });
addCtx.sys.addAlloy(100000);
const dashTwice = buyOne(addCtx.sys, 'dash_cell', addRng) && buyOne(addCtx.sys, 'dash_cell', addRng);
check('加算键线性叠加：两层冲刺电池 = dashChargesAdd 2',
  dashTwice && addCtx.sys.modifiers.move.dashChargesAdd === 2,
  `dashChargesAdd=${addCtx.sys.modifiers.move.dashChargesAdd}`);

// 消费者之间零共享状态
player.lastMods.move.walkSpeedMul = 12345;
player.lastMods.weapon.damageMul = 999;
const leakCheck = weapons.lastMods.move.walkSpeedMul !== 12345
  && weapons.lastMods.weapon.damageMul !== 999
  && sys.modifiers.move.walkSpeedMul !== 12345
  && sys.modifiers.weapon.damageMul !== 999;
check('player 与 weapons 之间、以及与系统内部之间完全没有共享引用', leakCheck);

const snapshot = sys.modifiers;
snapshot.move.maxHealthAdd = -777;
check('this.modifiers 返回防御性拷贝（外部改不脏内部状态）',
  sys.modifiers.move.maxHealthAdd !== -777);

// ---------------------------------------------------------------- 5. 经济

section('5. 合金经济：reroll 涨价 / 买不起的拒绝路径');

const ecoRng = mulberry32(0xec0);
const eco = makeSystem({ rng: ecoRng, baseRerollCost: 60 });
eco.sys.addAlloy(5000);
const firstOffers = eco.sys.rollOffers(3, ecoRng);
check('新补给站：rerollCost = 基础价 60、freeRolls = 1',
  eco.sys.rerollCost === 60 && eco.sys.freeRolls === 1);

const alloyBeforeFree = eco.sys.alloy;
const afterFree = eco.sys.reroll(ecoRng);
check('第一次 reroll 免费（消耗免费次数、合金不变、货架换新）',
  eco.sys.freeRolls === 0 && eco.sys.alloy === alloyBeforeFree && afterFree !== firstOffers);

const chargeLog = [];
let costOk = true;
for (let i = 0; i < 3; i++) {
  const cost = eco.sys.rerollCost;
  const before = eco.sys.alloy;
  const offersBefore = eco.sys._offers;
  const returned = eco.sys.reroll(ecoRng);
  chargeLog.push(`${cost}->${eco.sys.rerollCost}`);
  if (before - eco.sys.alloy !== cost) costOk = false;
  if (eco.sys.rerollCost !== Math.round(cost * 1.75)) costOk = false;
  if (returned === offersBefore) costOk = false;
}
check(`reroll 每次按当前价精确扣费且涨价 ×1.75（${chargeLog.join(' ')}）`, costOk);

// 把合金压到只剩 5，且免费次数已用完 → reroll 必须被拒绝
eco.sys.spend(eco.sys.alloy - 5);
const lowOffers = eco.sys.rollOffers(3, ecoRng);
const usedFree = eco.sys.reroll(ecoRng);
const lowCost = eco.sys.rerollCost;
const lowAlloy = eco.sys.alloy;
const rejected = eco.sys.reroll(ecoRng);
check('合金不足时 reroll 被拒绝：合金、价格、货架三者都不变',
  rejected === usedFree && eco.sys.alloy === lowAlloy && eco.sys.rerollCost === lowCost
  && eco.sys.freeRolls === 0,
  `合金=${eco.sys.alloy} 价=${eco.sys.rerollCost}`);

const poorCtx = makeSystem({ rng: mulberry32(0x9001) });
const poorOffers = poorCtx.sys.rollOffers(3, mulberry32(0x9002));
const poorId = poorOffers[0].id;
const poorPrice = poorOffers[0].price;
check('合金为 0 时货架上所有 offer 都 locked', poorOffers.every((o) => o.locked && o.price > 0));
check('合金不足时 pick 返回 false，且合金/拥有/货架都不变',
  poorCtx.sys.pick(poorId) === false && poorCtx.sys.alloy === 0
  && poorCtx.sys.owned.length === 0 && poorOffers.length === 3);

poorCtx.sys.addAlloy(poorPrice);
const unlocked = poorOffers[0].locked === false;
const boughtPoor = poorCtx.sys.pick(poorId);
check('合金恰好够钱时 locked 解除并成功买下（余额归零、层数 +1）',
  unlocked && boughtPoor === true && poorCtx.sys.alloy === 0 && poorCtx.sys.owned.length === 1);

check('spend 边界：超支拒绝、负数拒绝、正好花光成功',
  poorCtx.sys.spend(1) === false && poorCtx.sys.spend(-5) === false
  && poorCtx.sys.addAlloy(50) === 50 && poorCtx.sys.spend(50) === true && poorCtx.sys.alloy === 0);
poorCtx.sys.addAlloy(0);
poorCtx.sys.addAlloy(-10);
check('addAlloy 忽略 0 与负数', poorCtx.sys.alloy === 0);

// ---------------------------------------------------------------- 6. reset / 存档 / debugState

section('6. reset 归零 / owned JSON 往返 / debugState');

const resetRng = mulberry32(0x4e57);
const resetCtx = makeSystem({ rng: resetRng, baseRerollCost: 60 });
resetCtx.sys.addAlloy(5000);
buyOne(resetCtx.sys, 'hp_plating', resetRng);
buyOne(resetCtx.sys, 'damage_core', resetRng);
resetCtx.sys.rollOffers(3, resetRng);
const beforeReset = resetCtx.sys.modifiers;
resetCtx.sys.reset();

check('reset 后 modifiers 精确等于 MODIFIER_DEFAULTS（1 与 0 一毫不差）',
  deepEqual(resetCtx.sys.modifiers, MODIFIER_DEFAULTS)
  && Object.keys(resetCtx.sys.modifiers.move).length === Object.keys(MODIFIER_DEFAULTS.move).length);
check('reset 后 owned 为空、alloy 归零、rerollCost/freeRolls 复位',
  resetCtx.sys.owned.length === 0 && resetCtx.sys.alloy === 0
  && resetCtx.sys.rerollCost === 60 && resetCtx.sys.freeRolls === 1
  && resetCtx.sys.debugState().offerCount === 0);
check('reset 后 player 与 weapons 都收到一份零值 modifiers',
  deepEqual(resetCtx.player.lastMods, MODIFIER_DEFAULTS)
  && deepEqual(resetCtx.weapons.lastMods, MODIFIER_DEFAULTS));
check('reset 后重新抽取不再受旧货架影响（可正常开新站）',
  resetCtx.sys.rollOffers(3, resetRng).length === 3 && beforeReset.move.maxHealthAdd > 0);

const saveCtx = makeSystem({ rng: mulberry32(0x5a7e) });
saveCtx.sys.owned = [
  { id: 'damage_core', stacks: 3 },
  { id: 'slide_servo', stacks: 2 },
  { id: 'phoenix_cell', stacks: 2 },
];
const ownedJson = JSON.stringify(saveCtx.sys.owned);
const parsed = JSON.parse(ownedJson);
check('owned 是纯 JSON 结构（可 stringify，往返字符串稳定）',
  JSON.stringify(parsed) === ownedJson, ownedJson);

const loadCtx = makeSystem({ rng: mulberry32(0x5a7e) });
loadCtx.sys.owned = parsed;
check('owned 往返后完全一致（id + stacks 顺序不变）',
  deepEqual(loadCtx.sys.owned, saveCtx.sys.owned));
check('往返后 modifiers 一致：伤害 1.18³、滑铲 1.18²、不死鸟只有 1 层致死免疫但冷却 -15%',
  modsClose(loadCtx.sys.modifiers, saveCtx.sys.modifiers)
  && closeTo(loadCtx.sys.modifiers.weapon.damageMul, Math.pow(1.18, 3))
  && closeTo(loadCtx.sys.modifiers.move.slideSpeedMul, Math.pow(1.18, 2))
  && loadCtx.sys.modifiers.move.cheatDeathAdd === 1
  && closeTo(loadCtx.sys.modifiers.move.cheatDeathCooldownMul, 0.85));

const badLoad = makeSystem({ rng: mulberry32(0x5a7f) });
badLoad.sys.owned = [
  { id: 'damage_core', stacks: 999 },
  { id: 'unknown_module', stacks: 3 },
  { id: 'mag_expander', stacks: -2 },
  null,
];
check('owned setter 夹紧层数并丢弃未知 id / 非法条目',
  deepEqual(badLoad.sys.owned, [{ id: 'damage_core', stacks: UPGRADES.damage_core.maxStacks }]),
  JSON.stringify(badLoad.sys.owned));

const dbgCtx = makeSystem({ rng: mulberry32(0xdb6) });
dbgCtx.sys.addAlloy(500);
const dbgOffers = dbgCtx.sys.rollOffers(3, mulberry32(0xdb7));
const dbg = dbgCtx.sys.debugState();
check('debugState() 返回 {alloy, ownedCount, offerCount, rerollCost, modifierKeys} 且数值自洽',
  dbg.alloy === 500 && dbg.ownedCount === 0 && dbg.offerCount === dbgOffers.length
  && dbg.rerollCost === 60 && Array.isArray(dbg.modifierKeys),
  `modifierKeys=${dbg.modifierKeys.length}`);
check('debugState().modifierKeys 覆盖全部默认键（group.key 形式）',
  dbg.modifierKeys.length === defaultKeys.size && dbg.modifierKeys.every((k) => defaultKeys.has(k)));

// ---------------------------------------------------------------- 7. 事件总线

section('7. 契约事件：upgrade:offer / upgrade:picked');

const busOffers = [];
const busPicks = [];
const unOffer = on('upgrade:offer', (payload) => busOffers.push(payload));
const unPick = on('upgrade:picked', (payload) => busPicks.push(payload));

const evtCtx = makeSystem({ rng: mulberry32(0x3e7) });
evtCtx.sys.addAlloy(10000);
const evtOffers = evtCtx.sys.rollOffers(3, mulberry32(0x3e8));
const evtRerolled = evtCtx.sys.reroll(mulberry32(0x3e9));
const evtId = evtRerolled[0].id;
const evtPicked = evtCtx.sys.pick(evtId);

unOffer();
unPick();
clear('upgrade:offer');
clear('upgrade:picked');

check('rollOffers / reroll 各广播一次 upgrade:offer {offers}（payload 就是当期货架）',
  busOffers.length === 2 && busOffers[0].offers === evtOffers && busOffers[1].offers === evtRerolled,
  `收到 ${busOffers.length} 次`);
check('pick 广播 upgrade:picked {id}',
  evtPicked === true && busPicks.length === 1 && busPicks[0].id === evtId,
  JSON.stringify(busPicks[0] || null));

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`UPGRADES SELF-TEST: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
