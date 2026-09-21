import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../src/weapons.js';
import { ProjectilePool } from '../src/fx/projectiles.js';
import * as Events from '../src/core/events.js';

const pool=new ProjectilePool(null,16);
let worldDistance=Infinity,enemyDistance=Infinity,enemyDamageCalls=0,effects=0,hitEvents=0;
const enemy={};
const weapons=Object.assign(Object.create(WeaponSystem.prototype),{
  mods:{weapon:{}},projectiles:pool,player:{state:{hspeed:0}},rng:()=>1,
  world:{raycast:()=>({hit:Number.isFinite(worldDistance),t:worldDistance,point:[0,1,-worldDistance]})},
  enemies:{raycastEnemies:()=>Number.isFinite(enemyDistance)?{enemy,t:enemyDistance,point:[0,1,-enemyDistance]}:null,
    damage:()=>{enemyDamageCalls++;return {blocked:true,damage:0};}},
  stats:{hits:0,headshots:0,damageDealt:0},_falloff:()=>1,
  _applyOnHitEffects:()=>effects++,
});
Events.on('hit:enemy',()=>hitEvents++);
const spawn=()=>pool.spawn([0,1,-5],[0,0,1],1,{ownerId:-1,hp:1,damage:40,width:.4,life:9});
spawn();
const shot=()=>weapons._hitscan([0,1,0],[0,0,-1],WEAPONS.r99,{});
assert.equal(shot().intercepted,true);
assert.ok(pool.hp[0]<=0);
assert.equal(enemyDamageCalls,0);
spawn();worldDistance=2;
assert.equal(shot().intercepted,undefined,'wall blocks bullet interception');
assert.equal(pool.hp[1],1);
worldDistance=Infinity;enemyDistance=2;
assert.equal(shot().blocked,true,'tank shield blocks shot before projectile behind it');
assert.equal(pool.hp[1],1);
assert.equal(weapons.stats.hits,0);assert.equal(weapons.stats.damageDealt,0);
assert.equal(effects,0);assert.equal(hitEvents,0);
assert.ok(!weapons._shotRays?.length,'no delayed duplicate interception rays');
console.log('PASS: weapon actual interception, wall/enemy ordering, shield no-hit stats/effects, no double rays');
