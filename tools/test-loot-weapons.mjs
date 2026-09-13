import { InventorySystem, LOOT_DEFS } from '../src/inventory.js';
import WeaponSystem, { WEAPONS } from '../src/weapons.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function fakeWeaponSystem() {
  const w = {
    slots: [{ id: 'r99' }, { id: 'flatline' }, { id: 'melee' }, { id: 'sentinel' }], slotIndex: 0,
    lootAttachments: Object.fromEntries(Object.keys(WEAPONS).map(id => [id, { mag: null, optic: null, charge: null, melee: null }])),
    state: new Map(Object.entries(WEAPONS).map(([id, d]) => [id, { ...WeaponSystem.prototype._newState.call({ }, id), ammo: d.magSize }])),
    mods: { move: {}, weapon: {}, meta: {} }, vm: { holsterT: 0 },
    get current() { return { id: this.slots[this.slotIndex].id }; },
    _equip(id) { this.slotIndex = this.slots.findIndex(s => s.id === id); },
  };
  for (const k of ['_magSize', '_chargeTime', 'installAttachment', 'uninstallAttachment', 'getAttachments', 'installLootWeapon'])
    w[k] = WeaponSystem.prototype[k];
  return w;
}

const tiers = [
  ['light_mag_1', 'light_mag', 'light_mag_3', [3, 5, 8], 'r99', 'mag'],
  ['heavy_mag_1', 'heavy_mag', 'heavy_mag_3', [3, 5, 8], 'flatline', 'mag'],
  ['sniper_cell_1', 'sniper_cell', 'sniper_cell_3', [.88, .78, .68], 'sentinel', 'charge'],
];
check('三类配件均有 I/II/III 数据定义', tiers.every(row => row.slice(0, 3).every(id => LOOT_DEFS[id])));
check('所有等级 tooltip 直接给出真实效果数值', tiers.flatMap(r => r.slice(0, 3)).every(id => /\d/.test(LOOT_DEFS[id].effect)));

{
  const w = fakeWeaponSystem();
  for (const [a, b, c, values, weapon, slot] of tiers) {
    const base = WEAPONS[weapon].magSize;
    const r1 = w.installAttachment(a, weapon);
    const v1 = slot === 'mag' ? w._magSize(WEAPONS[weapon]) - base : w._chargeTime(WEAPONS[weapon]) / WEAPONS[weapon].chargeTime;
    const downgrade = w.installAttachment(a, weapon);
    const r3 = w.installAttachment(c, weapon);
    const v3 = slot === 'mag' ? w._magSize(WEAPONS[weapon]) - base : w._chargeTime(WEAPONS[weapon]) / WEAPONS[weapon].chargeTime;
    check(`${LOOT_DEFS[a].category}等级真实参与计算`, r1.ok && Math.abs(v1 - values[0]) < 1e-6);
    check(`${LOOT_DEFS[c].name}替换低级且返回旧件`, r3.ok && r3.replaced === a && Math.abs(v3 - values[2]) < 1e-6);
    check(`${LOOT_DEFS[a].name}不能覆盖高级`, !w.installAttachment(b, weapon).ok && w.installAttachment(b, weapon).reason === 'lower_rank');
    void downgrade;
  }
}

for (const id of ['volt', 'peacekeeper', 'longbow']) {
  const d = WEAPONS[id];
  check(`${d.name}具备可射击完整数据`, d.magSize > 0 && d.rpm > 0 && d.damage > 0 && d.rangeFar > 0 && d.bulletSpeed > 0);
  const w = fakeWeaponSystem();
  const inv = new InventorySystem(null, null, { weapons: w, weaponDefs: WEAPONS });
  inv.add(`weapon_${id}`, 1);
  const index = inv.slots.findIndex(s => s?.itemId === `weapon_${id}`);
  const result = inv.equipWeaponSlot(index, 1);
  check(`${d.name}拾取后真实进入 2 号武器槽`, result.ok && w.slots[1].id === id && w.state.get(id).ammo === d.magSize);
  check(`${d.name}替换下来的枪返回背包`, inv.slots.some(s => s?.itemId === 'weapon_flatline'));
}

{
  const inv = new InventorySystem(null, null);
  const world = { groundHeight: () => 0, spawnPoints: () => [[0, 0, 0]], objectives: () => [], supplyStations: () => [], hazardAt: () => null };
  inv.seedWorldLoot(world, 42);
  check('每张地图保证三把非默认武器均可找到', ['weapon_volt', 'weapon_peacekeeper', 'weapon_longbow']
    .every(id => inv.drops.some(d => d.itemId === id)));
}

{
  const w = fakeWeaponSystem();
  const inv = new InventorySystem(null, null, { weapons: w, weaponDefs: WEAPONS });
  inv.add('light_mag_1', 1); inv.add('light_mag_3', 1);
  let i = inv.slots.findIndex(s => s?.itemId === 'light_mag_1'); inv.equipSlot(i, 'r99');
  i = inv.slots.findIndex(s => s?.itemId === 'light_mag_3'); const r = inv.equipSlot(i, 'r99');
  check('高级配件替换后低级配件真实回到背包', r.ok && inv.slots.some(s => s?.itemId === 'light_mag_1'));
  const u = inv.unequipAttachment('r99', 'mag');
  check('已装备配件可卸下回包', u.ok && inv.slots.some(s => s?.itemId === 'light_mag_3'));
}

{
  const w = fakeWeaponSystem();
  const inv = new InventorySystem(null, null, { weapons: w, weaponDefs: WEAPONS });
  inv.add('armor_plate', 2); inv.add('intel_core', 1); inv.add('medkit', 1);
  inv.add('light_mag_3', 1);
  inv.equipSlot(inv.slots.findIndex(s => s?.itemId === 'light_mag_3'), 'r99');
  const carry = inv.exportCarry();
  check('撤离导出仅包含有限物品', carry.items.some(x => x.itemId === 'armor_plate' && x.count === 2)
    && !carry.items.some(x => x.itemId === 'medkit'));
  check('撤离导出当前武器真实配件', carry.attachments.r99?.mag === 'light_mag_3');
  const w2 = fakeWeaponSystem();
  const inv2 = new InventorySystem(null, null, { weapons: w2, weaponDefs: WEAPONS });
  inv2.add('medkit', 1);
  const imported = inv2.importCarry({ ...carry, items: [...carry.items, { itemId: 'bad', count: 9 }] });
  check('新远征恢复有限物资与配件', imported.items === 3 && imported.attachments === 1
    && inv2.slots.some(s => s?.itemId === 'armor_plate' && s.count === 2)
    && w2.lootAttachments.r99.mag === 'light_mag_3');
  check('仓库坏数据安全忽略', imported.ignored === 1);
  check('clearFiniteCarry 保留无限补给', inv2.clearFiniteCarry() === 3
    && inv2.slots.some(s => s?.itemId === 'medkit'));
}

{
  const w = fakeWeaponSystem();
  const inv = new InventorySystem(null, null, { weapons: w, weaponDefs: WEAPONS });
  const r = inv.importCarry({ items: { armor_plate: 2 }, attachments: { r99: { mag: 'light_mag' } } });
  check('兼容 MetaProgress 的对象仓库格式', r.items === 2 && r.attachments === 1
    && w.lootAttachments.r99.mag === 'light_mag');
}

console.log(`\nLOOT/WEAPON SELF-TEST: ${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
