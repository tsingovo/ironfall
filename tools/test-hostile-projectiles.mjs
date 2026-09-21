import assert from 'node:assert/strict';
import { ProjectilePool } from '../src/fx/projectiles.js';

const pool = new ProjectilePool(null, 16);
let damage = 0, raycasts = 0;
const player = { pos: [0, 0, -5], alive: true, radius: 0.35, height: 1.8,
  applyDamage(amount, dir, source) { damage += amount; assert.equal(source, 'enemy'); } };
const enemies = { players: [player], replicated: false,
  raycastEnemies() { raycasts++; return { t: 0, enemy: {}, point: [0, 1, 0], normal: [0, 1, 0] }; },
  damage() { assert.fail('Enemy bullets must never hit their spawning boss'); } };
const spawn = (pos = [0, 0.9, 0], extra = {}) => pool.spawn(pos, [0, 0, -1], 10,
  { life: 10, width: 0.5, ownerId: -1, damage: 40, hp: 1, ...extra });
spawn(); pool.update(1, null, enemies);
assert.equal(damage, 40); assert.equal(pool.count, 0); assert.equal(raycasts, 0);
// A closer wall wins, including against a full-frame swept hit.
const wall = { raycast: () => ({ hit: true, t: 2, point: [0, 0.9, -2], normal: [0, 0, 1] }) };
spawn(); pool.update(1, wall, enemies);
assert.equal(damage, 40); assert.equal(pool.count, 0);
// Guest replicas must never apply authoritative projectile damage.
enemies.replicated = true; spawn(); pool.update(1, null, enemies);
assert.equal(damage, 40); pool.clear(); enemies.replicated = false;
// All live players participate; do not rely on players[0].
enemies.players = [{ ...player, alive: false }, { ...player, stale: true }, player];
spawn(); pool.update(1, null, enemies); assert.equal(damage, 80);
// True firing-ray query hits nearest bullet, not every bullet along its path.
enemies.raycastEnemies = () => null;
spawn([0, 0.9, -4]); spawn([0, 0.9, -7]);
const hit = pool.raycastInterceptable([0, 0.9, 0], [0, 0, -1], 20);
assert.equal(hit.index, 0); assert.ok(hit.t < 4);
assert.equal(pool.damageProjectile(hit.index, 1), true);
assert.equal(pool.damageProjectile(hit.index, 1), false);
assert.equal(pool.raycastInterceptable([0, 0.9, 0], [0, 0, -1], 20).index, 1);
pool.clear();
const shot = { ox: 0, oy: 0.9, oz: 0, dx: 0, dy: 0, dz: -1, len: 20 };
spawn([0, 0.9, -4]); spawn([0, 0.9, -7]);
pool.update(0, null, enemies, [shot]); assert.equal(pool.count, 1); assert.equal(pool.pz[0], -7);
pool.clear(); spawn([0, 0.9, -4]);
pool.update(0, wall, enemies, [shot]); assert.equal(pool.count, 1, 'no interception through cover');
pool.update(0, null, enemies, [{ ...shot, dx: 1, dz: 0 }]); assert.equal(pool.count, 1, 'aim must actually hit');
pool.clear(); spawn([0, 0.9, -4], { delayed: 1 });
assert.equal(pool.raycastInterceptable([0, 0.9, 0], [0, 0, -1], 20), null);
pool.update(0.1, null, enemies, [shot]); assert.equal(pool.count, 1); assert.equal(pool.pz[0], -4);
// Pool compaction retains owner and homing flags after a dead projectile is removed.
pool.clear(); spawn(); spawn([3, 0.9, 0], { homing: true, delayed: 1 });
pool.damageProjectile(0, 1); pool.update(0.1, null, enemies);
assert.equal(pool.count, 1); assert.equal(pool.ownerId[0], -1); assert.equal(pool.homing[0], 1);
// Friendly projectile behavior remains enemy-facing, rather than damaging the player.
pool.clear(); let enemyDamage = 0;
enemies.raycastEnemies = () => ({ t: 1, enemy: {}, point: [0, 0.9, -1], normal: [0, 0, 1] });
enemies.damage = (_e, amount) => { enemyDamage += amount; };
spawn([0, 0.9, 0], { ownerId: 0, hp: 0 }); pool.update(1, null, enemies);
assert.equal(enemyDamage, 40); assert.equal(damage, 80); assert.equal(pool.count, 0);
console.log('PASS hostile bullets: swept player collision, wall occlusion, no self-hit, host authority, real nearest-ray interception, delayed shots, pool compaction');
