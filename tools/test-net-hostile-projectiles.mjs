import assert from 'node:assert/strict';
import { ProjectilePool } from '../src/fx/projectiles.js';
import { LanSession, LAN_ROLE, LAN_PHASE } from '../src/net/session.js';
import { MSG } from '../src/net/protocol.js';

function game() {
  return { player: { pos: [0, 0, 0] }, enemyTypeIds: [],
    weapons: { projectiles: new ProjectilePool(null), slots: [{ id: 'r99' }] },
    world: { raycast: () => null },
    enemies: { all: [], findByNetId: () => null, raycastEnemies: () => null,
      replicated: false, players: [{ pos: [0, 0, -5], alive: true,
        applyDamage() { assert.fail('Guest mirror must never damage'); } }] } };
}
const host = new LanSession(game()), guest = new LanSession(game());
const spawn = () => host.game.weapons.projectiles.spawn([0, 0.9, -5], [0, 0, 1], 10,
  { ownerId: -1, hp: 1, homing: true, damage: 40, width: 0.5, life: 10 });
try {
  host.role = LAN_ROLE.HOST; guest.role = LAN_ROLE.GUEST;
  host.phase = guest.phase = LAN_PHASE.PLAYING; guest.hostId = 'h';
  host.remotes.set('g', { _hasTarget: true, pos: [0, 0, 0], alive: true, weaponId: 'r99' });
  host._t.sendGame = packet => guest._onGameMessage('h', JSON.parse(JSON.stringify(packet)));
  const hp = host.game.weapons.projectiles, gp = guest.game.weapons.projectiles;
  spawn(); host._broadcastEnemySnapshot();
  assert.equal(gp.count, 1); assert.equal(gp.netMirror[0], 1); assert.equal(gp.damage[0], 0);
  gp.update(0.1, null, guest.game.enemies);
  assert.equal(gp.pz[0], -5, 'mirror does not home/move even if caller forgot replicated flag');
  guest._onGameMessage('stranger', { k: MSG.ENEMY, e: [], p: [] });
  assert.equal(gp.count, 1, 'non-host snapshot rejected');
  const shot = { k: MSG.SHOT, o: [0, 0.9, 0], d: [0, 0, -1], e: [0, 0.9, -10], w: 'r99' };
  host._onGameMessage('g', { ...shot, o: [100, 0, 0] });
  assert.equal(hp.hp[0], 1, 'invalid remote origin rejected');
  host.game.world.raycast = () => ({ hit: true, t: 2 });
  host._onGameMessage('g', shot); assert.equal(hp.hp[0], 1, 'world cover blocks remote interception');
  host.game.world.raycast = () => null;
  host.game.enemies.raycastEnemies = () => ({ t: 2 });
  host._onGameMessage('g', shot); assert.equal(hp.hp[0], 1, 'nearer enemy blocks remote interception');
  host.game.enemies.raycastEnemies = () => null;
  host._onGameMessage('g', shot); assert.equal(hp.hp[0], 0, 'guest shot intercepts on host');
  host._broadcastEnemySnapshot(); assert.equal(gp.count, 0, 'destroyed projectile disappears on guest');
  spawn(); host._broadcastEnemySnapshot(); assert.equal(gp.count, 1);
  gp.applyHostileSnapshot([[NaN], [0, 0, 0, 0, 0, 0, 100, 1, 1, 0, 1, 0, 0]]);
  assert.equal(gp.count, 0, 'malformed rows cannot populate mirror pool');
  console.log('PASS network hostile bullets: host snapshots, guest pure mirrors, host-only trust, remote actual-shot interception, cover, despawn');
} finally {
  for (const session of [host, guest]) for (const off of session._eventOff) off();
}
