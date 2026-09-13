// ==== tools/build-standalone.mjs — 打成单文件离线版 ====
//
// 目标：产出一个**双击即玩**的 HTML —— 不需要 Node、不需要服务器、不需要联网。
//
// 为什么需要打包而不是直接发源码：
//   本作是 ES Modules，浏览器对 `file://` 下的模块导入有 CORS 限制，双击 index.html
//   会直接报错。把所有模块内联进单个 <script type="module"> 就绕开了这条限制
//   （内联模块脚本不受 file:// 的模块 CORS 约束）。
//
// 做法（零依赖，纯文本变换）：
//   1. 从 src/main.js 出发做 DFS，按依赖顺序拓扑排序（被依赖者在前）
//   2. 把每个模块包成 `const __M_<name> = (() => { … return { 导出名 }; })();`
//      · `import { a, b } from './x.js'` → `const { a, b } = __M_x;`
//      · `import * as X from './x.js'`   → `const X = __M_x;`
//      · `export const/function/class …` → 去掉 `export`，再在结尾统一 return
//   3. CSS 全部内联成 <style>
//   4. public/ 下的资产（模型清单 + .glb）转成 data: URI，
//      并把 `fetch('public/...')` 重写成读内联表 —— 保证离线也能加载模型
//
// 用法: node tools/build-standalone.mjs
// 产物: dist/IRONFALL.html

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'IRONFALL.html');
const ENTRY = 'src/main.js';

// ---------------------------------------------------------------- 模块图

/** 正则同时吃下三种 import 形态（本仓库没有 default import） */
const IMPORT_RE = /^[ \t]*import\s+(?:(\*\s+as\s+[\w$]+)|(\{[\s\S]*?\}))\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;

function parseImports(code) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(code)) !== null) {
    const nsName = m[1] ? m[1].replace(/^\*\s+as\s+/, '').trim() : null;
    const namedRaw = m[2] || null;
    const spec = m[3];
    const named = namedRaw
      ? namedRaw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => {
          const parts = s.split(/\s+as\s+/);
          return { imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() };
        })
      : [];
    out.push({ full: m[0], nsName, named, spec });
  }
  return out;
}

