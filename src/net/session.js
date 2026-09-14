// ==== net/session.js — 局域网合作会话（大厅、玩家复制、敌人同步、伤害转发）====
//
// 权威模型（刻意选择“各自模拟自己的玩家 + 房主权威世界”）：
//
//   房主：用真实 Player 模拟自己；用 EnemySystem 权威模拟敌人与导演；
//         同时为每位房客维护一个 RemotePlayer 代理，供敌人 AI 选目标与造成伤害。
//   房客：同样用真实 Player 本地模拟自己（不做预测/回滚，手感与单机完全一致）；
//         敌人不跑 AI，只按房主快照插值显示；开火命中后就近上报给房主结算。
//
// 为什么不用“房主模拟所有人”：本项目的事件总线是进程级单例，run.js 会把任何
// player:hurt / player:die 计入本机单局状态（见 docs/CONTRACTS.md 与调查报告）。
// 让房主去模拟第二个 Player 会直接污染本机的单局进度、伤害统计与死亡流程。
// 而“各人模拟各人”天然规避了 eyePos/后坐力/RNG 流/模块级 scratch 数组这些
// 无法跨机复现的问题，代价只是不能做玩家之间的物理碰撞。

import * as M from '../core/math.js';
import * as Events from '../core/events.js';
import { NetTransport, NET_STATUS, defaultWsUrl } from './transport.js';
import {
  MSG, SRV, EV, FLAG, EFLAG, createCodec, PLAYER_TUPLE, ENEMY_TUPLE,
  sanitizeChat, q2, q4, q1,
} from './protocol.js';
import { AvatarRenderer } from './avatar.js';

export const LAN_ROLE = Object.freeze({ OFF: 'off', HOST: 'host', GUEST: 'guest' });

export const LAN_PHASE = Object.freeze({
  OFF: 'off',            // 未联机
  CONNECTING: 'connecting',
  LOBBY: 'lobby',        // 已入房，等待房主开局
  PLAYING: 'playing',    // 局内
  FAILED: 'failed',
});

