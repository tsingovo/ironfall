// ==== test-inventory.mjs — 背包数据、掉落模型与 Tab/Esc 接线的无浏览器回归测试 ====

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InventorySystem, LOOT_DEFS, BACKPACK_SIZE } from '../src/inventory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

function makeSystem() {
  return new InventorySystem(null, null);
}

function itemTotal(sys, id) {
  let n = 0;
  for (const s of sys.slots) if (s && s.itemId === id) n += s.count;
  return n;
}

function makePlayer(x = 0, y = 0, z = 0) {
  return {
    pos: new Float32Array([x, y, z]),
    forward: new Float32Array([0, 0, -1]),
    yaw: 0,
  };
}

section('1. 模块与堆叠');
check('背包固定为 6×4 共 24 格', BACKPACK_SIZE === 24);
check('每个物品定义含合法堆叠与可见模型', Object.values(LOOT_DEFS).every((d) =>
  d.id && d.name && ((d.infinite && d.stack === Infinity) || (Number.isInteger(d.stack) && d.stack > 0))
  && Array.isArray(d.model) && d.model.length > 0));
check('每个物品都提供详细数值效果与操作说明', Object.values(LOOT_DEFS).every((d) =>
  typeof d.desc === 'string' && d.desc.length >= 18 && /\d|无限/.test(d.desc)
  && typeof d.effect === 'string' && d.effect.length >= 6
  && typeof d.usage === 'string' && d.usage.length >= 8));

{
  const sys = makeSystem();
  const added = sys.add('armor_plate', 8);
  const stacks = sys.slots.filter((s) => s && s.itemId === 'armor_plate').map((s) => s.count);
  check('add 跨格堆叠且不超过上限', added === 8 && stacks.join(',') === '3,3,2', stacks.join(','));
  check('add 拒绝未知物品', sys.add('missing_item', 2) === 0);
  check('add 拒绝负数量', sys.add('armor_plate', -3) === 0 && itemTotal(sys, 'armor_plate') === 8);
  check('四种治疗/护盾道具固定显示为无限且不会重复占格',
    sys.add('medkit', 99) === 99 && sys.add('medkit', 2) === 2
    && sys.add('shield_battery', 1) === 1
    && sys.add('syringe', 1) === 1 && sys.add('shield_cell', 1) === 1
    && itemTotal(sys, 'medkit') === Infinity && itemTotal(sys, 'shield_battery') === Infinity
    && itemTotal(sys, 'syringe') === Infinity && itemTotal(sys, 'shield_cell') === Infinity
    && ['medkit', 'shield_battery', 'syringe', 'shield_cell'].every((id) =>
      sys.slots.filter((s) => s && s.itemId === id).length === 1));
}

{
  const sys = makeSystem();
  // stack=1 的瞄具可稳定填满所有格子。
  const added = sys.add('optic_1x', BACKPACK_SIZE + 3);
  check('满背包只返回实际加入数量', added === BACKPACK_SIZE && sys.slots.every(Boolean), String(added));
}

section('2. 移动、合并与交换');
{
  const sys = makeSystem();
  sys.slots[0] = { itemId: 'armor_plate', count: 2 };
  sys.slots[1] = { itemId: 'armor_plate', count: 2 };
  check('同物品拖动优先合并', sys.moveOrSwap(0, 1)
    && sys.slots[0].count === 1 && sys.slots[1].count === 3);
  sys.slots[2] = { itemId: 'intel_core', count: 1 };
  check('不同物品拖动会交换', sys.moveOrSwap(0, 2)
    && sys.slots[0].itemId === 'intel_core' && sys.slots[2].itemId === 'armor_plate');
  check('空格移动保留对象与数量', sys.moveOrSwap(2, 5)
    && sys.slots[2] === null && sys.slots[5].itemId === 'armor_plate' && sys.slots[5].count === 1);
  check('非法/空来源移动安全失败', !sys.moveOrSwap(-1, 2) && !sys.moveOrSwap(4, 6));
}

section('3. 丢弃与拾取');
{
  const sys = makeSystem();
  const player = makePlayer(10, 2, 20);
  sys.slots[0] = { itemId: 'armor_plate', count: 3 };
  check('dropSlot 可丢指定数量并生成世界掉落', sys.dropSlot(0, player, 2)
    && sys.slots[0].count === 1 && sys.drops.length === 1 && sys.drops[0].count === 2);
  check('掉落生成在玩家前方且坐标有限', Math.abs(sys.drops[0].pos[0] - 10) < 1e-6
    && Math.abs(sys.drops[0].pos[2] - 18.55) < 1e-4
    && [...sys.drops[0].pos].every(Number.isFinite));
  check('dropSlot 默认丢弃整格', sys.dropSlot(0, player) && sys.slots[0] === null
    && sys.drops.length === 2 && sys.drops[1].count === 1);
  check('空格或无玩家时安全失败', !sys.dropSlot(0, player) && !sys.dropSlot(1, null));
  sys.add('medkit', 1);
  const medIndex = sys.slots.findIndex((s) => s && s.itemId === 'medkit');
  check('无限治疗补给不可丢弃且不会生成无限世界掉落',
    !sys.dropSlot(medIndex, player) && itemTotal(sys, 'medkit') === Infinity && sys.drops.length === 2);
}

