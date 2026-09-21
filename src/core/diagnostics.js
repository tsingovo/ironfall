// Local-only freeze diagnostics. No network upload or save-game modification.
import { Input } from './input.js';

const KEY = 'ironfall.diagnostics.last.v1';
const vector = (v) => v ? Array.from(v) : null;
const json = (v) => JSON.stringify(v, (_k, x) =>
  typeof x === 'number' && !Number.isFinite(x) ? String(x) : x, 2);

export function captureRuntime(game) {
  const p = game.player, e = game.engine;
  return {
    time: new Date().toISOString(), frame: game.frameCount,
    running: game.running, paused: game.paused, playing: game._playing,
    menu: game.menuKind, hudMenu: game.hud?._menu, tier: game.tier,
    accumulator: game.accumulator, elapsed: game.elapsed,
    settings: { fov: game.settings?.fov, fpsCap: game.settings?.fpsCap, quality: game.settings?.quality },
    input: { locked: Input.pointerLocked, blocked: Input.menuBlocking,
      fallback: Input.fallbackLook, lockError: Input.lastLockError },
    player: p ? { pos: vector(p.pos), eye: vector(p.eyePos), velocity: vector(p.vel),
      yaw: p.yaw, pitch: p.pitch, roll: p.roll, fov: p.getFov(), alive: p.alive } : null,
    render: e ? { gpu: e.gpuInfo, contextLost: e.gl.isContextLost(),
      size: [e.width, e.height], viewProj: vector(e.viewProj),
      drawCalls: e.stats.drawCalls, cpuMs: e.stats.cpuMs,
      lastError: game._lastRenderError?.stack || null } : null,
  };
}

export function installDiagnostics(game, win = window) {
  let history = [], previous = null, lastSignature = '', lastRecordAt = 0;
  let banner = null;
  try { previous = JSON.parse(win.localStorage.getItem(KEY) || 'null'); } catch {}
  const snapshot = () => {
    try { return captureRuntime(game); }
    catch (err) { return { snapshotError: String(err), frame: game.frameCount }; }
  };
  const records = [];
  const download = () => {
    const data = { schema: 1, current: snapshot(), recent: history, errors: records, previous };
    const url = win.URL.createObjectURL(new Blob([json(data)], { type: 'application/json' }));
    const link = win.document.createElement('a');
    link.href = url;
    link.download = `IRONFALL-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  };
  const record = (kind, err) => {
    const signature = kind + ':' + String(err?.message || err);
    const now = Date.now();
    if (signature === lastSignature && now - lastRecordAt < 3000) return;
    lastSignature = signature; lastRecordAt = now;
    const item = { kind, message: String(err?.message || err), stack: err?.stack,
      state: snapshot(), recent: history.slice() };
    records.push(item);
    if (records.length > 8) records.shift();
    try { win.localStorage.setItem(KEY, json(item)); } catch {}
    // Independent of WebGL/HUD rendering: remains usable after a frame exception.
    if (!banner) {
      banner = win.document.createElement('button');
      banner.style.cssText = 'position:fixed;top:80px;left:20px;z-index:2147483647;padding:12px;background:#401b20;color:white;border:1px solid #ff6970;cursor:pointer;pointer-events:auto';
      banner.addEventListener('click', download);
      win.document.body.appendChild(banner);
    }
    banner.textContent = `游戏异常已记录：${kind}。按 F8 或点击此处导出诊断`;
  };
  // Do not route F8 through frame(): physics exceptions can skip the input cleanup.
  win.addEventListener('keydown', (event) => {
    if (event.code !== 'F8' || event.repeat) return;
    event.preventDefault(); download();
  });
  win.addEventListener('error', event => record('JavaScript', event.error || event.message));
  win.addEventListener('unhandledrejection', event => record('Promise', event.reason));
  game.canvas.addEventListener('webglcontextlost', () => record('WebGL 上下文丢失', 'GPU context lost'));
  const timer = win.setInterval(() => {
    const state = snapshot();
    history.push(state);
    if (history.length > 6) history.shift();
    const p = state.player;
    if (p && [...p.pos, ...p.eye, p.yaw, p.pitch, p.roll, p.fov,
      ...(state.render?.viewProj || [])].some(x => !Number.isFinite(x))) {
      record('相机数值无效', 'Non-finite player/camera state');
    }
  }, 1000);
  win.addEventListener('pagehide', () => win.clearInterval(timer), { once: true });
  return { record, download };
}
