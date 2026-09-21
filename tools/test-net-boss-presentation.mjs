import assert from 'node:assert/strict';
import { LanSession, LAN_ROLE, LAN_PHASE } from '../src/net/session.js';
import { MSG, ENEMY_TUPLE, sanitizeBossPresentation } from '../src/net/protocol.js';

function game() {
  const all = [];
  return { enemyTypeIds: ['boss', 'grunt'], enemies: {
    all, findByNetId: id => all.find(e => e.id === id),
    spawn(typeId, pos, opts) {
      const e = { ...opts, typeId, pos, type: { tierBoss: typeId === 'boss' } };
      all.push(e); return e;
    },
    applyNetState(e, hp, shield, alive) { Object.assign(e, { hp, shield, alive }); },
    removeByNetId(id) { all.splice(all.findIndex(e => e.id === id), 1); },
    update() { assert.fail('Guest must not run AI'); },
    damage() { assert.fail('Presentation must not cause damage'); },
  } };
}
const host = new LanSession(game()), guest = new LanSession(game());
try {
  host.role = LAN_ROLE.HOST; guest.role = LAN_ROLE.GUEST;
  guest.hostId = 'h'; guest.phase = LAN_PHASE.PLAYING;
  let packet;
  host._t.sendGame = data => {
    packet = JSON.parse(JSON.stringify(data));
    guest._onGameMessage('h', packet);
  };
  const boss = { id: 1, typeId: 'boss', type: { tierBoss: true }, pos: [1, 2, 3],
    yaw: 0.3, hp: 500, maxHp: 500, shield: 0, maxShield: 0, alive: true,
    nightmareDirectDamage: true,
    smashPhase: 'smash', smashT: 1.23, divePhase: 'dive', chargePhase: 'charge',
    vel: new Float32Array([2, -3, 4]), hopVy: -4.5, age: 123.45, teleportSeq: 0,
    grounded: true, punchT: 0.9, seedT: 4, laserT: 1.1, laserTarget: [12, 3, 5] };
  host.game.enemies.all.push(boss, { ...boss, id: 2, typeId: 'grunt', type: {} });
  host._broadcastEnemySnapshot();
  assert.equal(ENEMY_TUPLE, 16);
  assert.equal(packet.e[0].length, 17);
  assert.equal(packet.e[1].length, 16);
  const copy = guest.game.enemies.findByNetId(1);
  assert.equal(copy.nightmareDirectDamage, true, 'nightmare clone-vat damage mode is replicated');
  for (const [key, value] of Object.entries(sanitizeBossPresentation(boss))) assert.deepEqual(copy[key], value, key);
  boss.pos = [3, 2, 3]; host._broadcastEnemySnapshot();
  assert.equal(copy.pos[0], 1, 'ordinary movement uses interpolation');
  guest._interpolateEnemies(0.02);
  assert.ok(copy.pos[0] > 1 && copy.pos[0] < 3);
  boss.pos = [4, 2, 3]; boss.teleportSeq++; boss.yaw = 2;
  host._broadcastEnemySnapshot();
  assert.deepEqual(copy.pos, boss.pos, 'even short teleports snap');
  assert.equal(copy.yaw, 2);
  boss.pos = [100, 2, 3]; host._broadcastEnemySnapshot();
  assert.deepEqual(copy.pos, boss.pos, 'large correction snaps');
  const malicious = JSON.parse(JSON.stringify(packet));
  malicious.e[0][16] = { smashPhase: 'oops', smashT: Infinity, divePhase: '__proto__',
    chargePhase: 'bad', vel: [NaN, 2, 3], hopVy: -1e8, age: 1e20, teleportSeq: -1,
    hp: -1, alive: false, type: { weapon: { damage: 999 } }, __proto__: { poisoned: true } };
  guest._onGameMessage('other', malicious);
  assert.equal(copy.smashPhase, 'smash', 'non-host rejected');
  guest._onGameMessage('h', malicious);
  assert.equal(copy.hp, 500); assert.equal(copy.alive, true);
  assert.equal(copy.smashPhase, 'hunt'); assert.equal(copy.smashT, 0);
  assert.equal(copy.divePhase, 'circle'); assert.equal(copy.chargePhase, 'aim');
  assert.deepEqual(copy.vel, [0, 0, 0]); assert.equal(copy.hopVy, -200);
  assert.equal(copy.age, 1e7); assert.equal(copy.poisoned, undefined);
  const legacy = packet.e.map(row => row.slice(0, 16));
  guest._onGameMessage('h', { k: MSG.ENEMY_FULL, e: legacy });
  assert.equal(copy.smashPhase, 'hunt'); assert.equal(copy.age, 0);
  assert.deepEqual(copy.vel, [0, 0, 0]);
  for (const invalid of [null, [], 'bad', 12]) assert.deepEqual(sanitizeBossPresentation(invalid), sanitizeBossPresentation({}));
  let damageOptions;
  host.game.enemies.damage = (_e, _amount, _head, _point, _normal, opts) => { damageOptions = opts; };
  const remote = { pos: [100, 2, 2], alive: true, weaponId: 'melee' };
  host.remotes.set('g', remote);
  const hit = [1, 10, false, 100, 2, 3, 0, 0, 1, true];
  host._applyRemoteHits('g', [hit]); assert.equal(damageOptions.melee, true);
  remote.weaponId = 'r99';
  host._applyRemoteHits('g', [hit]); assert.equal(damageOptions.melee, false, 'gun cannot claim melee');
  remote.weaponId = 'melee'; remote.pos = [0, 0, 0];
  host._applyRemoteHits('g', [hit]); assert.equal(damageOptions.melee, false, 'remote melee rejected');
  remote.pos = [100, 2, 2];
  host._applyRemoteHits('g', [hit.slice(0, 9)]); assert.equal(damageOptions.melee, true, 'legacy melee inference');
  console.log('PASS: boss presentation roundtrip, legacy/full snapshot, strict whitelist, host-only, teleport/correction snap, no guest AI/damage');
} finally {
  for (const session of [host, guest]) for (const off of session._eventOff) off();
}