/** 远端玩家：既是渲染/显示用的记录，也是敌人 AI 眼中的“玩家对象” */
export class RemotePlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name || '玩家';
    this.isHost = false;
    this.peerIndex = 0;

    // ---- 敌人 AI 会读的字段（与 src/player.js 的 Player 保持同名同义）----
    this.pos = new Float32Array(3);
    this.vel = new Float32Array(3);
    this.eyePos = new Float32Array(3);
    this.radius = 0.35;
    this.height = 1.8;
    this.currentHeight = 1.8;
    this.health = 100;
    this.shield = 0;
    this.maxHealth = 100;
    this.maxShield = 0;
    this.alive = true;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.state = {
      grounded: true, crouching: false, sliding: false, sprinting: false,
      wallRunning: false, hspeed: 0, speed: 0, moveState: 'GROUNDED',
    };
    this.grapple = { active: false, attachedEnemy: null };
    this.opts = { queryGrappleTarget: () => null };

    // ---- 表现 ----
    this.hitFlash = 0;
    this.weaponId = null;
    this.ads = false;
    this.reloading = false;
    this.firing = false;
    this.latency = 0;
    this.lastPacketAt = 0;

    // ---- 插值 ----
    this._target = new Float32Array(4);   // x, y, z, yaw
    this._hasTarget = false;
    this._snapNext = true;

    /** 由会话注入：把敌人造成的伤害转发给这位玩家本人 */
    this.onDamage = null;
  }

  /** 敌人 AI 通过它扣血：不本地结算，转发给玩家本人执行 */
  applyDamage(amount, dir, source) {
    if (this.onDamage) this.onDamage(amount, dir, source);
    return amount;
  }

  heal() { /* 远程玩家的治疗由本人权威处理 */ }
  addShield() { /* 同上 */ }

  /** 收到一份新状态：写入插值目标 */
  setNetState(decoded) {
    this.health = decoded.health;
    this.shield = decoded.shield;
    this.maxHealth = decoded.maxHealth;
    this.maxShield = decoded.maxShield;
    this.alive = decoded.alive;
    this.weaponId = decoded.weaponId;
    this.ads = decoded.ads;
    this.reloading = decoded.reloading;
    this.firing = decoded.firing;
    const s = this.state;
    s.grounded = decoded.state.grounded;
    s.crouching = decoded.state.crouching;
    s.sliding = decoded.state.sliding;
    s.sprinting = !!decoded.state.sprinting;
    s.hspeed = decoded.hspeed;
    s.speed = decoded.hspeed;
    s.moveState = decoded.moveState;
    this.vel[0] = decoded.vel[0];
    this.vel[1] = decoded.vel[1];
    this.vel[2] = decoded.vel[2];
    this.pitch = decoded.pitch;
    this._target[0] = decoded.pos[0];
    this._target[1] = decoded.pos[1];
    this._target[2] = decoded.pos[2];
    this._target[3] = decoded.yaw;
    if (!this._hasTarget || this._snapNext) {
      this.pos[0] = decoded.pos[0];
      this.pos[1] = decoded.pos[1];
      this.pos[2] = decoded.pos[2];
      this.yaw = decoded.yaw;
      this._hasTarget = true;
      this._snapNext = false;
    }
    // 眼睛位置供敌人视线判定使用（远程没有 shake/bob，取稳定近似值）
    this.eyePos[0] = this.pos[0];
    this.eyePos[1] = this.pos[1] + this.currentHeight * 0.9;
    this.eyePos[2] = this.pos[2];
  }

  /** 每帧把显示位置平滑逼近插值目标（局域网 RTT 极低，可用较高的收敛速度） */
  interpolate(dt, rate = 20) {
    if (!this._hasTarget) return;
    const k = 1 - Math.exp(-rate * dt);
    this.pos[0] += (this._target[0] - this.pos[0]) * k;
    this.pos[1] += (this._target[1] - this.pos[1]) * k;
    this.pos[2] += (this._target[2] - this.pos[2]) * k;
    this.yaw += M.wrapAngle(this._target[3] - this.yaw) * k;
    this.eyePos[0] = this.pos[0];
    this.eyePos[1] = this.pos[1] + this.currentHeight * 0.9;
    this.eyePos[2] = this.pos[2];
    if (this.hitFlash > 0) this.hitFlash -= dt * 4;
  }

  /** 断线/离房后由会话标灰：仍然可见但不再参与敌人仇恨 */
  markStale() {
    this.alive = false;
    this.stale = true;
  }

  squadInfo() {
    return {
      id: this.id,
      name: this.name,
      isHost: this.isHost,
      alive: this.alive,
      health: this.health,
      shield: this.shield,
      maxHealth: this.maxHealth,
      maxShield: this.maxShield,
      latency: Math.round(this.latency),
      stale: !!this.stale,
      weaponId: this.weaponId,
      distance: 0,
    };
  }
}

export class LanSession {
  /**
   * @param {object} game Game 实例（松耦合：只调用少数几个方法）
   */
  constructor(game) {
    this.game = game;
    this.role = LAN_ROLE.OFF;
    this.phase = LAN_PHASE.OFF;
    this.selfName = '玩家';
    this.roomId = 'default';
    this.hostId = null;
    this.roster = [];                 // 服务器名册（含准备状态）
    /** @type {Map<string, RemotePlayer>} */
    this.remotes = new Map();
    this.chat = [];                   // {from, name, text, time, self}
    this.maxChat = 60;
    this.avatar = null;
    this.codec = null;
    this.lastEvent = '';
    this.joinError = '';

    this.onChat = null;               // (entry) => void
    this.onRosterChange = null;       // () => void
    this.onSessionStart = null;       // (sessionInfo) => void
    this.onNotice = null;             // (title, sub, kind) => void

    this._t = new NetTransport({ url: defaultWsUrl(), autoReconnect: true });
    this._t.onMessage = (msg) => this._onServerMessage(msg);
    this._t.onStatus = (status, detail) => this._onStatus(status, detail);
    this._t.onRoster = (msg) => this._onRoster(msg);

    this._selfTuple = new Float64Array(PLAYER_TUPLE);
    this._decoded = null;
    this._sendAcc = 0;
    this._enemyAcc = 0;
    this._runAcc = 0;
    this._stateAcc = 0;
    this._enemySeen = new Set();
    this._enemyTargets = new Map();   // id -> {x,y,z,yaw}
    this._hitQueue = [];
    this._sessionInfo = null;
    this._pendingStart = null;
  }

