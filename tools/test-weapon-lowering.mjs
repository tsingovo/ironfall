import assert from 'node:assert/strict';
import { CFG } from '../src/core/config.js';
import { WeaponSystem, WEAPONS } from '../src/weapons.js';

function pose(def, adsT, state, lowering) {
  const w = Object.create(WeaponSystem.prototype);
  w.player = { yaw: 0, pitch: 0, state: { grounded: true, hspeed: 0, ...state } };
  w.rng = () => 0.5;
  w._hasOptic = () => false;
  w.vm = { t: 0, pos: [0,0,0], rot: [0,0,0], sway: [0,0], lastYaw: 0, lastPitch: 0,
    sprintBlend: 0, slideBlend: 0, airBlend: 0, wallrunBlend: 0, bobPhase: 0, bobAmp: 0,
    kick: 0, kickRot: 0, equipT: 1, holsterT: 0, meleeT: 1 };
  CFG.render.weaponLowering = lowering;
  for (let i = 0; i < 180; i++) w._updateViewmodel(1/60, { adsT, ads: adsT > 0, reloading: false }, def, {});
  return w.vm.pos;
}
const saved = CFG.render.weaponLowering;
try {
  for (const def of Object.values(WEAPONS)) {
    for (const state of [{}, {grounded:false}, {sliding:true,hspeed:12}, {sprinting:true,hspeed:12}]) {
      for (const ads of [0, 0.5, 1]) {
        const before = pose(def, ads, state, 0), after = pose(def, ads, state, saved);
        const expected = def.class === 'melee' ? 0 : saved * (1 - ads);
        assert.ok(Math.abs(before[1] - after[1] - expected) < 1e-5, `${def.id}: lowering / ADS alignment`);
        assert.equal(before[0], after[0]); assert.equal(before[2], after[2]);
      }
    }
  }
  console.log('PASS all weapons: hip/air/slide/sprint lowering, ADS alignment, melee unchanged');
} finally { CFG.render.weaponLowering = saved; }
