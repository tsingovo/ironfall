import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../src/weapons.js';
import * as Events from '../src/core/events.js';

// Keep the real update -> _fire -> _hitscan -> recoil/feedback chain.
// Older tests replaced _fire with ammo-- and therefore hid the world-hit ReferenceError.
for (const path of ['world', 'enemy', 'sky']) {
  const w = Object.create(WeaponSystem.prototype);
  w.slots = [{ id: 'r99' }]; w.slotIndex = 0;
  const st = w._newState('r99');
  w.state = new Map([['r99', st]]);
  w.mods = { weapon: {} }; w.rng = () => 0.5;
  w.vm = { equipT: 1, holsterT: 0, pos: [0,0,0], kick: 0, kickRot: 0 };
  w.recoil = { aimPitch: 0, aimYaw: 0, visPitch: 0, visYaw: 0, patternIndex: 0, recoveryDelay: 0 };
  w.stats = { shotsFired: 0, hits: 0, headshots: 0, damageDealt: 0 };
  w.player = { yaw: 0, pitch: 0, eyePos: [0,2,0], right:[1,0,0], up:[0,1,0], forward:[0,0,-1], state: { hspeed:0, grounded:true }, setAdsFovMul() {} };
  w.world = { raycast: () => ({ hit: path === 'world', t: 10, point:[0,2,-10], normal:[0,0,1] }) };
  w.enemies = { raycastEnemies: () => path === 'enemy' ? {t:5, enemy:{}, point:[0,2,-5], normal:[0,0,1]} : null, damage: (_e,d) => ({damage:d}) };
  let tracers = 0, impacts = 0;
  w.projectiles = { update() {}, spawnTracer() { tracers++; }, spawnMuzzleFlash() {} };
  w._updateViewmodel = () => {}; // GPU animation only; never stub firing or hit resolution.
  w._fireTimer = 0; w._triggerHeld = false; w._requireTriggerRelease = false;
  const off = Events.on('hit:world', e => { impacts++; assert.equal(e.damage, WEAPONS.r99.damage); });
  for (let i=0; i<13; i++) w.update(1/128, {fire:true});
  assert.equal(w.stats.shotsFired, 2, `${path}: 100ms must fire two shots, not empty the magazine`);
  assert.equal(st.ammo,22);
  assert.equal(tracers,2);
  assert.ok(w.recoil.patternIndex > 0);
  assert.equal(impacts, path === 'world' ? 2 : 0);
  off();
  console.log(`PASS ${path}: full firing chain, 100ms / 2 shots / 22 remaining`);
}
