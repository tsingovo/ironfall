import assert from 'node:assert/strict';
import {EnemySystem,ENEMY_TYPES} from '../src/enemies.js';
import {World,FLAG} from '../src/world.js';
import {Director} from '../src/director.js';
import * as Events from '../src/core/events.js';

const player=(pos=[0,0,0])=>({alive:true,pos:new Float32Array(pos),eyePos:[pos[0],pos[1]+1.62,pos[2]],state:{},radius:0.35,damage:[],applyDamage(n){this.damage.push(n);}});
function setup(p=player()) {
  const world=new World({createMesh:()=>({})});
  world._addBox([-300,-2,-300],[300,0,300],FLAG.SOLID,'ground');
  const fx=[];
  const sys=new EnemySystem(world,p,null,{particles:{emit:(...args)=>fx.push(args),emitBurst:()=>{}}});
  return {world,sys,p,fx};
}
{
  const {sys,p,fx}=setup();
  const e=sys.spawn('stalker',[0,0,2]); e.age=2;
  sys._updateAI(e,0.01,p); assert.equal(e.specialPhase,'windup');
  sys._updateAI(e,0.25,p);
  assert.deepEqual(p.damage,[50]); assert.equal(e.specialPhase,'retreat');
  for(let i=0;i<300;i++) {sys._updateAI(e,1/60,p);sys._physics(e,1/60);sys._specialPresentation(e,1/60);}
  assert.ok(fx.some(x=>x[0]==='trail'),'green exhaust particles');
  assert.ok(p.damage.length===1,'no repeated melee during retreat');
  assert.ok(Math.hypot(e.vel[0],e.vel[2])<=18.0001,'18m/s movement cap');
  e.specialPhase='retreat';e.specialTarget=p;e.pos.set([0,0,59]);
  sys._updateAI(e,0.1,p);assert.equal(e.specialPhase,'retreat');
  e.pos.set([0,0,61]);sys._updateAI(e,0.1,p);assert.equal(e.specialPhase,'approach');
  // High difficulty and elite flags do not secretly change specified 50 damage.
  e.specialPhase='windup';e.specialTimer=0;e.pos.set([0,0,2]);e.damageMul=9;
  sys._updateAI(e,0.01,p);assert.equal(p.damage.at(-1),50);
}
{
  const {sys,p,world}=setup(); const q=player([1,0,0]),far=player([20,0,0]);
  sys.setPlayers([p,q,far]); const e=sys.spawn('blastSpider',[0,0,2]);e.age=2;
  sys._updateAI(e,0.01,p);assert.equal(e.specialPhase,'charge');
  sys._updateAI(e,0.5,p);assert.deepEqual(p.damage,[]);
  sys._updateAI(e,0.7,p);assert.deepEqual(p.damage,[50]);assert.deepEqual(q.damage,[50]);assert.deepEqual(far.damage,[]);
  sys._detonateSpider(e);assert.equal(p.damage.length,1,'detonation once');
  assert.equal(sys.stats.killed,0,'self explosion does not award a kill');
  const blocked=sys.spawn('blastSpider',[0,0,2]);blocked.age=2;
  world._addBox([-2,0,0.7],[2,5,1],FLAG.SOLID,'wall');
  sys._detonateSpider(blocked);assert.equal(p.damage.length,1,'blast blocked by wall');
}
{
  const {sys,p}=setup();const e=sys.spawn('blastSpider',[0,0,2]);e.age=2;
  sys._updateAI(e,0.01,p);sys.damage(e,9999,false,e.pos,null);
  sys.update(2,p);assert.deepEqual(p.damage,[],'killed charging spider never explodes');
}
{
  const {sys,p}=setup();const e=sys.spawn('blastSpider',[0,0,2]);e.age=2;
  sys._updateAI(e,0.01,p);p.alive=false;
  sys.update(1.2,p);
  assert.equal(e.alive,false,'charge fuse continues even after target death');
  assert.deepEqual(p.damage,[],'dead players do not take explosion damage');
  assert.equal(sys.stats.killed,0,'self detonation awards no kill');
}
{
  // Actual World sweep + capsule resolution, not a mocked climbing success.
  const {sys,p,world}=setup(player([0,6,-3]));
  world._addBox([-4,0,-4],[4,5,0],FLAG.SOLID|FLAG.CLIMBABLE,'wall');
  const e=sys.spawn('blastSpider',[0,0,0.65]);e.age=2;
  let maxY=0,climbed=false;
  for(let i=0;i<180;i++) {
    sys._updateAI(e,1/60,p);sys._physics(e,1/60);
    maxY=Math.max(maxY,e.pos[1]);climbed ||= !!e.wallNormal;
    assert.ok(!(e.pos[2]<-0.1 && e.pos[1]<4.8),'no wall penetration');
  }
  assert.ok(climbed,'wall contact enables climbing');
  assert.ok(maxY>4.7,`actual wall ascent: y=${maxY}`);
}
{
  for(let tier=1;tier<=10;tier++) {
    const d=Object.create(Director.prototype);d.tier=tier;
    const t=d._table(),total=Object.values(t).reduce((a,b)=>a+b,0);
    // 需求 11 之后刷怪权重预期变了：绿影只在第三关大量出现，其它关权重归零；
    // 爆蛛仍按 BOSS 层加成。原来「每关新怪合计 > 28%」的断言不再成立，改为分别校验。
    const stalkerShare=(t.stalker||0)/total;
    const spiderShare=(t.blastSpider||0)/total;
    const share=stalkerShare+spiderShare;
    if(tier===3){
      // 第 3 关是绿影主场：它应当占主要权重
      assert.ok(stalkerShare>0.35,`tier3 stalker share ${(stalkerShare*100).toFixed(0)}%`);
      assert.ok(share>0.5,`tier3 retains stalker emphasis`);
    }else{
      // 需求 11：其它关不再刷绿影
      assert.equal(t.stalker,0,`tier${tier} 不应刷绿影（需求11）`);
      // 爆蛛：BOSS 层（3/6/10）高权重，普通层保持基础存在感
      assert.ok(spiderShare>0 && spiderShare<0.12,`tier${tier}: spiders cannot dominate after stalker removal`);
    }
  }
  assert.equal(ENEMY_TYPES.stalker.speed,18);
  assert.equal(ENEMY_TYPES.blastSpider.weapon.damage,50);
}
  const {sys,p}=setup();const e=sys.spawn('blastSpider',[0,0,2]);e.age=2;
  sys.setReplicated(true);sys.update(5,p);assert.deepEqual(p.damage,[],'guest cannot run AI/damage');

{
  const {sys}=setup(); const spider=sys.spawn('blastSpider',[0,2,0]);
  spider.wallNormal=[0,0,1];
  const stalker=sys.spawn('stalker',[3,0,0]);stalker.slashT=0.5;
  const legNames=new Set();let blades=0;
  const write=sys._writeEnemyPart;
  sys._writeEnemyPart=function(slot,en,type,part,...rest) {
    if(part.spiderLeg)legNames.add(part.name);
    if(part.onlyHitrun)blades++;
    write.call(this,slot,en,type,part,...rest);
  };
  const meshes=Object.fromEntries(['cube','sphere','cylinder','cone'].map(k=>[k,{}]));
  sys.render({sharedMeshes:meshes,inFrustumSphere:()=>true,drawInstanced(_m,matrices){
    assert.ok([...matrices].every(Number.isFinite),'wall-oriented models have finite transforms');
  }});
  assert.equal(legNames.size,16,'eight legs, two segments per leg');
  assert.equal(blades,1,'stalker carries a blade rather than a gun');
}
console.log('PASS special enemies: one-hit retreat cycle, 18m/s, exact 50 damage, charge/cancel/AOE/LOS, real wall climb, spawn weights, authority');
