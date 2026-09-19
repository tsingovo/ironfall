import assert from 'node:assert/strict';
import {EnemySystem,ENEMY_TYPES} from '../src/enemies.js';
import {World,FLAG} from '../src/world.js';
import {Director} from '../src/director.js';
import {CFG} from '../src/core/config.js';

function setup(tier=3) {
  const world=new World({createMesh:()=>({})});
  world._addBox([-200,-2,-200],[200,0,200],FLAG.SOLID,'ground');
  const p={alive:true,pos:new Float32Array([0,0,0]),eyePos:[0,1.62,0],state:{},damage:[],applyDamage(n){this.damage.push(n);}};
  const enemies=new EnemySystem(world,p,null);
  const director=new Director(world,enemies,p);
  director.start({tier,phase:'objectives',bossPending:true});
  // Exercise real boss creation but skip unrelated pressure/mission metrics.
  director._findSpawnPoint=()=>[0,0,60];
  director._updatePlayerMetrics=()=>{};
  director._computeThreat=()=>0;
  return {world,p,enemies,director};
}
const health=[];
for(const tier of [3,6,10]) {
  const {director,enemies}=setup(tier);
  director.update(0.01);
  const boss=director._boss;
  assert.equal(boss.typeId,'broodStalker');
  assert.equal(boss.type.speed,18);assert.equal(boss.type.weapon.damage,50);
  assert.ok(boss.maxHp>=CFG.gameplay.maxHealth*(5+tier));
  health.push(boss.maxHp);
  assert.equal(boss.shield,CFG.gameplay.maxShield*3);
  enemies.damage(boss,100000,false,boss.pos,null);
  director.update(0.01);assert.equal(director.run.bossPending,false,'boss death unlocks mission');
}
assert.ok(health[0]<health[1] && health[1]<health[2]);
{
  const {enemies,p}=setup();const b=enemies.spawn('broodStalker',[0,0,2],{scale:1.6});b.age=2;
  enemies._updateAI(b,0.01,p);enemies._updateAI(b,0.23,p);
  assert.deepEqual(p.damage,[50]);assert.equal(b.specialPhase,'retreat');
  b.pos.set([0,0,59]);enemies._updateAI(b,0.1,p);assert.equal(b.specialPhase,'retreat');
  b.pos.set([0,0,61]);enemies._updateAI(b,0.1,p);assert.equal(b.specialPhase,'approach');
}
{
  const {world,p,enemies}=setup();p.pos.set([0,0,-35]);
  world._addBox([-15,0,-4],[15,25,0],FLAG.SOLID|FLAG.CLIMBABLE,'wall');
  const b=enemies.spawn('broodStalker',[0,0,7],{scale:1.6});
  b.wallJumpCooldown=0;b.grounded=true;b.age=2;
  const modes=new Set();let top=0;
  for(let i=0;i<300;i++) {
    enemies.update(1/120,p);modes.add(b.wallJumpMode);top=Math.max(top,b.pos[1]);
    assert.ok(Math.hypot(b.vel[0],b.vel[2])<=18.001,'horizontal speed remains 18');
    assert.ok(!(b.pos[2]<-0.1 && b.pos[2]>-3.9 && b.pos[1]<24),'no wall teleport');
  }
  assert.ok(modes.has('launch'),'jumps toward nearby wall');
  assert.ok(modes.has('climb'),'attaches to real wall');
  assert.ok(modes.has('drop'),'jumps rapidly off wall');
  assert.ok(top>3,`ascended wall: ${top}`);
}
{
  const {world,enemies,director}=setup();
  const b=enemies.spawn('broodStalker',[0,0,60]);director._boss=b;
  world._navCandidates=[[-8,0,60],[8,0,60],[-14,0,60],[14,0,60],[-18,0,60],[18,0,60]];
  b.summonCooldown=0;
  director._updateBossSummons(0.01);assert.ok(b.summonCast>0);
  assert.equal(enemies.all.length,1,'summon has warning before materialization');
  director._updateBossSummons(1);
  const minions=enemies.all.filter(e=>e.summonerId===b.id);
  assert.equal(minions.length,4);
  assert.deepEqual(minions.map(e=>e.typeId),['blastSpider','stalker','blastSpider','stalker']);
  for(let i=0;i<5;i++){b.summonCooldown=0;director._updateBossSummons(0.01);director._updateBossSummons(1);}
  assert.ok(enemies.all.filter(e=>e.summonerId===b.id).length<=6,'bounded summon pool');
  assert.ok(enemies.aliveCount()<=director.concurrencyLimit);
  const count=enemies.all.length;b.alive=false;
  director._updateBossSummons(20);assert.equal(enemies.all.length,count,'dead boss cannot summon');
}
{
  const {enemies}=setup();const b=enemies.spawn('broodStalker',[0,3,0],{scale:1.6});b.wallNormal=[0,0,1];
  let legs=0,torso=0,blade=0;const original=enemies._writeEnemyPart;
  enemies._writeEnemyPart=function(slot,e,type,part,...rest){legs+=!!part.spiderLeg;torso+=part.name==='torso';blade+=part.name==='blade';original.call(this,slot,e,type,part,...rest);};
  enemies.render({sharedMeshes:{cube:{},sphere:{},cylinder:{},cone:{}},inFrustumSphere:()=>true,
    drawInstanced(_m,matrices){assert.ok([...matrices].every(Number.isFinite));}});
  assert.equal(legs,16);assert.equal(torso,1);assert.equal(blade,1);
}
console.log(`PASS hybrid boss: HP ${health.join('/')}, 50 damage/60m retreat, actual wall jumps/climb/drop, summons/caps/death, hybrid model`);
