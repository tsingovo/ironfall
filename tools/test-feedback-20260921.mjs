import assert from 'node:assert/strict';
import { World, FLAG } from '../src/world.js';
import { EnemySystem } from '../src/enemies.js';
import { Director } from '../src/director.js';
import { ProjectilePool } from '../src/fx/projectiles.js';
import * as Events from '../src/core/events.js';

function player(x=0,z=0) {
  return {
    alive:true,pos:new Float32Array([x,.2,z]),eyePos:new Float32Array([x,1.8,z]),
    vel:new Float32Array(3),radius:.35,height:1.8,currentHeight:1.8,yaw:0,
    state:{grounded:true,speed:0,hspeed:0},health:1000,shield:0,maxHealth:1000,maxShield:0,
    applyDamage(n){this.health-=n;}, heal(){},
  };
}
function setup(tier=1) {
  const world=new World({createMesh:()=>({})});world.size=320;
  world._addBox([-155,-2,-155],[155,0,155],FLAG.SOLID,'floor');
  world._navCandidates=[];
  for(let x=-140;x<=140;x+=10) for(let z=-140;z<=140;z+=10)
    world._navCandidates.push(new Float32Array([x,0,z]));
  const p=player();
  const projectiles=new ProjectilePool(null,512);
  const enemies=new EnemySystem(world,p,null,{particles:{emit(){},emitBurst(){}},projectiles});
  enemies.audioEnabled=false;
  const run={tier,bossPending:true,phase:'objectives',objectives:[],combo:0};
  const director=new Director(world,enemies,p,{});director.start(run);
  return {world,p,projectiles,enemies,run,director};
}

// 狙击手：完整扫线后才进入最后 0.5s 冻结；静止目标必须能命中。
{
  const {enemies,p,director,world}=setup(4);
  assert.equal(director._findSpawnPoint('highSniper',true),null,'平地不得生成高台狙击手');
  world._addBox([-3,7,-108],[3,8,-102],FLAG.SOLID,'sniper-platform');
  world._navCandidates.push(new Float32Array([0,8,-105]));
  const high=director._findSpawnPoint('highSniper',true);
  assert.ok(high && high[1]>=8,'存在高台时必须生成在高处');
  p.pos.set([0,.2,-40]);
  const e=enemies.spawn('highSniper',high);e.yaw=0;e.aimYaw=0;e.spawnAttackLock=0;e.age=5;e.fireCooldown=0;
  const start=[...e.pos];
  for(let i=0;i<220;i++) enemies.update(1/60,p);
  assert.ok(p.health<1000,'静止玩家应被高台狙击手锁定命中');
  assert.ok(Math.hypot(e.pos[0]-start[0],e.pos[2]-start[2])<.25,'高台狙击手不得自己走下平台');
}

// 哥布林：环境/虚空死亡不计数，玩家击杀才精确 +1。
{
  const {enemies}=setup(7);
  const vat=enemies.spawn('tier7Vat',[0,.2,0]);vat.vatKills=0;
  let g=enemies.spawn('tier7CloneGoblin',[4,.2,0]);g.vatId=vat.id;
  enemies.damage(g,99,false,g.pos,null,{source:'void'});
  assert.equal(vat.vatKills,0);
  g=enemies.spawn('tier7CloneGoblin',[5,.2,0]);g.vatId=vat.id;
  enemies.damage(g,99,false,g.pos,null,{def:{id:'r99'}});
  assert.equal(vat.vatKills,1);
}

// 坦克护盾：视觉外缘 x=2m 也必须先命中护盾并完全挡住。
{
  const {enemies}=setup(4);
  const tank=enemies.spawn('tier4ShieldMech',[0,.2,0]);tank.yaw=0;tank.aimYaw=0;
  const hit=enemies.raycastEnemies([2,1.8,-10],[0,0,1],30);
  assert.equal(hit?.enemy,tank);
  const hp=tank.hp,shield=tank.shield;
  const result=enemies.damage(tank,100,false,hit.point,hit.normal,{def:{id:'r99'}});
  assert.ok(result.blocked && result.damage===0);
  assert.equal(tank.hp,hp);assert.equal(tank.shield,shield);
}

// 熔岩弹：击毁和命中分别有爆炸音；命中会造成明显水平/垂直击飞。
{
  const {projectiles,enemies,p,world}=setup(10);let explosions=0;
  const off=Events.on('audio:play',e=>{if(e.name==='explosion') explosions++;});
  let i=projectiles.spawn([0,1,-5],[0,0,1],10,{ownerId:-1,hp:1,homing:true,damage:40,width:.42,life:3});
  assert.ok(projectiles.damageProjectile(i,1));
  assert.equal(explosions,1);
  projectiles.update(.01,world,enemies);
  projectiles.spawn([0,1,-1],[0,0,1],10,{ownerId:-1,hp:1,homing:true,damage:40,width:.42,life:3});
  projectiles.update(.2,world,enemies);
  assert.ok(explosions>=2 && p.vel[1]>=9.5 && Math.hypot(p.vel[0],p.vel[2])>=17.9);
  off();
}

// 噩梦：固定 20 Boss，十种各两只，血量统一第五关 1800，整层伤害系数减半。
{
  const {director,enemies,run}=setup(11);
  for(let i=0;i<20 && director._nightmareSpawnIndex<20;i++) director.update(1/128);
  const bosses=enemies.all.filter(e=>e.isCampaignBoss);
  assert.equal(bosses.length,20);
  const counts=new Map();for(const b of bosses) counts.set(b.typeId,(counts.get(b.typeId)||0)+1);
  assert.equal(counts.size,10);assert.ok([...counts.values()].every(n=>n===2));
  assert.ok(bosses.every(b=>b.maxHp===1800));
  assert.equal(enemies.campaignDamageMul,.5);assert.equal(run.bossPending,true);
  assert.equal(enemies.all.filter(e=>e.typeId==='tier7CloneGoblin').length,0,
    '噩梦关不得生成克隆哥布林');
  const vats=bosses.filter(e=>e.typeId==='tier7Vat');
  assert.equal(vats.length,2);
  assert.ok(vats.every(v=>v.nightmareDirectDamage===true));
  enemies.damage(vats[0],999999,false,vats[0].pos,null,{def:{id:'r99'}});
  assert.equal(vats[0].alive,false,'噩梦克隆罐应可直接摧毁');
  const queen=bosses.find(b=>b.typeId==='broodStalker');
  const safe=[...queen.safeSpawn];queen.pos[1]=-50;enemies._physics(queen,1/128);
  assert.ok(queen.alive && Math.hypot(...queen.pos.map((v,i)=>v-safe[i]))<.01,
    '蛛皇坠落后应回到安全出生点');
}

console.log('PASS: sniper lock/high-ground contract, exact goblin accounting, full tank shield, lava impact feedback/knockback, 20-boss nightmare');
