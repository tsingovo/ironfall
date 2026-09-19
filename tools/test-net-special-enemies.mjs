import assert from 'node:assert/strict';
import * as Events from '../src/core/events.js';
import { LanSession, LAN_PHASE, LAN_ROLE } from '../src/net/session.js';
import { NET_STATUS } from '../src/net/transport.js';
import { MSG, EV, ENEMY_TUPLE, NET_VERSION, PROTOCOL_VERSION } from '../src/net/protocol.js';

assert.equal(NET_VERSION, '4');
assert.equal(PROTOCOL_VERSION, 4);
assert.equal(ENEMY_TUPLE, 16);
const ids = ['grunt', 'stalker', 'blastSpider', 'broodStalker'];
function makeGame() {
  const all = [];
  return { enemyTypeIds: ids, enemies: {
    all, findByNetId: id => all.find(e => e.id === id),
    spawn(typeId, pos, opts) {
      const e = { ...opts, typeId, pos, alive: true };
      all.push(e);
      return e;
    },
    applyNetState(e, hp, shield, alive) { Object.assign(e, { hp, shield, alive }); },
    removeByNetId(id) { const i = all.findIndex(e => e.id === id); if (i >= 0) all.splice(i, 1); },
    damage() { assert.fail('Visual replication must not invoke damage'); },
    update() { assert.fail('Visual replication must not run enemy AI'); },
  } };
}
const host = new LanSession(makeGame()), guest = new LanSession(makeGame());
try {
  for (const [s, id, role] of [[host, 'h', LAN_ROLE.HOST], [guest, 'g', LAN_ROLE.GUEST]]) {
    s.role = role; s.phase = LAN_PHASE.PLAYING; s.hostId = 'h';
    s._t.selfId = id; s._t.status = NET_STATUS.ONLINE;
  }
  const messages = [], effects = [];
  host._t.sendGame = (data, opts) => {
    messages.push({ data, opts });
    guest._onGameMessage('h', JSON.parse(JSON.stringify(data)));
    return true;
  };
  guest._t.sendGame = () => assert.fail('Guest must not rebroadcast effects');
  guest.game.enemies.playSpecialFx = (kind, pos) => effects.push({ kind, pos });
  host.game.enemies.all.push({ id: 7, typeId: 'stalker', pos: [1, 2, 3], yaw: 0.4,
    hp: 90, shield: 0, maxHp: 90, maxShield: 0, alive: true, scale: 1,
    specialPhase: 'windup', specialTimer: 0.325, wallNormal: null, slashT: 0.85 });
  host.game.enemies.all.push({ id: 8, typeId: 'blastSpider', pos: [4, 5, 6], yaw: 1,
    hp: 60, shield: 0, maxHp: 60, maxShield: 0, alive: true, scale: 1,
    specialPhase: 'charge', specialTimer: 1.2, wallNormal: [1, 0, 0], slashT: 0 });
  host.game.enemies.all.push({id:9,typeId:'broodStalker',pos:[8,12,0],yaw:0,
    hp:3075,shield:225,maxHp:3075,maxShield:225,alive:true,scale:1.6,
    specialPhase:'retreat',specialTimer:0,wallNormal:[0,0,1],slashT:0.4});
  host._broadcastEnemySnapshot();
  assert.equal(messages[0].data.e[0].length, ENEMY_TUPLE);
  const stalker = guest.game.enemies.findByNetId(7), spider = guest.game.enemies.findByNetId(8);
  assert.equal(stalker.typeId, 'stalker');
  assert.equal(stalker.specialPhase, 'windup');
  assert.equal(stalker.specialTimer, 0.33);
  assert.equal(stalker.slashT, 0.85);
  assert.equal(stalker.wallNormal, null);
  assert.equal(spider.typeId, 'blastSpider');
  const boss=guest.game.enemies.findByNetId(9);
  assert.equal(boss.typeId,'broodStalker');assert.equal(boss.maxHp,3075);
  assert.equal(boss.scale,1.6);assert.deepEqual(boss.wallNormal,[0,0,1]);
  assert.equal(spider.specialPhase, 'charge');
  assert.equal(spider.specialTimer, 1.2);
  assert.deepEqual(spider.wallNormal, [1, 0, 0]);
  // Snapshot updates (including late join/full snapshots) reset stale visual state.
  host.game.enemies.all[0].specialPhase = 'retreat';
  host.game.enemies.all[1].wallNormal = null;
  host._broadcastEnemySnapshot();
  const rows = messages.at(-1).data.e;
  guest._onGameMessage('h', { k: MSG.ENEMY_FULL, e: rows });
  assert.equal(stalker.specialPhase, 'retreat');
  assert.equal(spider.wallNormal, null);
  const invalid = rows.map(row => row.slice());
  invalid[0].splice(12, 4, 'unknown', Infinity, [NaN, 0, 1], -4);
  invalid[1].splice(12, 4, 'charge', 10000, [0, 4, 0], 100);
  guest._onGameMessage('other', { k: MSG.ENEMY, e: invalid });
  assert.equal(stalker.specialPhase, 'retreat');
  guest._onGameMessage('h', { k: MSG.ENEMY, e: invalid });
  assert.equal(stalker.specialPhase, 'approach');
  assert.equal(stalker.specialTimer, 0);
  assert.equal(stalker.wallNormal, null);
  assert.equal(stalker.slashT, 0);
  assert.equal(spider.specialTimer, 60);
  assert.deepEqual(spider.wallNormal, [0, 1, 0]);
  assert.equal(spider.slashT, 1);
  for (const kind of ['spider-charge', 'spider-explode', 'stalker-slash', 'boss-summon']) {
    const before = messages.length;
    Events.emit('enemy:special-fx', { kind, pos: [1, 2, 3] });
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1).opts.reliable, true);
    assert.deepEqual(effects.at(-1), { kind, pos: [1, 2, 3] });
  }
  const packet = { k: MSG.WORLD_EVENT, e: EV.ENEMY_SPECIAL_FX, kind: 'spider-explode', pos: [1, 2, 3] };
  const count = effects.length;
  guest._onGameMessage('other', packet);
  host._onGameMessage('g', packet);
  guest._onWorldEvent('other', packet);
  for (const bad of [{ kind: 'unknown' }, { pos: [Infinity, 0, 0] }, { pos: [1, 2] },
    { pos: [1, 2, 3, 4] }, { pos: ['1', 2, 3] }, { pos: [1e20, 2, 3] }, { pos: null }]) {
    const n = messages.length;
    guest._onGameMessage('h', { ...packet, ...bad });
    Events.emit('enemy:special-fx', { ...packet, ...bad });
    assert.equal(messages.length, n);
  }
  guest.phase = LAN_PHASE.LOBBY;
  guest._onGameMessage('h', packet);
  assert.equal(effects.length, count);
  host._t.status = NET_STATUS.CLOSED;
  const n = messages.length;
  Events.emit('enemy:special-fx', packet);
  assert.equal(messages.length, n);
  console.log('PASS: protocol v4, special enemy snapshot/full-state roundtrip, bounded fields, reliable host-only visual FX, invalid packet rejection, no guest AI/damage/rebroadcast');
} finally {
  for (const session of [host, guest]) for (const off of session._eventOff) off();
}