  // ---------------------------------------------------------------- 查询

  get online() { return this._t.online; }
  get selfId() { return this._t.selfId; }
  get isHost() { return this.role === LAN_ROLE.HOST; }
  get active() { return this.phase === LAN_PHASE.PLAYING; }
  get inSession() { return this.phase === LAN_PHASE.LOBBY || this.phase === LAN_PHASE.PLAYING; }
  get latency() { return Math.round(this._t.latencyAvg || this._t.latency || 0); }
  get peerCount() { return 1 + this.remotes.size; }
  /** 本局配置（地图/种子）；未开局时为 null */
  get sessionInfo() { return this._sessionInfo; }

  /** 供 HUD 使用的一份快照 */
  lobbyState() {
    return {
      role: this.role,
      phase: this.phase,
      status: this._t.status,
      selfId: this._t.selfId,
      selfName: this.selfName,
      room: this.roomId,
      isHost: this.isHost,
      hostId: this.hostId,
      latency: this.latency,
      error: this.joinError || this._t.lastError,
      url: this._t.url,
      peers: this.squadList(),
      chat: this.chat.slice(-8),
      mapIndex: this._sessionInfo ? this._sessionInfo.mapIndex : null,
      mapName: this._sessionInfo ? this._sessionInfo.mapName : '',
    };
  }

  /**
   * 队友列表（含自己），顺序与服务器名册一致。
   *
   * 顺序必须两端一致：出生点就是按这个序号分配的（Game.localSpawnIndex），
   * 如果这里总是把自己排在第一位，四个人会全部拿到 0 号出生点并叠在一起。
   */
  squadList() {
    const p = this.game && this.game.player;
    const selfInfo = () => ({
      id: this._t.selfId || 'me',
      name: this.selfName,
      isHost: this.isHost,
      self: true,
      alive: p ? p.alive : true,
      health: p ? p.health : 0,
      shield: p ? p.shield : 0,
      maxHealth: p ? p.maxHealth : 100,
      maxShield: p ? p.maxShield : 0,
      latency: this.latency,
      stale: false,
    });

    const out = [];
    const roster = Array.isArray(this.roster) ? this.roster : [];
    let placedSelf = false;
    for (const entry of roster) {
      if (!entry || !entry.id) continue;
      if (entry.id === this._t.selfId) { out.push(selfInfo()); placedSelf = true; continue; }
      const r = this.remotes.get(entry.id);
      if (r) out.push({ ...r.squadInfo(), self: false });
    }
    if (!placedSelf) out.unshift(selfInfo());
    return out;
  }

  // ---------------------------------------------------------------- 连接

  _ensureCodec() {
    if (this.codec) return this.codec;
    const game = this.game;
    const weaponIds = game && game.weapons && game.weapons.slots
      ? game.weapons.slots.map((s) => s.id) : [];
    // 兵种槽表必须两端完全一致，所以用 Game 暴露的固定顺序表（ENEMY_IDS），
    // 而不是运行时出现的顺序（那会随当局刷怪顺序变化）。
    this.codec = createCodec({ weapons: weaponIds, enemyTypes: this._enemyTypeIds() });
    return this.codec;
  }

  _enemyTypeIds() {
    // 由 Game 注入，避免 net/* 反向 import enemies.js（依赖方向约束见 CONTRACTS 0.5）。
    const ids = this.game && this.game.enemyTypeIds;
    return Array.isArray(ids) ? ids : [];
  }

  async host(name) {
    this.role = LAN_ROLE.HOST;
    this.selfName = sanitizeNameForUI(name) || '房主';
    return this._connect();
  }

  async join(name) {
    this.role = LAN_ROLE.GUEST;
    this.selfName = sanitizeNameForUI(name) || '玩家';
    return this._connect();
  }