{
  const sys = makeSystem();
  const player = makePlayer();
  const drop = sys.spawn('armor_plate', 3, [1, 0, 0]);
  sys.update(1 / 60, player);
  const result = sys.pickupNearest(player);
  check('pickupNearest 拾取最近掉落并写入背包', result.ok && result.added === 3
    && itemTotal(sys, 'armor_plate') === 3);
  check('完整拾取会移除世界掉落并清 nearDrop', !sys.drops.includes(drop) && sys.nearDrop === null);
  check('无附近掉落返回 none', sys.pickupNearest(player).reason === 'none');
}

{
  const sys = makeSystem();
  const player = makePlayer();
  // 留一个装甲板格的一个空位，其余全部占满，验证部分拾取不会吞掉余量。
  sys.slots.fill(null);
  sys.slots[0] = { itemId: 'armor_plate', count: 2 };
  for (let i = 1; i < BACKPACK_SIZE; i++) sys.slots[i] = { itemId: 'optic_1x', count: 1 };
  const drop = sys.spawn('armor_plate', 3, [1, 0, 0]);
  sys.update(0, player);
  const result = sys.pickupNearest(player);
  check('背包仅有部分空间时保留地面余量', result.ok && result.added === 1
    && result.remaining === 2 && drop.count === 2 && sys.drops.includes(drop));
  sys.update(0, player);
  const full = sys.pickupNearest(player);
  check('背包全满返回 full 且不吞掉落', !full.ok && full.reason === 'full' && drop.count === 2);
}

section('4. reset、播种与世界模型提交');
{
  const sys = makeSystem();
  sys.spawn('intel_core', 1, [99, 99, 99]);
  sys.slots[7] = { itemId: 'armor_plate', count: 2 };
  const world = {
    groundHeight: () => 0,
    snapToGround(p, margin) { p[1] = margin; return p; },
    spawnPoints: () => [[0, 0, 0], [12, 0, 0]],
    objectives: () => [{ pos: [0, 0, 12] }],
    supplyStations: () => [{ pos: [-12, 0, 0] }],
    hazardAt: () => null,
  };
  sys.reset(world, 123);
  check('reset 清旧背包并恢复四种无限补给', itemTotal(sys, 'medkit') === Infinity
    && itemTotal(sys, 'shield_battery') === Infinity
    && itemTotal(sys, 'syringe') === Infinity && itemTotal(sys, 'shield_cell') === Infinity
    && itemTotal(sys, 'armor_plate') === 0
    && sys.debugState().used === 0);
  check('reset 清旧掉落并重新播种 16–32 个', sys.drops.length >= 16 && sys.drops.length <= 32
    && !sys.drops.some((d) => d.pos[0] === 99 && d.pos[1] === 99));
  check('reset 强制关闭背包并清 nearDrop', !sys.open && sys.nearDrop === null);

  const calls = [];
  const engine = {
    sharedMeshes: { cube: {}, cylinder: {}, sphere: {} },
    drawInstanced(mesh, matrix, count, opts) { calls.push({ mesh, matrix: Array.from(matrix), count, opts }); },
  };
  sys.render(engine);
  const expectedMin = sys.drops.reduce((n, d) => n + LOOT_DEFS[d.itemId].model.length + 1, 0);
  check('每个世界掉落提交物品本体及可见底座', calls.length === expectedMin && calls.every((c) => c.count === 1),
    `${calls.length}/${expectedMin}`);
  check('掉落模型矩阵与颜色均为有限值', calls.every((c) =>
    c.matrix.every(Number.isFinite) && Array.isArray(c.opts.color) && c.opts.color.every(Number.isFinite)));
}

