import assert from 'node:assert/strict';
import { LanSession, LAN_PHASE, LAN_ROLE } from '../src/net/session.js';
import { MSG, FLAG } from '../src/net/protocol.js';

const game = () => ({player:{pos:[0,0,0],vel:[0,0,0],eyePos:[0,1.6,0],health:100,shield:75,maxHealth:100,maxShield:75,alive:true,state:{},grapple:{active:false}},weapons:{slots:[{id:'r99'}],current:{id:'r99'},projectiles:{spawnTracer(){}}},enemyTypeIds:['grunt']});
const host = new LanSession(game()), guest = new LanSession(game());
for (const [s,id,role] of [[host,'h',LAN_ROLE.HOST],[guest,'g',LAN_ROLE.GUEST]]) {
 s.role=role; s.phase=LAN_PHASE.LOBBY;s.hostId='h';s._t.selfId=id;
 s._t.sendState=()=>{};
 s._applyRoster({peers:[{id:'h',name:'房主',isHost:true},{id:'g',name:'朋友'}]});
}
assert.equal(host.squadList().length,2);
assert.equal(host.squadList()[1].name,'朋友');
const sent=[]; host._t.sendGame=(data)=>{sent.push(data);guest._onGameMessage('h',data);return true};
let starts=0; guest.onSessionStart=()=>starts++;
// Host started before this guest joined: HELLO recovers session and duplicate reply does not restart it.
host._sessionInfo={mapIndex:2,seed:53,tier:1};host._sessionKey='test-round';host.phase=LAN_PHASE.PLAYING;
host._onGameMessage('g',{k:MSG.HELLO});
assert.equal(guest.active,true); assert.equal(starts,1);
host._onGameMessage('g',{k:MSG.HELLO});assert.equal(starts,1);
let incoming;
guest.game.player.applyDamage=(amount,dir,source)=>incoming={amount,source};
guest._onGameMessage('stranger',{k:MSG.DAMAGE,to:'g',a:18,source:'player'});assert.equal(incoming,undefined);
guest._onGameMessage('h',{k:MSG.DAMAGE,to:'g',a:18,source:'player'});assert.equal(incoming.source.kind,'player');
// State replicates held item, grapple endpoint, PvE failure count.
guest._onGameMessage('h',{k:MSG.PLAYER,s:[0,0,-5,0,0,0,0,0,100,75,1,FLAG.ALIVE|FLAG.GRAPPLE,0,0,100,75],w:'sentinel',item:'battery',g:[2,3,4],deaths:2,eliminated:false});
assert.equal(guest.remotes.get('h').weaponId,'sentinel');
assert.equal(guest.nameplates()[0].heldItem,'battery');
assert.deepEqual(guest.remotes.get('h').grapple.point,[2,3,4]);
const q={origin:[0,1,0],dir:[0,0,-1],maxDistance:10};guest.raycastPlayer(q);assert.equal(q.hit.id,'h');
const blocked={origin:[0,1,0],dir:[0,0,-1],maxDistance:2};guest.raycastPlayer(blocked);assert.equal(blocked.hit,undefined);
let tracers=0;guest.game.weapons.projectiles.spawnTracer=()=>tracers++;
guest._onGameMessage('h',{k:MSG.SHOT,o:[0,1,-5],d:[0,0,-1],e:[0,1,-20],w:'sentinel'});assert.equal(tracers,1);
// Real snapshot loop creates the missing enemy in the guest's replicated world.
const all=[];guest.game.enemies={findByNetId:id=>all.find(e=>e.id===id),spawn(type,pos,opts){const e={id:opts.id,typeId:type,pos,yaw:0};all.push(e);return e},applyNetState(e,hp,shield,alive){Object.assign(e,{hp,shield,alive})},removeByNetId(){}};
guest._onGameMessage('h',{k:MSG.ENEMY,e:[[7,0,1,0,3,0,100,75,1,100,75,1,'approach',0,null,0]]});
assert.equal(all[0].id,7);assert.equal(all[0].alive,true);
for(const s of [host,guest])for(const off of s._eventOff)off();
console.log('PASS: late join/session dedup, roster, enemy, equipment/grapple/nameplates, tracer, PvP validation/raycast');