  async _connect() {
    this.phase = LAN_PHASE.CONNECTING;
    this.joinError = '';
    this.lastEvent = `正在连接 ${this._t.url}`;
    try {
      const welcome = await this._t.connect({
        name: this.selfName,
        room: this.roomId,
        version: '1',
      });
      this.hostId = welcome.hostId;
      this.roomId = welcome.room;
      // 迟到的房主身份修正：先连上的人就是房主；若本地选了“创建房间”但没抢到
      // 房主位（例如房间已存在），如实降级为房客，避免两个权威同时广播敌人。
      if (this.role === LAN_ROLE.HOST && welcome.selfId !== welcome.hostId) {
        this.role = LAN_ROLE.GUEST;
        this.lastEvent = '房间里已有房主，已作为房客加入';
      }
      this.phase = LAN_PHASE.LOBBY;
      this._applyRoster(welcome);
      this._t.sendState({ ready: true, inGame: false });
      return true;
    } catch (err) {
      this.phase = LAN_PHASE.FAILED;
      this.joinError = (err && err.message) || '连接失败';
      this.lastEvent = this.joinError;
      return false;
    }
  }

  leave() {
    this._t.disconnect('leave');
    this._teardown();
    this.phase = LAN_PHASE.OFF;
    this.role = LAN_ROLE.OFF;
    this.lastEvent = '已退出局域网房间';
  }

  _teardown() {
    this.remotes.clear();
    this.roster = [];
    this.hostId = null;
    this._enemyTargets.clear();
    this._enemySeen.clear();
    this._sessionInfo = null;
    this._pendingStart = null;
    this._restoreEnemies();
  }

  _onStatus(status, detail) {
    if (status === NET_STATUS.RECONNECTING) {
      this.lastEvent = '与服务器断开，正在重连…';
      if (this.onNotice) this.onNotice('联机中断', detail || '正在尝试重连', 'warn');
    } else if (status === NET_STATUS.FAILED) {
      this.phase = LAN_PHASE.FAILED;
      this.joinError = detail || this._t.lastError;
      if (this.onNotice) this.onNotice('联机已断开', this.joinError, 'warn');
    } else if (status === NET_STATUS.ONLINE && this.phase === LAN_PHASE.FAILED) {
      this.phase = LAN_PHASE.LOBBY;
    }
  }

  _onRoster(msg) {
    if (msg && msg.t === SRV.WELCOME) {
      this.hostId = msg.hostId;
      this.roomId = msg.room;
    } else if (msg && msg.t === SRV.ROSTER) {
      this.hostId = msg.hostId;
    }
    this._applyRoster(msg);
    if (this.onRosterChange) this.onRosterChange();
  }

  _applyRoster(msg) {
    const peers = (msg && msg.peers) || [];
    this.roster = peers;
    const seen = new Set();
    let index = 0;
    for (const p of peers) {
      if (p.id === this._t.selfId) { index++; continue; }
      seen.add(p.id);
      let r = this.remotes.get(p.id);
      if (!r) {
        r = new RemotePlayer(p.id, p.name);
        this.remotes.set(p.id, r);
        this._wireRemoteDamage(r);
        this.lastEvent = `${p.name} 加入了房间`;
      }
      r.name = p.name;
      r.isHost = !!p.isHost;
      r.peerIndex = index;
      r.stale = false;
      index++;
    }
    for (const [id, r] of [...this.remotes]) {
      if (!seen.has(id)) {
        r.markStale();
        this.remotes.delete(id);
        this.lastEvent = `${r.name} 离开了房间`;
      }
    }
  }

  _wireRemoteDamage(remote) {
    remote.onDamage = (amount, dir) => {
      // 房主侧：敌人打中了这位房客 → 把伤害转发给本人去权威结算。
      if (!this.isHost || !this.online) return;
      this._t.sendGame({
        k: MSG.DAMAGE,
        to: remote.id,
        a: q2(amount),
        d: [q2(dir ? dir[0] : 0), q2(dir ? dir[1] : 0), q2(dir ? dir[2] : 0)],
      }, { reliable: true });
    };
  }

  // ---------------------------------------------------------------- 收消息

