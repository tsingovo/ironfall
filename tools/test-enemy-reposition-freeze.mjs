import assert from 'node:assert/strict';
import { EnemySystem } from '../src/enemies.js';
import { World, FLAG } from '../src/world.js';

const world = new World({ createMesh: () => ({}) });
world._addBox([-150, -2, -150], [150, 0, 150], FLAG.SOLID, 'floor');
const player = { alive: true, pos: new Float32Array([20, 0, 20]),
  eyePos: new Float32Array([20, 1.6, 20]), radius: 0.35, height: 1.8,
  state: { speed: 0, hspeed: 0 }, applyDamage() {} };
const sys = new EnemySystem(world, player, null);
sys.audioEnabled = false;

// Real regression: physics skips stuck detection for flyers; following AI tick
// enters reposition. Both routines formerly shared lastPos, cleared by physics.
const flyer = sys.spawn('flyer', [0, 6, 0]);
sys._detectStuck(flyer, 1 / 128);
assert.doesNotThrow(() => sys._reposition(flyer, 1 / 128, player));
for (const id of ['flyer', 'grunt', 'blastSpider', 'broodStalker']) {
  sys.clear();
  const e = sys.spawn(id, [0, 1, 0]);
  const aiHistory = e.lastPos;
  e.wallNormal = [1, 0, 0]; e.wallJumpMode = true;
  sys._detectStuck(e, 1 / 128);
  assert.equal(e.lastPos, aiHistory, `${id}: physics must not clear AI history`);
  e.wallNormal = null; e.wallJumpMode = false;
  sys._detectStuck(e, 1 / 128);
  assert.notEqual(e.stuckLastPos, e.lastPos, 'independent histories');
  // Legacy/null history is also recoverable.
  e.lastPos = null;
  assert.doesNotThrow(() => sys._reposition(e, 1 / 128, player));
  e.stuckTime = 5; e.stuckAttempts = 4; e.stuckBlocked = [123];
  sys.clear();
  const reused = sys.spawn(id, [5, 1, 5]);
  assert.equal(reused, e);
  assert.equal(reused.stuckTime, 0);
  assert.equal(reused.stuckAttempts, 0);
  assert.equal(reused.stuckBlocked.length, 0);
}
sys.clear();
const e = sys.spawn('flyer', [0, 6, 0]);
sys._hasLineOfSight = () => false;
for (let i = 0; i < 512; i++) {
  e.state = 3; // AI_REPOSITION
  e.lastSeenTime = sys._time;
  sys.update(1 / 128, player);
}
assert.ok([...e.pos, ...e.vel].every(Number.isFinite));
console.log('PASS: flyer reposition, wall transitions, isolated histories, pool reuse, 512 update ticks');
