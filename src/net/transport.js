// ==== net/transport.js — WebSocket 传输层（连接、心跳、延迟测量、自动重连）====
//
// 只依赖浏览器原生 WebSocket（零第三方依赖）；模块顶层不访问任何 DOM/网络 API，
// 因此可以在 Node 里被静态导入做契约检查。

/** 连接状态机 */
export const NET_STATUS = Object.freeze({
  IDLE: 'idle',                 // 未连接
  CONNECTING: 'connecting',     // 正在建立连接
  HANDSHAKING: 'handshaking',   // TCP/WS 已通，等待服务器 welcome
  ONLINE: 'online',             // 已入房
  RECONNECTING: 'reconnecting', // 掉线后自动重试中
  CLOSED: 'closed',             // 主动关闭
  FAILED: 'failed',             // 重试次数耗尽
});

const DEFAULT_PING_MS = 1500;
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_BACKOFF_MS = 6000;
const MAX_SEND_BUFFER = 512 * 1024;

/**
 * 把 location 推导成默认的 WebSocket 端点。
 * 页面本身就由局域网服务器提供时，房客不需要输入任何 IP。
 */
export function defaultWsUrl(loc) {
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (!l || !l.host) return '';
  const proto = l.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${l.host}/ws`;
}

export class NetTransport {
  constructor(opts = {}) {
    this.url = opts.url || defaultWsUrl();
    this.status = NET_STATUS.IDLE;
    this.selfId = null;
    this.room = '';
    this.lastError = '';
    this.latency = 0;            // 最近一次 RTT（毫秒）
    this.latencyAvg = 0;
    this.pingIntervalMs = opts.pingIntervalMs || DEFAULT_PING_MS;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.autoReconnect = opts.autoReconnect !== false;
    this.maxReconnects = Number.isFinite(opts.maxReconnects) ? opts.maxReconnects : 6;

    /** 服务器原始消息回调（已解析为对象） */
    this.onMessage = null;
    /** 状态变化回调 (status, detail) */
    this.onStatus = null;
    /** 房间名册变化回调 (roster) */
    this.onRoster = null;

    this._ws = null;
    this._pingTimer = 0;
    this._pingSeq = 0;
    this._pendingPings = new Map();
    this._reconnects = 0;
    this._closedByUser = false;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimer = 0;
    this._reconnectTimer = 0;
    this._joinPayload = null;
    this.stats = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, dropped: 0, reconnects: 0 };
  }

  get online() { return this.status === NET_STATUS.ONLINE; }
  get supported() { return typeof WebSocket === 'function'; }
  get bufferedAmount() {
    try { return this._ws ? (this._ws.bufferedAmount || 0) : 0; } catch (_e) { return 0; }
  }

  /**
   * 把连接目标换成页面之外的服务器（公网直连）。
   *
   * 这是“直连 IP”能成立的关键：WebSocket 不受同源策略限制（浏览器不会拦截
   * 跨源 ws 连接，服务端也不校验 Origin），所以“页面从哪儿加载”和“连哪台
   * 服务器”可以完全解耦。已在线时拒绝改地址，避免把正在用的连接指向别处。
   */
  setEndpoint(url) {
    if (this.online || this.status === NET_STATUS.HANDSHAKING) {
      this.lastError = '已连接状态下不能切换服务器';
      return false;
    }
    const next = String(url || '').trim();
    if (!next) { this.lastError = '服务器地址为空'; return false; }
    this.url = next;
    return true;
  }

  _setStatus(status, detail) {
    if (this.status === status) return;
    this.status = status;
    if (this.onStatus) this.onStatus(status, detail || '');
  }

  /**
   * 连接并加入房间。
   * @param {{name:string, room?:string, version?:string}} join
   */
  connect(join = {}) {
    if (!this.supported) {
      this.lastError = '当前环境不支持 WebSocket';
      this._setStatus(NET_STATUS.FAILED, this.lastError);
      return Promise.reject(new Error(this.lastError));
    }
    if (!this.url) {
      this.lastError = '无法推导 WebSocket 地址';
      this._setStatus(NET_STATUS.FAILED, this.lastError);
      return Promise.reject(new Error(this.lastError));
    }
    this.disconnect('重新连接');
    this._closedByUser = false;
    this._reconnects = 0;
    this.lastError = '';
    this._joinPayload = {
      name: String(join.name || '玩家').slice(0, 16),
      room: String(join.room || 'default').slice(0, 32),
      version: String(join.version || ''),
    };
    this._setStatus(NET_STATUS.CONNECTING);
    return new Promise((resolvePromise, reject) => {
      this._connectResolve = resolvePromise;
      this._connectReject = reject;
      this._openSocket();
    });
  }

  _openSocket() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._failConnect(err);
      return;
    }
    this._ws = ws;
    this._connectTimer = setTimeout(() => {
      if (this._ws === ws) this._failConnect(new Error('连接或入房握手超时'));
    }, this.timeoutMs);
    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._setStatus(NET_STATUS.HANDSHAKING);
      this._sendRaw({ t: 'hello', ...this._joinPayload });
    };
    ws.onmessage = (ev) => { if (this._ws === ws) this._onMessage(ev && ev.data); };
    ws.onerror = () => {
      if (this._ws !== ws) return;
      this.lastError = this.lastError || '连接出错';
    };
    ws.onclose = (ev) => { if (this._ws === ws) this._onClose(ev); };
  }

  _failConnect(err) {
    const stale = this._ws;
    this._ws = null;
    if (stale) { try { stale.close(); } catch (_) {} }
    this.lastError = err && err.message ? err.message : String(err);
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = 0; }
    const reject = this._connectReject;
    this._connectReject = null;
    this._connectResolve = null;
    this._setStatus(NET_STATUS.FAILED, this.lastError);
    this._scheduleReconnect();
    if (reject) reject(new Error(this.lastError));
  }

  _onMessage(raw) {
    if (typeof raw !== 'string') return;
    this.stats.received++;
    this.stats.receivedBytes += raw.length;
    let msg;
    try { msg = JSON.parse(raw); } catch (_e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'welcome') {
      this.selfId = msg.selfId;
      this.room = msg.room;
      this._reconnects = 0;
      if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = 0; }
      this._setStatus(NET_STATUS.ONLINE);
      this._startPing();
      const resolve = this._connectResolve;
      this._connectResolve = null;
      this._connectReject = null;
      if (this.onRoster) this.onRoster(msg);
      if (resolve) resolve(msg);
    } else if (msg.t === 'roster') {
      if (this.onRoster) this.onRoster(msg);
    } else if (msg.t === 'pong') {
      const sentAt = this._pendingPings.get(msg.id);
      if (sentAt != null) {
        this._pendingPings.delete(msg.id);
        const rtt = Math.max(0, Date.now() - sentAt);
        this.latency = rtt;
        this.latencyAvg = this.latencyAvg ? this.latencyAvg * 0.7 + rtt * 0.3 : rtt;
      }
    } else if (msg.t === 'error') {
      this.lastError = msg.message || msg.code || '服务器拒绝';
    }
    if (this.onMessage) this.onMessage(msg);
  }

  _onClose(ev) {
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = 0; }
    this._stopPing();
    const code = ev && ev.code ? ev.code : 0;
    const reason = (ev && ev.reason) || '';
    this._ws = null;
    if (this._closedByUser) {
      this._setStatus(NET_STATUS.CLOSED, reason);
      return;
    }
    // 服务器主动拒绝（房间满、协议版本不符）不重连：重试多少次结果都一样，
    // 只会变成重试风暴。心跳超时（4001）恰恰相反——那是网络抖了一下，
    // 公网直连时很常见，必须重连。
    const fatal = code === 4000 || code === 4002;
    this.fatalCode = fatal ? code : 0;
    const prior = this.lastError;
    this.lastError = `${reason || (fatal ? prior || '被服务器拒绝' : '与服务器断开连接')}（关闭码 ${code}，${this.url}）`;
    this._setStatus(NET_STATUS.RECONNECTING, this.lastError);
    // 首次连接还没成功就断开：让 connect() 的 Promise 以失败结束
    if (this._connectReject) {
      const reject = this._connectReject;
      this._connectResolve = null;
      this._connectReject = null;
      if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = 0; }
      reject(new Error(this.lastError));
    }
    if (!fatal) this._scheduleReconnect();
    else this._setStatus(NET_STATUS.FAILED, this.lastError);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (!this.autoReconnect || this._closedByUser) return;
    if (this._reconnects >= this.maxReconnects) {
      this.lastError = this.lastError || '重连次数已用尽';
      this._setStatus(NET_STATUS.FAILED, this.lastError);
      return;
    }
    this._reconnects++;
    this.stats.reconnects++;
    const delay = Math.min(MAX_BACKOFF_MS, 400 * Math.pow(1.6, this._reconnects - 1));
    this._setStatus(NET_STATUS.RECONNECTING, `第 ${this._reconnects} 次重连`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = 0;
      if (this._closedByUser || this.online) return;
      this._openSocket();
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (!this.online) return;
      const oldest = this._pendingPings.values().next().value;
      if (oldest != null && Date.now() - oldest > this.timeoutMs) {
        this._stopPing();
        this._failConnect(new Error('心跳超时，正在重连'));
        return;
      }
      const id = ++this._pingSeq;
      this._pendingPings.set(id, Date.now());
      if (this._pendingPings.size > 16) {
        // 丢掉过期的探测，避免 Map 无限增长
        const oldest = this._pendingPings.keys().next().value;
        this._pendingPings.delete(oldest);
      }
      this._sendRaw({ t: 'ping', id });
    }, this.pingIntervalMs);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = 0; }
    this._pendingPings.clear();
  }

  _sendRaw(obj, opts) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    const droppable = !!(opts && opts.droppable);
    if (droppable && this.bufferedAmount > MAX_SEND_BUFFER) {
      this.stats.dropped++;
      return false;
    }
    let text;
    try { text = JSON.stringify(obj); } catch (_e) { return false; }
    try {
      this._ws.send(text);
    } catch (_e) {
      return false;
    }
    this.stats.sent++;
    this.stats.sentBytes += text.length;
    return true;
  }

  /** 发送游戏消息（服务器原样转发给房间其他人） */
  sendGame(data, opts) {
    return this._sendRaw({ t: 'game', data, droppable: !(opts && opts.reliable) }, opts);
  }

  sendChat(text) {
    return this._sendRaw({ t: 'chat', text: String(text == null ? '' : text).slice(0, 200) });
  }

  /** 上报自身准备/在局状态，服务器会刷新房间名册 */
  sendState(patch) {
    return this._sendRaw({ t: 'state', ...patch });
  }

  claimHost() {
    return this._sendRaw({ t: 'claim_host' });
  }

  /** 主动断开；不再自动重连 */
  disconnect(reason) {
    this._closedByUser = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = 0; }
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = 0; }
    const reject = this._connectReject;
    this._connectResolve = this._connectReject = null;
    if (reject) reject(new Error(reason || '连接已取消'));
    this._stopPing();
    if (this._ws && this._ws.readyState === 1) {
      this._sendRaw({ t: 'bye' });
      try { this._ws.close(1000, reason || 'client bye'); } catch (_e) { /* 忽略 */ }
    } else if (this._ws) {
      try { this._ws.close(); } catch (_e) { /* 忽略 */ }
    }
    this._ws = null;
    this._setStatus(NET_STATUS.CLOSED, reason || '');
  }

  debugState() {
    return {
      status: this.status,
      url: this.url,
      selfId: this.selfId,
      room: this.room,
      latency: Math.round(this.latency),
      latencyAvg: Math.round(this.latencyAvg),
      error: this.lastError,
      buffered: this.bufferedAmount,
      stats: { ...this.stats },
    };
  }
}

export default NetTransport;