  _onServerMessage(msg) {
    switch (msg.t) {
      case SRV.GAME: this._onGameMessage(msg.from, msg.data); break;
      case SRV.CHAT: this._pushChat({ from: msg.from, name: msg.name, text: msg.text, time: msg.time, self: false }); break;
      case SRV.PEER_LEFT: {
        const r = this.remotes.get(msg.id);
        if (r) {
          this.lastEvent = `${r.name} 断开了连接`;
          if (this.onNotice) this.onNotice('队友离线', r.name, 'warn');
        }
        break;
      }
      case SRV.ERROR:
        this.joinError = msg.message || '服务器错误';
        if (this.onNotice) this.onNotice('联机错误', this.joinError, 'warn');
        break;
      default: break;
    }
  }

  _onGameMessage(from, data) {
    if (!data || typeof data !== 'object') return;
    const codec = this._ensureCodec();
    switch (data.k) {
      case MSG.PLAYER: {
        const r = this.remotes.get(from);
        if (!r) return;
        const decoded = codec.decodePlayer(data.s, r._decoded || null);
        r._decoded = decoded;
        r.setNetState(decoded);
        r.lastPacketAt = nowMs();
        break;
      }
      case MSG.ENEMY:
        if (!this.isHost) this._applyEnemySnapshot(data.e);
        break;
      case MSG.HIT:
        if (this.isHost) this._applyRemoteHits(from, data.h);
        break;
      case MSG.DAMAGE:
        if (data.to === this._t.selfId) this._applyIncomingDamage(data);
        break;
      case MSG.SESSION:
        if (!this.isHost) this._onRemoteSession(data);
        break;
      case MSG.RUN:
        if (!this.isHost) this._applyRunState(data);
        break;
      case MSG.WORLD_EVENT:
        if (!this.isHost) this._onWorldEvent(from, data);
        break;
      case MSG.CHAT:
        this._pushChat({ from, name: data.n || '', text: sanitizeChat(data.m), time: nowMs(), self: false });
        break;
      case MSG.BYE:
        break;
      default: break;
    }
  }

  _applyIncomingDamage(data) {
    const game = this.game;
    if (!game || !game.player || !game.player.alive) return;
    const amount = Number(data.a) || 0;
    if (amount <= 0) return;
    const d = data.d || [0, 0, 0];
    const dir = new Float32Array([d[0], d[1], d[2]]);
    // source 必须非 null：Player.applyDamage 用 `source !== null` 判定无敌帧，
    // 传 null 会绕过出生保护与作弊死亡后的无敌时间。
    game.player.applyDamage(amount, dir, 'enemy');
  }

  _applyRemoteHits(from, hits) {
    const enemies = this.game && this.game.enemies;
    if (!enemies || !Array.isArray(hits)) return;
    for (const h of hits) {
      const e = enemies.findByNetId(h[0] | 0);
      if (!e || !e.alive) continue;
      const point = [h[3], h[4], h[5]];
      const normal = [h[6], h[7], h[8]];
      enemies.damage(e, Number(h[1]) || 0, !!h[2], point, normal, { source: from, network: true });
    }
  }

  _onRemoteSession(data) {
    const info = {
      mapIndex: data.i | 0,
      seed: data.s | 0,
      tier: data.t | 0,
      mapName: data.n || '',
    };
    this._sessionInfo = info;
    this.phase = LAN_PHASE.PLAYING;
    if (this.onSessionStart) this.onSessionStart(info);
  }

  _applyRunState(data) {
    const run = this.game && this.game.run;
    if (!run) return;
    if (typeof data.p === 'string') run.phase = data.p;
    if (Array.isArray(data.o) && Array.isArray(run.objectives)) {
      for (const row of data.o) {
        const o = run.objectives[row[0] | 0];
        if (!o) continue;
        o.progress = row[1];
        o.done = !!row[2];
      }
    }
    if (Number.isFinite(data.x)) run.extractHold = data.x;
    // 2.0.7 的舍入：objective 全部完成也要等 bossPending 清零才推进阶段
    // （run.js 的 `remaining === 0 && !this.bossPending`）。房客的导演是停的，
    // 永远不会自己清掉这个标志，不同步就会卡在第 3/6/10 层永远无法撤离。
    if (typeof data.b === 'number') run.bossPending = data.b === 1;
  }

