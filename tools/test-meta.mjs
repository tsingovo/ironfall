import assert from 'node:assert/strict';
import { CAMPAIGN_TIER_COUNT, MetaProgress, PERKS, Save } from '../src/save.js';

let passed = 0;
function test(name, fn) {
  fn(); passed++;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
globalThis.localStorage = new MemoryStorage();

test('旧 v1 存档迁移时保留资源/改件/解锁并补齐新字段', () => {
  localStorage.setItem(Save.metaKey, JSON.stringify({
    version: 1, alloy: 91, points: 7, perks: { fire_control: 2 },
    stats: { runs: 4 }, unlocked: { tiers: 3 },
  }));
  const data = Save.load();
  assert.equal(data.version, 2);
  assert.equal(data.alloy, 91);
  assert.equal(data.perks.fire_control, 2);
  assert.deepEqual(data.unlocked, { tiers: 3, currentTier: 1 });
  assert.deepEqual(data.stash, { items: {}, lastExtractedLoadout: {} });
});

test('损坏和恶意仓库数量被清理', () => {
  const m = new MetaProgress({ stash: { items: { good: 2.9, bad: -4, infinite: Infinity, text: 'x' } } });
  assert.deepEqual(m.stashSnapshot().items, { good: 2 });
});

test('十个永久改件全部返回 move/weapon/meta 分组', () => {
  for (const perk of Object.values(PERKS)) {
    const effect = perk.effect(1);
    assert.ok(Object.keys(effect).every((key) => ['move', 'weapon', 'meta'].includes(key)), perk.id);
  }
});

test('移动、武器、局外三类 modifier 实际聚合', () => {
  const m = new MetaProgress({ perks: {
    servo_legs: 2, plate_carrier: 1, fire_control: 3, scavenger: 2, extract_beacon: 2,
  } });
  const mods = m.perkModifiers();
  assert.equal(mods.move.walkSpeedMul, 1.12);
  assert.equal(mods.move.sprintSpeedMul, 1.12);
  assert.equal(mods.move.maxHealthAdd, 15);
  assert.equal(mods.weapon.damageMul, 1.15);
  assert.equal(mods.meta.alloyFindMul, 1.24);
  assert.ok(Math.abs(mods.meta.extractTimeMul - 0.64) < 1e-12);
});

test('成功撤离可把有限背包物品及已装配件真实存入仓库', () => {
  const m = new MetaProgress({});
  const result = m.storeCarry({
    items: [{ itemId: 'armor_plate', count: 2 }, { itemId: 'intel_core', count: 1 }],
    attachments: { r99: { mag: 'light_mag', optic: 'optic_1x' }, sentinel: { charge: 'sniper_cell' } },
  });
  assert.deepEqual(result, { itemsStored: 3, attachmentsStored: 3 });
  assert.deepEqual(m.stashSnapshot().items, {
    armor_plate: 2, intel_core: 1, light_mag: 1, optic_1x: 1, sniper_cell: 1,
  });
});

test('部署消费是原子的且返回装配位置', () => {
  const m = new MetaProgress({});
  m.storeCarry({ items: { armor_plate: 2 }, attachments: { r99: { mag: 'light_mag' } } });
  assert.equal(m.consumeCarry({ items: { armor_plate: 3 } }), null);
  assert.equal(m.stashSnapshot().items.armor_plate, 2);
  const deployed = m.consumeCarry({ items: { armor_plate: 1 }, attachments: { r99: { mag: 'light_mag' } } });
  assert.deepEqual(deployed, { items: { armor_plate: 1 }, attachments: { r99: { mag: 'light_mag' } } });
  assert.deepEqual(m.stashSnapshot().items, { armor_plate: 1 });
});

test('阵亡是否写仓库由调用方决定，recordRun 本身不写入', () => {
  const m = new MetaProgress({});
  m.recordRun({ extracted: false, tier: 1, alloy: 10 });
  assert.deepEqual(m.stashSnapshot().items, {});
});

test('关卡无条件开放：新存档也能直接选任意一层', () => {
  const m = new MetaProgress({});
  // 需求变更：关卡不再锁定，十关随时可直接部署。
  // 原先这里断言"新存档 setCurrentTier(2) === false"（不能跳关），
  // 现在反过来 —— 只有非法层数才被拒。
  assert.equal(m.maxUnlockedTier(), 1, '推进进度仍从第 1 关开始记录');
  for (let tier = 1; tier <= CAMPAIGN_TIER_COUNT; tier++) {
    assert.equal(m.isTierUnlocked(tier), true, `第 ${tier} 关应当可选`);
    assert.equal(m.setCurrentTier(tier), true, `第 ${tier} 关应当能设为当前层`);
    assert.equal(m.currentTier(), tier);
  }
  assert.equal(m.setCurrentTier(11), false, '越界层数仍要拒绝');
  assert.equal(m.setCurrentTier(0), false, '越界层数仍要拒绝');
  assert.equal(m.setCurrentTier(NaN), false, '非法值仍要拒绝');
  assert.equal(m.currentTier(), CAMPAIGN_TIER_COUNT, '被拒后当前层不变');
});

test('战役推进：逐关解锁到第 10 关，之后循环回第 1 关', () => {
  const m = new MetaProgress({});
  assert.equal(m.advanceCampaign(1), 2);
  assert.equal(m.maxUnlockedTier(), 2);
  // 一关一关推：第 N 关通关 → 解锁并进入第 N+1 关
  for (let tier = 2; tier < CAMPAIGN_TIER_COUNT; tier++) {
    assert.equal(m.advanceCampaign(tier), tier + 1, `第 ${tier} 关之后应进入第 ${tier + 1} 关`);
  }
  assert.equal(m.maxUnlockedTier(), CAMPAIGN_TIER_COUNT, '推进到第 10 关后解锁上限封顶');
  assert.equal(m.currentTier(), CAMPAIGN_TIER_COUNT);
  // 十层远征是闭环：第 10 关通关后回到第 1 关重新开始，
  // 但已解锁层数（元进度）全部保留 —— 见 save.js advanceCampaign 的注释。
  assert.equal(m.advanceCampaign(CAMPAIGN_TIER_COUNT), 1, '第 10 关之后循环回第 1 关');
  assert.equal(m.maxUnlockedTier(), CAMPAIGN_TIER_COUNT, '循环回第 1 关不会丢失解锁上限');
  assert.equal(m.currentTier(), 1);
});

test('持久化往返保留仓库与当前关卡', () => {
  const m = new MetaProgress({});
  m.unlockTier(5); m.setCurrentTier(4); m.storeCarry({ items: { intel_core: 2 } }); m.persist();
  const restored = new MetaProgress();
  assert.equal(restored.currentTier(), 4);
  assert.equal(restored.maxUnlockedTier(), 5);
  assert.deepEqual(restored.stashSnapshot().items, { intel_core: 2 });
});

console.log(`META SELF-TEST: ${passed}/${passed} passed`);
