import assert from 'node:assert/strict';
import { AvatarRenderer } from '../src/net/avatar.js';
import { HUD } from '../src/ui/hud.js';

const calls=[];
const engine={sharedMeshes:{cube:{}},inFrustumSphere:()=>true,
  drawInstanced(mesh,mats,count,opts){calls.push({mats:Float32Array.from(mats),count,opts});}};
const renderer=new AvatarRenderer(engine);
const peer={pos:[2,0,3],yaw:.3,alive:true,heldItem:'r99'};
renderer.render(engine,[peer],.016);
assert.equal(calls.length,2,'rim and opaque body: exactly two batches');
const [rim,body]=calls;
assert.equal(rim.opts.depthWrite,false,'outline must not poison depth');
assert.equal(rim.opts.noDepthTest,false,'outline must be occluded by world depth');
assert.equal(rim.opts.unlit,true,'bright rim independent of map lighting');
assert.equal(body.opts.depthWrite,true);
assert.equal(body.opts.noDepthTest,false);
assert.equal(body.count,rim.count);
for(let i=0;i<body.count;i++) {
  const at=i*16;
  assert.deepEqual([...rim.mats.slice(at+12,at+16)],[...body.mats.slice(at+12,at+16)],'no camera offset / wall penetration hack');
  for(let axis=0;axis<3;axis++) {
    const b=at+axis*4;
    const size=m=>Math.hypot(m[b],m[b+1],m[b+2]);
    assert.ok(Math.abs(size(rim.mats)-size(body.mats)-.018)<1e-6,'thin fixed world-space shell');
  }
}
calls.length=0;
engine.inFrustumSphere=()=>false;
assert.equal(renderer.render(engine,[peer]),0,'out-of-view models generate no rim');
assert.equal(calls.length,0);
engine.inFrustumSphere=()=>true;
renderer.render(engine,[{...peer,alive:false}]);
assert.equal(calls.length,1,'no alive-player glow on corpses');
renderer.render(engine,[]);
assert.equal(renderer.debugState().rimInstances,0);

let removed=0,created=0;
const hud={_lanNameplateEls:[{remove(){removed++;}},{style:{}}],doc:{createElement(){created++;}}};
HUD.prototype.setLanNameplates.call(hud,[peer],engine);
assert.equal(removed,1);
assert.equal(created,0,'compatibility call never makes labels or arrows');
assert.deepEqual(hud._lanNameplateEls,[]);
HUD.prototype.setLanNameplates.call(hud,[peer],engine);
assert.equal(created,0);
console.log('PASS: player rim two-pass depth contract, off-screen culling, no DOM position labels');