  _onWorldEvent(from, data) {
    const game = this.game;
    if (!game) return;
    switch (data.e) {
      case EV.ENEMY_DEATH: {
        // 本地已经通过快照知道敌人死了；这里只处理“击杀归谁”这一层：
        // 击杀者本机结算奖励与掉落，其他人只补一条播报。
        const e = game.enemies && game.enemies.findByNetId(data.id | 0);
        if (data.by === this._t.selfId) {
          if (typeof game.applyKillRewards === 'function') game.applyKillRewards(!!data.hs);
          // spawnEnemyDrop 的掉落表只由 enemy.id 决定，且地面高度来自同种子地图，
          // 因此各端各自生成结果一致，不需要额外的掉落同步消息。
          if (e && game.inventory && typeof game.inventory.spawnEnemyDrop === 'function') {
            game.inventory.spawnEnemyDrop(e, game.world);
          }
          if (game.hud && typeof game.hud.addKill === 'function') {
            game.hud.addKill(data.label || '击毁敌军', data.hs ? 'headshot' : 'normal');
          }
          Events.emit('fx:hitmarker', { kill: true });
        }
        break;
      }
      case EV.TOAST:
        if (game.hud) game.hud.toast(data.title || '', data.sub || '', data.kind || 'info');
        break;
      case EV.RUN_END:
        if (game.hud) game.hud.toast('远征结束', data.text || '', data.ok ? 'good' : 'warn');
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- 敌人同步

  _applyEnemySnapshot(rows) {
    const game = this.game;
    const enemies = game && game.enemies;
    if (!enemies || !Array.isArray(rows)) return;
    const codec = this._ensureCodec();
    const seen = this._enemySeen;
    seen.clear();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < ENEMY_TUPLE) continue;
      const id = row[0] | 0;
      seen.add(id);
      let e = enemies.findByNetId(id);
      if (!e) {
        const typeId = codec.enemyTypeOf(row[1] | 0);
        if (!typeId) continue;
        // scale / elite 必须一起带过来：2.0.7 的守关首领是 scale 1.6 的精英重装，
        // 漏掉就会在房客端退化成普通体型，连命中盒都是错的。
        const scale = Number.isFinite(row[11]) && row[11] > 0 ? row[11] : 1;
        const elite = (row[8] & EFLAG.ELITE) !== 0;
        e = enemies.spawn(typeId, [row[2], row[3], row[4]], { id, scale, elite });
        e.yaw = row[5] || 0;
        e.aimYaw = e.yaw;
        e._netSnap = true;
      }
      const flags = row[8] | 0;
      const alive = (flags & EFLAG.ALIVE) !== 0;
      // 位置/朝向走插值目标；血量与上限立刻生效。
      let t = this._enemyTargets.get(id);
      if (!t) { t = { x: 0, y: 0, z: 0, yaw: 0 }; this._enemyTargets.set(id, t); }
      t.x = row[2]; t.y = row[3]; t.z = row[4]; t.yaw = row[5];
      if (e._netSnap) {
        e.pos[0] = t.x; e.pos[1] = t.y; e.pos[2] = t.z;
        e._netSnap = false;
      }
      // 先写上限再写当前值：HUD 血条读的是 hp/maxHp，顺序反了会闪一帧 600%。
      if (Number.isFinite(row[9]) && row[9] > 0) e.maxHp = row[9];
      if (Number.isFinite(row[10]) && row[10] >= 0) e.maxShield = row[10];
      enemies.applyNetState(e, row[6], row[7], alive, undefined);
    }
    // 快照里已经不存在的敌人：直接退役，避免客户端留下“幽灵敌人”。
    for (const id of [...this._enemyTargets.keys()]) {
      if (seen.has(id)) continue;
      this._enemyTargets.delete(id);
      enemies.removeByNetId(id);
    }
  }

  _interpolateEnemies(dt) {
    const enemies = this.game && this.game.enemies;
    if (!enemies || this._enemyTargets.size === 0) return;
    const k = 1 - Math.exp(-22 * dt);
    for (const [id, t] of this._enemyTargets) {
      const e = enemies.findByNetId(id);
      if (!e || !e.alive) continue;
      e.pos[0] += (t.x - e.pos[0]) * k;
      e.pos[1] += (t.y - e.pos[1]) * k;
      e.pos[2] += (t.z - e.pos[2]) * k;
      e.yaw += M.wrapAngle(t.yaw - e.yaw) * k;
      e.aimYaw = e.yaw;
    }
  }

