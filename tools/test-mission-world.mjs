// Narrow, CPU-only regression: first-mission lava and visible mission locations.
import assert from 'node:assert/strict';
import { generateMap } from '../src/maps/builtin-maps.js';
import { World, FLAG } from '../src/world.js';
import { Run } from '../src/run.js';

const draws = [];
const engine = {
  createMesh: () => ({}), destroyMesh() {}, setLighting() {},
  drawMesh(mesh, matrix, opts) { draws.push({ mesh, matrix, opts }); },
  drawInstanced() {},
};
const world = new World(engine);
const centralLava = h => h.kind === 'lava' && !h.terrainIntegrated
  && h.min[0] < 0 && h.max[0] > 0 && h.min[2] < 0 && h.max[2] > 0;
for (const seed of [1337, 1337 + 7919]) {
  const opts = { seed, biome: 'industrial_forge', archetype: 'foundry_hall', size: 320, tier: 1 };
  const original = generateMap(opts);
  const first = generateMap({ ...opts, missionId: 'm01' });
  assert.equal(original.hazards.filter(centralLava).length, 1);
  assert.equal(first.hazards.filter(centralLava).length, 0);
  assert.deepEqual(first.hazards, original.hazards.filter(h => !centralLava(h)), 'peripheral lava remains');
  assert.deepEqual({ ...first, hazards: [] }, { ...original, hazards: [] }, 'structures, terrain and mission points unchanged');
  assert.deepEqual(generateMap({ ...opts, missionId: 'm02' }), original, 'other missions are untouched');
  world.load(first);
  assert.equal(world.hazardAt([0, 0.25, 0]), null, 'central lava damage removed');
  assert.equal(world._missionVisuals.length, first.objectives.length + first.extractPoints.length);
  assert.ok(world._hazardSurfaceData.count > 0, 'peripheral hazards remain visible');
}
console.log('PASS first-mission central lava removed at source for initial and repeat seeds');

const fixture = {
  size: 100, terrain: { resolution: 16, baseHeight: 0, amplitude: 0 },
  objectives: ['destroy', 'recover', 'capture', 'sabotage', 'custom'].map((type, i) => ({
    id: `o${i}`, type, pos: [i * 10, 0, 0], radius: 3, hp: 40,
  })),
  extractPoints: [{ pos: [-15, 0, 0], radius: 6 }],
  supplyStations: [{ pos: [-30, 0, 0], radius: 3 }],
};
world.load(fixture);
assert.equal(world._missionVisuals.length, 6, 'one model per objective and extraction point');
assert.equal(world._supplyVisualData.body.count, 4, 'existing supply model not duplicated');
assert.equal(world.boxes.length, 0, 'mission models do not obstruct interaction or movement');
draws.length = 0;
world.render();
for (const visual of world._missionVisuals) {
  assert.equal(draws.filter(d => d.matrix === visual.matrix).length, 1);
  assert.ok(visual.matrix[0] > 1 && visual.matrix[5] > 1 && visual.matrix[10] > 1);
  assert.equal(visual.matrix[12], visual.point.pos[0]);
  assert.equal(visual.matrix[14], visual.point.pos[2]);
  assert.ok(visual.matrix[13] > visual.point.pos[1], 'model sits above point surface');
}
console.log('PASS all objective types (including fallback), extraction and supply have non-duplicated models');

const player = { pos: [0, 0, -5], state: { grounded: true, speed: 0 }, alive: true };
const run = new Run(world, player, {}, {});
run.start(1, 0); run.phase = 'objectives';
const origin = [0, 0.9, -5], direction = [0, 0, 1];
const hit = world.raycast(origin, direction, 8);
assert.equal(hit.kind, 'objective');
assert.ok(Math.abs(hit.t - 4.3) < 0.001, 'raycast matches cube front face');
assert.ok(run.damageObjectiveAt(hit.point, 40), 'normal world hit can damage visible destroy model');
assert.ok(world.objectives()[0].done, 'completion is shared with renderer');
draws.length = 0;
world.render();
const bodyDraw = draws.find(d => d.matrix === world._missionVisuals[0].matrix);
assert.deepEqual(bodyDraw.opts.color, [0.22, 0.26, 0.28, 1], 'completed target becomes inactive');
assert.equal(world.raycast(origin, direction, 8, { hitBoxes: false }).hit, false);
assert.equal(world.raycast(origin, direction, 8, { ignoreFlags: FLAG.BREAKABLE }).hit, false);
world._addBox([-2, 0, -3], [2, 2, -2], FLAG.SOLID, 'wall');
assert.equal(world.raycast(origin, direction, 8).kind, 'box', 'wall in front blocks target shots');
run.dispose();
world.load(fixture);
assert.equal(world._missionVisuals.length, 6, 'reload does not accumulate duplicate models');
world.unload();
assert.equal(world._missionVisuals.length, 0);
console.log('PASS destroy model shooting, completion tint, occlusion, ray filters and lifecycle');