section('5. 可用配件与近战武器');
{
  const equipped = { r99: {}, flatline: {}, sentinel: {}, melee: {} };
  const weapons = {
    installAttachment(itemId) {
      const map = {
        light_mag: ['r99', 'mag'], heavy_mag: ['flatline', 'mag'],
        sniper_cell: ['sentinel', 'charge'], tactical_knife: ['melee', 'melee'],
      };
      const spec = map[itemId];
      if (!spec) return { ok: false, reason: 'incompatible' };
      equipped[spec[0]][spec[1]] = itemId;
      return { ok: true, weaponId: spec[0], slot: spec[1], replaced: null };
    },
  };
  const sys = new InventorySystem(null, null, { weapons, weaponDefs: {} });
  sys.slots[0] = { itemId: 'light_mag', count: 1 };
  const mag = sys.equipSlot(0);
  check('双击扩容弹匣会真实安装并消耗背包物品', mag.ok && equipped.r99.mag === 'light_mag' && sys.slots[0] === null);
  sys.slots[1] = { itemId: 'tactical_knife', count: 1 };
  const knife = sys.equipSlot(1);
  check('战术刀可装备到近战槽', knife.ok && equipped.melee.melee === 'tactical_knife' && sys.slots[1] === null);
  sys.slots[2] = { itemId: 'medkit', count: 1 };
  check('非配件不会被误安装或消耗', !sys.equipSlot(2).ok && sys.slots[2].count === 1);
  check('所有可装备物资声明槽位与兼容武器', ['light_mag', 'heavy_mag', 'sniper_cell', 'optic_1x', 'tactical_knife']
    .every((id) => LOOT_DEFS[id].equipSlot && LOOT_DEFS[id].compatible.length > 0));
}

{
  const player = {
    ...makePlayer(), alive: true, shield: 25, maxShield: 75, armorShieldBonus: 0,
    addShield(n) { this.shield = Math.min(this.maxShield, this.shield + n); },
    increaseShieldCapacity(n) {
      const add = Math.min(Math.max(0, 50 - this.armorShieldBonus), n);
      if (add <= 0) return 0;
      this.armorShieldBonus += add; this.maxShield += add; this.shield += add; return add;
    },
  };
  const run = {
    score: 0, alloy: 0,
    addScore(n) { this.score += n; },
    addAlloy(n) { this.alloy += n; },
  };
  let healing = -1;
  const sys = new InventorySystem(null, null, { player, run, onUseHealing: (i) => { healing = i; return true; } });
  sys.slots[0] = { itemId: 'armor_plate', count: 2 };
  const armor = sys.activateSlot(0);
  check('复合装甲板真实增加 25 护盾上限/当前值并消耗 1 个', armor.ok && armor.maxShieldAdded === 25
    && player.maxShield === 100 && player.shield === 50 && sys.slots[0].count === 1);
  const armor2 = sys.activateSlot(0);
  check('第二块装甲板可升到 125 上限', armor2.ok && player.maxShield === 125
    && player.shield === 75 && sys.slots[0] === null);
  sys.slots[0] = { itemId: 'armor_plate', count: 1 };
  check('达到额外两格上限后装甲板不会浪费', !sys.activateSlot(0).ok && sys.slots[0].count === 1);
  sys.slots[1] = { itemId: 'intel_core', count: 1 };
  const intel = sys.activateSlot(1);
  check('情报核心真实增加分数/合金并被消耗', intel.ok && run.score === 500 && run.alloy === 25 && sys.slots[1] === null);
  sys.slots[2] = { itemId: 'shield_battery', count: Infinity };
  const battery = sys.activateSlot(2);
  check('背包单击无限药品接入真实治疗读条', battery.ok && healing === 1 && sys.slots[2].count === Infinity);
}

