import assert from 'node:assert/strict';
import { Director } from '../src/director.js';
import { Player } from '../src/player.js';

for (let tier = 1; tier <= 10; tier++) {
  const d = Object.create(Director.prototype);
  d.tier = tier; d.enemies = { all: [] }; d.rng = () => 0.9999;
  const table = d._table();
  const share = table.blastSpider / Object.values(table).reduce((a, b) => a + b, 0);
  assert.ok(share < 0.12);
  for (let i = 0; i < 30; i++) {
    const id = d._pickAmbientType(table);
    d.enemies.all.push({ alive: true, typeId: id });
  }
  const cap = tier === 3 ? 4 : 2;
  assert.equal(d.enemies.all.filter(e => e.typeId === 'blastSpider').length, cap);
  // Summons occupy the same budget; no ambient refill while they're alive.
  d.enemies.all = Array.from({ length: 6 }, () => ({ alive: true, typeId: 'blastSpider', summonerId: 1 }));
  assert.notEqual(d._pickAmbientType(table), 'blastSpider');
}
const p = new Player({});
p.bossSlowTime = 3; p.bossSlowFactor = 0.4;
assert.equal(p._bossMovementMul(), 0.4);
p.grapple.active = true;
assert.equal(p._bossMovementMul(), 1);
p.grapple.active = false; p.bossSlowTime = 0;
assert.equal(p._bossMovementMul(), 1);
console.log('PASS: all-tier spider weights/caps, summons counted, grapple unaffected by tank slow');