  _broadcastEnemySnapshot() {
    const game = this.game;
    const enemies = game && game.enemies;
    if (!enemies) return;
    const codec = this._ensureCodec();
    const rows = [];
    for (const e of enemies.all) {
      const slot = codec.enemyTypeSlot(e.typeId);
      if (slot < 0) continue;
      let flags = 0;
      if (e.alive) flags |= EFLAG.ALIVE;
      if (e.elite) flags |= EFLAG.ELITE;
      rows.push([
        e.id, slot, q2(e.pos[0]), q2(e.pos[1]), q2(e.pos[2]), q4(e.yaw),
        q1(e.hp), q1(e.shield), flags,
        q1(e.maxHp), q1(e.maxShield), q2(e.scale || 1),
      ]);
    }
    this._t.sendGame({ k: MSG.ENEMY, e: rows });
  }

  // ---------------------------------------------------------------- 会话开始

  /** 房主：广播本局配置（地图种子等），房客据此生成完全一致的世界 */
  announceSession(info) {
    this._sessionInfo = info;
    this.phase = LAN_PHASE.PLAYING;
    this._t.sendGame({
      k: MSG.SESSION,
      i: info.mapIndex | 0,
      s: info.seed | 0,
      t: info.tier | 0,
      n: info.mapName || '',
    }, { reliable: true });
    this._t.sendState({ ready: true, inGame: true });
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * 每帧调用（在主循环的物理步之后、渲染之前）。
   * @param {number} dt 渲染帧的秒数
   */
  update(dt) {
    if (this.phase === LAN_PHASE.OFF) return;
    const game = this.game;
    const step = Math.max(0, Math.min(0.25, dt || 0));

    for (const r of this.remotes.values()) {
      r.interpolate(step);
      if (nowMs() - r.lastPacketAt > 3000 && r.lastPacketAt > 0 && !r.stale) r.markStale();
      r.latency = this.latency;
    }

    if (!this.online) return;

    // 自己：30 Hz 上报
    this._sendAcc += step;
    if (this._sendAcc >= 1 / 30) {
      this._sendAcc = 0;
      this._sendSelfState();
    }

    if (this.phase !== LAN_PHASE.PLAYING) return;

    if (this.isHost) {
      // 房主：20 Hz 敌人快照 + 2 Hz 单局状态
      this._enemyAcc += step;
      if (this._enemyAcc >= 1 / 20) {
        this._enemyAcc = 0;
        this._broadcastEnemySnapshot();
      }
      this._runAcc += step;
      if (this._runAcc >= 0.5) {
        this._runAcc = 0;
        this._broadcastRunState();
      }
      this._syncEnemyTargets();
    } else {
      this._interpolateEnemies(step);
      // 房客：把本机判定命中的敌人上报给房主做权威结算
      const reports = game.enemies ? game.enemies.takeHitReports(this._hitQueue) : null;
      if (reports && reports.length) {
        this._t.sendGame({ k: MSG.HIT, h: reports }, { reliable: true });
        this._hitQueue.length = 0;
      }
    }
  }

  _sendSelfState() {
    const game = this.game;
    if (!game || !game.player) return;
    const codec = this._ensureCodec();
    const tuple = codec.encodePlayer(game.player, game.weapons, this._selfTuple);
    this._t.sendGame({ k: MSG.PLAYER, s: Array.from(tuple) });
  }

  _broadcastRunState() {
    const run = this.game && this.game.run;
    if (!run) return;
    const obj = [];
    if (Array.isArray(run.objectives)) {
      for (let i = 0; i < run.objectives.length; i++) {
        const o = run.objectives[i];
        obj.push([i, q2(o.progress || 0), o.done ? 1 : 0]);
      }
    }
    this._t.sendGame({
      k: MSG.RUN,
      p: run.phase,
      o: obj,
      x: q2(run.extractHold || 0),
      b: run.bossPending ? 1 : 0,
    });
  }

  /** 房主：把“本地玩家 + 所有远程玩家代理”交给敌人 AI 做目标选择 */
  _syncEnemyTargets() {
    const game = this.game;
    const enemies = game && game.enemies;
    if (!enemies) return;
    const list = [];
    if (game.player && game.player.alive) list.push(game.player);
    for (const r of this.remotes.values()) {
      if (!r.alive || r.stale) continue;
      list.push(r);
    }
    enemies.setPlayers(list.length ? list : [game.player]);
  }

  /** 敌人死亡时由房主广播（击杀播报用） */
  broadcastEnemyDeath(enemy, byPeerId, headshot) {
    if (!this.isHost || !this.online) return;
    this._t.sendGame({
      k: MSG.WORLD_EVENT,
      e: EV.ENEMY_DEATH,
      id: enemy.id,
      by: byPeerId || this._t.selfId,
      hs: headshot ? 1 : 0,
    });
  }

  broadcastToast(title, sub, kind) {
    if (!this.isHost || !this.online) return;
    this._t.sendGame({ k: MSG.WORLD_EVENT, e: EV.TOAST, title, sub, kind });
  }

  // ---------------------------------------------------------------- 渲染 / 聊天

  /** 在主相机设置好之后调用，绘制所有队友的第三人称模型 */
  renderAvatars(engine, dt) {
    if (!this.inSession) return 0;
    if (!this.avatar) this.avatar = new AvatarRenderer(engine);
    const list = [...this.remotes.values()];
    return this.avatar.render(engine, list, dt);
  }

  sendChat(text) {
    const clean = sanitizeChat(text, 140);
    if (!clean || !this.online) return false;
    const ok = this._t.sendGame({ k: MSG.CHAT, n: this.selfName, m: clean }, { reliable: true });
    if (ok) this._pushChat({ from: this._t.selfId, name: this.selfName, text: clean, time: nowMs(), self: true });
    return ok;
  }

  _pushChat(entry) {
    this.chat.push(entry);
    while (this.chat.length > this.maxChat) this.chat.shift();
    if (this.onChat) this.onChat(entry);
  }

  _restoreEnemies() {
    const enemies = this.game && this.game.enemies;
    if (!enemies) return;
    enemies.setPlayers([this.game.player]);
    enemies.setReplicated(false);
  }

  /**
   * 由 Game 在开局后调用：房客进入复制模式，房主进入权威模式。
   *
   * 关键：**不在房间里时必须是显式的“权威模式”空操作**。早期版本在这里只判断
   * `isHost`，于是单机（role='off'）会掉进 else 分支，把单机敌人也切成复制模式，
   * 表现为“敌人一动不动、也不攻击”。tools/headless-check.mjs 的敌人 AI 用例
   * 正是这样抓到它的。
   */
  applyRoleToWorld() {
    const enemies = this.game && this.game.enemies;
    if (!enemies) return;
    if (this.role === LAN_ROLE.OFF || !this.inSession || !this.online) {
      enemies.setReplicated(false);
      enemies.setPlayers([this.game.player]);
      return;
    }
    if (this.isHost) {
      enemies.setReplicated(false);
      this._syncEnemyTargets();
    } else {
      enemies.setReplicated(true);
      enemies.setPlayers([this.game.player]);
      this._enemyTargets.clear();
      this._enemySeen.clear();
    }
  }

  debugState() {
    return {
      role: this.role,
      phase: this.phase,
      selfId: this._t.selfId,
      room: this.roomId,
      hostId: this.hostId,
      peers: this.peerCount,
      remotes: [...this.remotes.values()].map((r) => ({
        id: r.id, name: r.name, alive: r.alive, hp: Math.round(r.health),
        stale: !!r.stale, x: q2(r.pos[0]), y: q2(r.pos[1]), z: q2(r.pos[2]),
      })),
      latency: this.latency,
      transport: this._t.debugState(),
      enemyTargets: this._enemyTargets.size,
      session: this._sessionInfo,
      lastEvent: this.lastEvent,
    };
  }
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function sanitizeNameForUI(raw) {
  const name = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  return name.slice(0, 12);
}

export default LanSession;
