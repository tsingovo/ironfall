import assert from 'node:assert/strict';
import { Run, RUN_PHASE } from '../src/run.js';
import { Director } from '../src/director.js';
import * as Events from '../src/core/events.js';

const player = { alive: true, pos: [0, 0, 0], state: { grounded: true } };
const world = { objectives: () => [], supplyStations: () => [],
  extractPoints: () => [{pos:[10,0,0],radius:3},{pos:[100,0,0],radius:3}] };
for (let tier=1;tier<=11;tier++) {
  player.pos=[0,0,0];
  const run=new Run(world,player);
  run.start(tier,tier-1);
  assert.ok(run.bossPending);
  player.pos=[10,0,0]; run.update(.1,player);
  assert.equal(run.phase,RUN_PHASE.OBJECTIVES,'arrival before boss defeat cannot win');
  assert.equal(run.currentObjectivePoint(),null,'no tracked mission waypoint');
  run.bossPending=false;
  player.pos=[0,0,0]; run.update(.1,player);
  assert.equal(run.phase,RUN_PHASE.EXTRACT_READY,'even tenth floor must extract');
  assert.deepEqual(run.activeExtract.pos,[10,0,0]);
  player.pos=[100,0,0]; run.update(1.0,player);
  assert.equal(run.phase,RUN_PHASE.EXTRACTING,'any extraction point starts hold');
  player.pos=[0,0,0]; run.update(.1,player);
  assert.equal(run.phase,RUN_PHASE.EXTRACT_READY,'leaving before two seconds cancels hold');
  assert.equal(run.extractHold,0);
  player.pos=[100,0,0]; run.update(2.01,player);
  assert.equal(run.phase,RUN_PHASE.EXTRACTED,'two continuous seconds at any exit succeeds');
}
const guest=new Run(world,player);guest.start(3,2);guest.authoritativeObjectives=false;
guest.bossPending=false;guest.update(.1,player);
assert.equal(guest.phase,RUN_PHASE.OBJECTIVES,'guest cannot promote itself');
const host=new Run(world,player);host.start(3,2);host.bossPending=false;
player.pos=[0,0,0];host.objectiveInteractors=[player,{alive:true,pos:[100,0,0]}];
host.update(2.01,player);assert.equal(host.phase,RUN_PHASE.EXTRACTED,'living teammate can hold and extract');
const d=Object.create(Director.prototype);d.tier=10;
assert.equal(d.spawnOpeningWave(),0);d._trySpawnWave();assert.equal(d.spawnCooldown,1);
console.log('PASS: eleven-tier boss gate, any exit, two-second hold, guest authority, teammate exit, no tier10 ambient');