/** 收集模块的导出名 */
function parseExports(code) {
  const names = new Set();
  // export const/let/var a = …, b = …
  for (const m of code.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([\w$]+)/gm)) names.add(m[1]);
  // export function/class/async function
  for (const m of code.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/gm)) names.add(m[1]);
  // export { a, b as c }
  for (const m of code.matchAll(/^[ \t]*export\s*\{([\s\S]*?)\};?[ \t]*$/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return [...names];
}

/** 去掉模块里的 import / export 关键字（导出名已单独收集） */
function stripModuleSyntax(code, imports) {
  let out = code;
  for (const imp of imports) out = out.replace(imp.full, '');

  // `export default <对象字面量>;` —— 对象字面量必须保留：它可能是其它模块依赖的值，
  // 且构造过程可能有副作用。改写成局部常量即可（导出表里已登记 __default）。
  out = out.replace(/^([ \t]*)export\s+default\s+(?=\{)/gm, '$1const __default = ');
  // `export default Foo;` —— 改写成 `const __default = Foo;`。
  // 不能直接删掉：导出表里登记了 __default，删掉会导致 ReferenceError。
  out = out.replace(/^[ \t]*export\s+default\s+([\w$.]+)\s*;?[ \t]*$/gm, 'const __default = $1;');

  out = out.replace(/^[ \t]*export\s*\{[\s\S]*?\};?[ \t]*$/gm, '');
  out = out.replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '$1');
  return out;
}

/** 解析相对导入为仓库内 posix 路径 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;              // 本仓库没有裸导入
  const dir = posix.dirname(fromFile);
  return posix.normalize(posix.join(dir, spec));
}

/** DFS 拓扑排序：被依赖的模块排在前面 */
function collect(entry) {
  const order = [];
  const state = new Map();      // path -> 'visiting' | 'done'
  const graph = new Map();      // path -> { code, imports, exports, deps }

  const visit = (file) => {
    const st = state.get(file);
    if (st === 'done' || st === 'visiting') return;     // visiting = 环，跳过（ES 本身允许）
    state.set(file, 'visiting');
    const abs = join(ROOT, file);
    if (!existsSync(abs)) throw new Error(`缺少模块: ${file}`);
    const code = readFileSyncUtf8(abs);
    const imports = parseImports(code);
    const exports = parseExports(code);
    const deps = [];
    for (const imp of imports) {
      const dep = resolveSpec(file, imp.spec);
      if (dep) { deps.push(dep); visit(dep); }
    }
    graph.set(file, { code, imports, exports, deps });
    state.set(file, 'done');
    order.push(file);
  };
  visit(entry);
  return { order, graph };
}

/** 同步读文件（打包脚本，简单起见） */
function readFileSyncUtf8(p) { return readFileSync(p, 'utf8'); }
const fsShim = { readFileSync };

// ---------------------------------------------------------------- 生成

function moduleVar(file) {
  return '__M_' + file.replace(/^src\//, '').replace(/[^\w$]/g, '_');
}

function bundleJs(entry) {
  const { order, graph } = collect(entry);
  const chunks = [];
  const missing = [];

  for (const file of order) {
    const info = graph.get(file);
    const v = moduleVar(file);
    const header = [];
    const body = [];

    for (const imp of info.imports) {
      const dep = resolveSpec(file, imp.spec);
      if (!dep) continue;
      const dv = moduleVar(dep);
      const depExports = graph.get(dep) ? graph.get(dep).exports : [];
      if (imp.nsName) {
        header.push(`    const ${imp.nsName} = ${dv};`);
      } else if (imp.named.length) {
        const pairs = imp.named.map((n) => {
          if (!depExports.includes(n.imported)) missing.push(`${file} 引用了 ${dep} 的 ${n.imported}`);
          return n.imported === n.local ? n.imported : `${n.imported}: ${n.local}`;
        });
        header.push(`    const { ${pairs.join(', ')} } = ${dv};`);
      }
    }

    body.push(stripModuleSyntax(info.code, info.imports));
    const exportNames = info.exports.slice();
    if (/export\s+default/.test(info.code)) exportNames.push('__default');
    const ret = exportNames.length ? `    return { ${exportNames.join(', ')} };` : '    return {};';
    chunks.push(`// ─── ${file} ───\nconst ${v} = (() => {\n${header.join('\n')}\n${body.join('\n')}\n${ret}\n})();`);
  }
  return { code: chunks.join('\n\n'), modules: order.length, missing };
}

function inlineCss(html) {
  return html.replace(/[ \t]*<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>\s*/g, (m, href) => {
    const p = join(ROOT, href);
    if (!existsSync(p)) { console.warn(`  ! 找不到样式表 ${href}`); return m; }
    const css = fsShim.readFileSync(p, 'utf8');
    return `<style>\n/* ${href} */\n${css}\n</style>\n`;
  });
}

/** 把 public/ 资产内联，并重写 fetch('public/...') */
async function inlineAssets(js) {
  const manifestPath = join(ROOT, 'public/models/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  // 每个条目里的 .glb 路径换成 data: URI
  const encode = async (relPath) => {
    // manifest 里的 file 字段是**相对于 manifest 所在目录**的
    const abs = join(ROOT, 'public/models', relPath);
    if (!existsSync(abs)) return null;
    const buf = await readFile(abs);
    return 'data:model/gltf-binary;base64,' + buf.toString('base64');
  };
  const walk = async (obj) => {
    if (Array.isArray(obj)) return Promise.all(obj.map(walk));
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.endsWith('.glb')) {
          const data = await encode(v);
          out[k] = data || v;
          if (!data) console.warn(`  ! 模型缺失: ${v}`);
        } else out[k] = await walk(v);
      }
      return out;
    }
    return obj;
  };
  const inlined = await walk(manifest);
  const json = JSON.stringify(inlined);

  // 重写应用层的 manifest 请求：指向内联的 data: URI
  if (!js.includes("public/models/manifest.json")) {
    console.warn('  ! 未找到 manifest 请求，模型可能无法离线加载');
  }
  const patched = js.replace(
    /fetch\(\s*['"]public\/models\/manifest\.json['"]/g,
    `fetch(IRONFALL_ASSET_MANIFEST_URL`,
  );

  return { js: patched, manifestJson: json };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('IRONFALL 单文件离线版打包');
  const t0 = Date.now();

  const { code, modules, missing } = bundleJs(ENTRY);
  console.log(`  模块: ${modules} 个`);
  if (missing.length) {
    console.warn('  ! 有导入未能解析到导出（可能是环依赖）:');
    for (const m of missing.slice(0, 10)) console.warn('    - ' + m);
  }

  const { js, manifestJson } = await inlineAssets(code);

  let html = fsShim.readFileSync(join(ROOT, 'index.html'), 'utf8');
  html = inlineCss(html);

  // 替换入口脚本为内联模块
  const assetPrelude = `
// ─── 内联资产（离线可用）───
// 模型清单以 data: URI 形式内联，避免 file:// 下的 fetch 失败
const IRONFALL_ASSET_MANIFEST = ${manifestJson};
const IRONFALL_ASSET_MANIFEST_URL = 'data:application/json;base64,' +
  btoa(unescape(encodeURIComponent(JSON.stringify(IRONFALL_ASSET_MANIFEST))));
`;

  const bundle = `<script type="module">\n${assetPrelude}\n${js}\n</script>`;
  if (!/<script\s+type=["']module["'][^>]*src=["']src\/main\.js["'][^>]*><\/script>/.test(html)) {
    throw new Error('index.html 里找不到入口 <script type="module" src="src/main.js">');
  }
  html = html.replace(/<script\s+type=["']module["'][^>]*src=["']src\/main\.js["'][^>]*><\/script>/, bundle);

  // 单文件版不需要外链资源了，去掉 modulepreload 之类残留
  html = html.replace(/[ \t]*<link[^>]*rel=["'](?:modulepreload|preload)["'][^>]*>\s*/g, '');

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`  产物: dist/IRONFALL.html  (${kb} KB)`);
  console.log(`  耗时: ${Date.now() - t0} ms`);
  console.log('  双击该文件即可离线游玩（无需 Node / 服务器）');
}

main().catch((e) => {
  console.error('打包失败:', e && e.message ? e.message : e);
  process.exit(1);
});
