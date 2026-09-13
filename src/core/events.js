// ==== core/events.js — 极简同步事件总线（零分配优先） ====

/** @type {Map<string, Array<function>>} */
const listeners = new Map();
const onceWrappers = new WeakMap();

/** 订阅；返回取消订阅函数 */
export function on(type, fn) {
  let arr = listeners.get(type);
  if (!arr) { arr = []; listeners.set(type, arr); }
  arr.push(fn);
  return function off_() { off(type, fn); };
}

/** 订阅一次 */
export function once(type, fn) {
  const wrapper = function (payload) {
    off(type, wrapper);
    onceWrappers.delete(wrapper);
    fn(payload);
  };
  onceWrappers.set(wrapper, fn);
  return on(type, wrapper);
}

export function off(type, fn) {
  const arr = listeners.get(type);
  if (!arr) return;
  const i = arr.indexOf(fn);
  if (i >= 0) {
    // 交换删除：不保持顺序但避免 O(n) 移动；监听器顺序无关紧要
    const last = arr.length - 1;
    if (i !== last) arr[i] = arr[last];
    arr.pop();
  }
  if (arr.length === 0) listeners.delete(type);
}

/**
 * 派发事件。payload 直接透传，不做拷贝。
 * 遍历时复制数组只在监听器数量 >1 且可能被修改时发生 —— 这里用索引倒序保护常见情形。
 */
export function emit(type, payload) {
  const arr = listeners.get(type);
  if (!arr) return;
  // 正序遍历 + 长度快照：允许监听器内部 off 自己
  const n = arr.length;
  for (let i = 0; i < n && i < arr.length; i++) {
    const fn = arr[i];
    if (fn) fn(payload);
  }
}

export function clear(type) {
  if (type === undefined) listeners.clear();
  else listeners.delete(type);
}

/** 调试用：当前监听器统计 */
export function listenerStats() {
  const out = {};
  for (const [k, v] of listeners) out[k] = v.length;
  return out;
}

export default { on, once, off, emit, clear, listenerStats };
