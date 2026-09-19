import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../src/weapons.js';
import { CFG } from '../src/core/config.js';

function rig(id = 'r99') {
  const w = Object.create(WeaponSystem.prototype);
  w.slots = [{id}]; w.slotIndex = 0; w.mods = {weapon:{}};
  w.player = {pitch:0, yaw:0};
  w.recoil = {aimPitch:0, aimYaw:0, visPitch:0, visYaw:0, patternIndex:0};
  w.state = new Map([[id, {adsT:0, spreadExtra:0}]]);
  return w;
}
const angle = w => w.player.pitch + w.recoil.visPitch;
const fire = w => {
  const before = angle(w);
  w._applyRecoil(WEAPONS[w.slots[0].id], w.state.get(w.slots[0].id));
  assert.equal(angle(w), before, 'shot must not jump camera angle');
};
const step = (w, dt, held) => w._updateRecoil(dt, {fire:held});

for (const id of ['longbow','sentinel','peacekeeper']) {
  const w = rig(id); fire(w);
  let last = 0;
  for (let i=0;i<240;i++) {
    step(w,1/120,false);
    assert.ok(angle(w) >= last - 1e-10, 'no downward rebound at settlement');
    last = angle(w);
  }
  assert.ok(last > 0 && last < Math.PI/180 * 0.08, `${id}: very small single-shot rise`);
  assert.equal(w.recoil.velocityPitch, 0);
  const held = angle(w); step(w,5,false);
  assert.equal(angle(w),held,'idle has no drift');
}
const w = rig(); const velocities=[];
for(let shot=0;shot<14;shot++) {
  fire(w);
  for(let i=0;i<8;i++) step(w,1/144,true);
  velocities.push(w.recoil.velocityPitch);
}
assert.ok(velocities[0] > 0);
assert.ok(Math.abs(velocities[10] - velocities[0]) < 1e-12, 'automatic guns use maximum speed from first shot');
const speed = w.recoil.velocityPitch;
let previous = speed;
for(let i=0;i<18;i++) {
  step(w,1/120,false);
  assert.ok(w.recoil.velocityPitch <= previous + 1e-12, 'release brakes monotonically');
  assert.ok(w.recoil.velocityPitch >= 0);
  previous=w.recoil.velocityPitch;
}
assert.ok(previous < speed*0.05,'95% stopped within 150ms');
for(let i=0;i<120;i++) step(w,1/120,false);
assert.equal(w.recoil.burstShots,0);
fire(w); assert.equal(w.recoil.burstShots,1,'new burst restarts trajectory');

const outcomes = [30,60,144].map(fps => {
  const a = rig('sentinel'); fire(a);
  for(let i=0;i<fps*2;i++) step(a,1/fps,false);
  return angle(a);
});
assert.ok(Math.max(...outcomes)-Math.min(...outcomes)<1e-6,'single-shot motion is frame-rate independent');
for (const id of ['r99', 'flatline', 'volt']) {
  const a = rig(id); fire(a); step(a, 1/120, true);
  assert.equal(a.recoil.velocityPitch, a.recoil.targetPitch, `${id}: maximum speed immediately`);
  const pitch = angle(a), velocity = a.recoil.velocityPitch;
  step(a, 1/120, true);
  assert.ok(Math.abs(angle(a)-pitch-velocity/120)<1e-12, `${id}: linear climb`);
}
for (const adsT of [0, 1]) {
  const boosted = rig(), baseline = rig();
  boosted.state.get('r99').adsT = baseline.state.get('r99').adsT = adsT;
  boosted._applyRecoil(WEAPONS.r99, boosted.state.get('r99'));
  baseline._applyRecoil({...WEAPONS.r99, recoilSpeedMul:1}, baseline.state.get('r99'));
  assert.ok(Math.abs(boosted.recoil.targetPitch / baseline.recoil.targetPitch - 2.5) < 1e-12);
  assert.ok(Math.abs(boosted.recoil.targetYaw - baseline.recoil.targetYaw * 2.5) < 1e-12);
}
assert.equal(WEAPONS.flatline.recoilSpeedMul ?? 1, 1);
assert.equal(WEAPONS.volt.recoilSpeedMul ?? 1, 1);
const ramp = rig();
const rampDef = {...WEAPONS.r99, recoilProfile:'devotion-ramp'};
const rampSpeeds=[];
for(let i=0;i<12;i++) {
  ramp._applyRecoil(rampDef, ramp.state.get('r99'));
  step(ramp, 1/18, true);
  rampSpeeds.push(ramp.recoil.velocityPitch);
}
assert.ok(rampSpeeds[11]>rampSpeeds[0]*10,'reserved Devotion profile retains accelerating feel');
const dry=rig(); fire(dry);
for(let i=0;i<240;i++) step(dry,1/120,true);
assert.equal(dry.recoil.velocityPitch,0,'holding fire without actual shots cannot sustain recoil');
const off=rig();const enabled=CFG.fx.fireCameraRecoil;
try { CFG.fx.fireCameraRecoil=false;fire(off);step(off,1/60,true);assert.equal(angle(off),0); }
finally { CFG.fx.fireCameraRecoil=enabled; }
console.log('PASS smooth recoil: no shot jumps, small single-fire shots, constant automatic speed, release braking, no idle drift, frame rates, dry fire');