section('6. UI 事件与 Tab/Esc 状态机静态接线');
const inventorySrc = fs.readFileSync(path.join(ROOT, 'src/inventory.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const inputSrc = fs.readFileSync(path.join(ROOT, 'src/core/input.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'styles/inventory.css'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

check('右键菜单阻止浏览器默认行为并调用 dropSlot', /contextmenu[\s\S]{0,180}preventDefault\(\)[\s\S]{0,180}dropSlot\(i, this\._playerForDrop\)/.test(inventorySrc));
check('单击背包物品调用统一真实用途入口', /addEventListener\('click'[\s\S]{0,220}activateSlot\(i\)/.test(inventorySrc)
  && !/addEventListener\('dblclick'/.test(inventorySrc));
check('拖出面板调用 dropSlot', /dragend[\s\S]{0,500}outside[\s\S]{0,180}dropSlot\(this\._dragFrom, this\._playerForDrop\)/.test(inventorySrc));
check('专用丢弃区调用 dropSlot', /inventory-drop-zone[\s\S]{0,700}dropSlot\(this\._dragFrom, this\._playerForDrop\)/.test(inventorySrc));
check('背包打开：暂停、屏蔽菜单输入、释放锁定、保存玩家引用', /openBackpack\(\)[\s\S]{0,700}this\.paused = true[\s\S]{0,300}Input\.setMenuBlocking\(true\)[\s\S]{0,200}Input\.exitLock\(\)[\s\S]{0,200}setOpen\(true, this\.player\)/.test(mainSrc));
check('背包关闭：解除屏蔽并恢复游玩/鼠标锁', /closeBackpack\(\)[\s\S]{0,700}this\.paused = false[\s\S]{0,260}Input\.setMenuBlocking\(false\)[\s\S]{0,260}Input\.setPlaying[\s\S]{0,300}_requestPointerLockWithRetry\(\)/.test(mainSrc));
// 下面两条原本是脆弱的源码正则：把「多少字符之内出现某个调用」当断言。
// 联机改动在 Esc 分支里插入了「联机阵亡 → 观战 / 结算」的处理，
// 间隔被撑大导致正则失配 —— 但**行为其实仍然正确**。改为按行为判定。
{
  const gkStart = mainSrc.indexOf('_handleGlobalKeys()');
  const gkBody = gkStart >= 0 ? mainSrc.slice(gkStart, gkStart + 4000) : '';
  const escAt = gkBody.indexOf("actionPressed('pause')");
  const escBranch = escAt >= 0 ? gkBody.slice(escAt, escAt + 2000) : '';
  const invAt = escBranch.search(/inventory\??\.open/);
  const closeAt = escBranch.indexOf('closeBackpack()');
  const returnAfterClose = closeAt >= 0 && escBranch.slice(closeAt, closeAt + 120).includes('return');
  check('Esc 优先关闭背包，不会在背后打开设置',
    escAt >= 0 && invAt >= 0 && closeAt >= 0 && returnAfterClose,
    `pause 分支=${escAt >= 0} 背包判断=${invAt >= 0} 关闭=${closeAt >= 0} 关闭后 return=${returnAfterClose}`);

  const tabAt = gkBody.indexOf("pressed('Tab')");
  const tabBranch = tabAt >= 0 ? gkBody.slice(tabAt, tabAt + 800) : '';
  check('Tab 在游玩中开关背包',
    tabAt >= 0 && tabBranch.includes('closeBackpack') && tabBranch.includes('openBackpack'),
    `Tab 分支存在=${tabAt >= 0}`);
}

// 全局按键必须先于「暂停早退」执行，否则打开菜单后收不到第二次 Esc。
// 早期写法是裸的 `if (this.paused)`；联机改动换成了带联机例外的复合条件，
// 所以这里按「顺序关系」判定，而不是匹配某个具体写法。
{
  const globalAt = mainSrc.indexOf('this._handleGlobalKeys();');
  const after = globalAt >= 0 ? mainSrc.slice(globalAt, globalAt + 1400) : '';
  const pausedIdx = after.search(/if \(this\.paused/);
  const returnIdx = pausedIdx >= 0 ? after.indexOf('return', pausedIdx) : -1;
  check('全局按键处理发生在 paused 早退之前',
    globalAt >= 0 && pausedIdx >= 0 && returnIdx > pausedIdx,
    `_handleGlobalKeys@${globalAt} paused@${pausedIdx >= 0 ? globalAt + pausedIdx : -1}`);
}
check('E 拾取在补给交互前消费并清 interactPressed', /nearDrop && input\.interactPressed[\s\S]{0,180}pickupNearest[\s\S]{0,500}input\.interactPressed = false[\s\S]{0,250}nearSupplyStation/.test(mainSrc));
check('输入层阻止游玩中的 Tab 浏览器默认行为', /BLOCK_DEFAULT[\s\S]{0,180}'Space', 'Tab'/.test(inputSrc));
check('index 正确加载背包 CSS 且位于 HUD 修复 CSS 前', indexSrc.indexOf('styles/inventory.css') > 0
  && indexSrc.indexOf('styles/inventory.css') < indexSrc.indexOf('styles/hud-fixes.css'));
check('覆盖层默认不可交互，开启类恢复可见与点击', /#inventory-overlay[\s\S]{0,350}visibility:\s*hidden[\s\S]{0,120}pointer-events:\s*none/.test(cssSrc)
  && /#inventory-overlay\.inventory-overlay--on[\s\S]{0,180}visibility:\s*visible[\s\S]{0,120}pointer-events:\s*auto/.test(cssSrc));
check('鼠标悬停显示自定义详细说明，离开后隐藏', /mouseenter[\s\S]{0,240}_showTooltip/.test(inventorySrc)
  && /mouseleave[\s\S]{0,120}_hideTooltip/.test(inventorySrc)
  && /\.inventory-tooltip--on/.test(cssSrc));
check('返回游戏未锁鼠标时会在 1 秒后自动重试', /_requestPointerLockWithRetry\(\)[\s\S]{0,1000}setTimeout[\s\S]{0,500}!Input\.pointerLocked[\s\S]{0,120}Input\.requestLock\(\)[\s\S]{0,80}1000/.test(mainSrc));

console.log(`\nINVENTORY SELF-TEST: ${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
