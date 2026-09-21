import assert from 'node:assert/strict';
import { captureRuntime, installDiagnostics } from '../src/core/diagnostics.js';

const handlers = {}, canvasHandlers = {}, stored = new Map(), downloads = [];
let sample, banner;
const element = () => ({ style: {}, addEventListener() {}, click() {} });
const win = {
  localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) },
  URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
  document: { createElement: element, body: { appendChild: el => { banner = el; } } },
  setTimeout: fn => fn(), setInterval: fn => { sample = fn; return 1; }, clearInterval() {},
  addEventListener: (name, fn) => { handlers[name] = fn; },
};
const game = {
  frameCount: 12, running: true, paused: false, _playing: true,
  canvas: { addEventListener: (name, fn) => { canvasHandlers[name] = fn; } },
  player: { pos: [1, 2, 3], eyePos: [1, 3, 3], vel: [0, 0, 0],
    yaw: 0, pitch: 0, roll: 0, getFov: () => 100, alive: true },
  engine: { gl: { isContextLost: () => false }, stats: {}, viewProj: [1, 0, 0, 1] },
};
assert.equal(captureRuntime(game).frame, 12);
const diag = installDiagnostics(game, win);
sample();
handlers.error({ error: new Error('physics failure') });
assert.match(banner.textContent, /F8/);
assert.match([...stored.values()][0], /physics failure/);
diag.record('渲染异常', new Error('render failure'));
assert.match([...stored.values()][0], /render failure/);
game.player.pitch = NaN;
sample();
assert.match([...stored.values()][0], /NaN/);
let prevented = false;
handlers.keydown({ code: 'F8', preventDefault: () => { prevented = true; } });
assert.ok(prevented);
const report = JSON.parse(await downloads[0].text());
assert.equal(report.current.player.pitch, 'NaN');
assert.equal(report.errors.length, 3);
assert.equal(report.recent.length, 2);
canvasHandlers.webglcontextlost();
assert.match([...stored.values()][0], /GPU context lost/);
console.log('PASS: physics/render errors, NaN, GPU context loss, F8 export and recent state');
