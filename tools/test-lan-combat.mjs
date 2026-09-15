import assert from 'node:assert/strict';
import { Game } from '../src/main.js';
import { Run } from '../src/run.js';
import { WeaponSystem, WEAPONS } from '../src/weapons.js';
import * as Events from '../src/core/events.js';

globalThis.document = { exitPointerLock() {} };
const g = Object.create(Game.prototype);
let settlements = 0, ammoResets = 0;
g.player = { alive: false, pveDeaths: 0, eliminated: false, respawn() { this.alive = true; } };
g.lan = { active: true, isHost: true, players: [{ alive: true, eliminated: false, name: 'friend' }] };
g._cancelHealingUse = g._resetHealing = g._requestPointerLockWithRetry = () => {};
g.findSpawn = () => [0, 0, 0]; g.localSpawnIndex = () => 0;
g.weapons = { resetAmmo() { ammoResets++; } };
g.director = { stop() {} };
g.run = { end() { settlements++; } };
for (let i = 0; i < 10; i++) {
  g.player.alive = false;
  g._handleLanDeath({ pvp: true });
  assert.equal(g.player.pveDeaths, 0);
  assert.equal(g.respawnLan(), true);
}
for (let i = 1; i <= 3; i++) {
  g.player.alive = false;
  g._handleLanDeath({ pvp: false });
  assert.equal(g.player.pveDeaths, i);
  assert.equal(g.respawnLan(), i < 3);
}
assert.equal(ammoResets, 12);
assert.equal(g.player.eliminated, true);
g._updateLanDeathState();
assert.equal(settlements, 0, 'living teammate keeps shared world alive');
assert.equal(g._lanSpectateTarget.name, 'friend');
g.lan.players[0].alive = false;
g.lan.players[0].eliminated = true;
g._updateLanDeathState(); g._updateLanDeathState();
assert.equal(settlements, 1, 'all eliminated settles exactly once');
assert.equal(g.respawnLan(), false);
console.log('PASS PvP unlimited redeploy, third PvE death spectates, all-out settlement once');

const run = new Run({}, {}, {}, { isMultiplayer: () => true });
let localEnd = 0; run.end = () => localEnd++;
Events.emit('player:die', { pvp: true });
assert.equal(run.stats.deaths, 0);
Events.emit('player:die', { pvp: false });
assert.equal(run.stats.deaths, 1);
assert.equal(localEnd, 0);
run.dispose();
console.log('PASS individual multiplayer deaths do not settle or pollute PvP failure count');

const w = Object.create(WeaponSystem.prototype);
w.mods = { weapon: {} };
w.world = { raycast: () => ({ hit: true, t: 10, point: [0,0,-10], normal: [0,0,1] }) };
w.enemies = { raycastEnemies: () => null };
let sent = 0;
const offDamage = Events.on('net:damage-player', p => { sent++; assert.equal(p.targetId, 'peer'); assert.equal(p.damage, 18); });
const offRay = Events.on('net:raycast-player', q => { q.hit = { id: 'peer', t: 5, point: [0,0,-5] }; });
const r = w._hitscan([0,0,0], [0,0,-1], WEAPONS.r99, {}, false);
assert.equal(r.playerId, 'peer'); assert.equal(sent, 1);
offRay(); offDamage();
console.log('PASS friendly hitscan routes player damage before farther world surface');
