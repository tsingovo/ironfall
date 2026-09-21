import assert from 'node:assert/strict';
import { BOSS_SHAPES, getBossShape, poseBossPart, bossModelRadius } from '../src/fx/boss-models.js';
import { EnemySystem, ENEMY_TYPES } from '../src/enemies.js';

const meshes=new Set(['cube','sphere','cone','wedge']);
for(const [kind,shape] of Object.entries(BOSS_SHAPES)) {
  assert.ok(shape.length>=12 && shape.length<=45,`${kind}: bounded low-poly parts`);
  assert.equal(new Set(shape.map(p=>p.name)).size,shape.length,`${kind}: unique names`);
  for(const p of shape) {
    assert.ok(meshes.has(p.mesh));
    for(const a of [p.offset,p.size,p.color,p.rot||[0,0,0]]) assert.ok(a.length===3 && a.every(Number.isFinite));
    assert.ok(p.size.every(n=>n>0));
  }
  const snapshot=JSON.stringify(shape);
  for(const state of [{},{smashPhase:'smash',smashT:.7},{divePhase:'dive'},{chargePhase:'charge'}, {grounded:false,punchT:.9,seedT:4.9}]) {
    const en={type:{bossKind:kind},age:1.3,animPhase:1,scale:1,...state};
    for(const p of shape) {
      const out=poseBossPart(en,p);
      assert.ok(out.offset.every(Number.isFinite));
      assert.ok((out.rot||[]).every(Number.isFinite));
      assert.ok(Math.hypot(...out.offset)<bossModelRadius(en)+6);
    }
  }
  assert.equal(JSON.stringify(shape),snapshot,'animation must not mutate shared parts');
}
const tank=BOSS_SHAPES.shieldMech;
assert.equal(tank.filter(p=>p.name.startsWith('track')).length,2);
assert.ok(tank.filter(p=>p.name.startsWith('shield')).every(p=>Math.min(...p.size)<.3),'open shield, never solid front panel');
const slender=BOSS_SHAPES.slenderKiller;
assert.equal(Math.max(...slender.map(p=>p.offset[1]+p.size[1]/2)),10.8,'six-player-height silhouette');
assert.equal(BOSS_SHAPES.corruptDragon.filter(p=>p.name.startsWith('dragonLeg')).length,4);
assert.equal(BOSS_SHAPES.ghostKnight.filter(p=>p.name.startsWith('horseLeg')).length,4);
assert.equal(BOSS_SHAPES.boxer.filter(p=>p.name.startsWith('head')).length,2);
assert.equal(BOSS_SHAPES.boxer.filter(p=>p.name.startsWith('glove')).length,2);
assert.equal(getBossShape({cloneOf:'tier7Vat'}),BOSS_SHAPES.cloneGoblin);
assert.equal(getBossShape({meshKind:'heavy'}),null,'ordinary enemies unchanged');
const wing=BOSS_SHAPES.corruptDragon.find(p=>p.group==='wing');
assert.notDeepEqual(poseBossPart({type:{},divePhase:'dive'},wing).offset,wing.offset);
const arm=slender.find(p=>p.group==='smash');
assert.notDeepEqual(poseBossPart({type:{smashTime:1.5},smashPhase:'smash',smashT:.5},arm).offset,arm.offset);
const glove=BOSS_SHAPES.boxer.find(p=>p.name==='glove1');
assert.ok(poseBossPart({type:{},punchT:1},glove).offset[2]<glove.offset[2]);
console.log('PASS: eight dedicated boss/clone silhouettes, open shield, height, limbs and state-driven animation');

// Exercise the actual renderer integration, not only detached shape data.
for (const type of Object.values(ENEMY_TYPES).filter(t=>getBossShape(t))) {
  const sys=new EnemySystem({},null,null);
  const enemy=sys.spawn(type.id,[0,0,0]);
  let draws=0,field=0;
  sys.render({sharedMeshes:Object.fromEntries([...meshes].map(k=>[k,{}])),
    inFrustumSphere:()=>true,drawInstanced(_mesh,matrices,_n,opts){
      draws++; assert.ok([...matrices].every(Number.isFinite));
      if(opts.program==='additive'){field++;assert.equal(opts.depthWrite,false);}
    }});
  assert.equal(draws,getBossShape(type).length,`${type.id}: no humanoid fallback or missing mesh`);
  if(type.bossKind==='shieldMech')assert.equal(field,1);
  if(type.cloneOf)assert.equal(enemy.scale,1);
}
console.log('PASS: all dedicated models actually submitted by EnemySystem, translucent shield pass');
