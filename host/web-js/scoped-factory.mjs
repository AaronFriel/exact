// `--scoped --factory` (host/web-js/build.mjs): the runtime as one shared factory module, and a per-view app.js that calls it.
//
// A plain `--scoped` build bundles the whole runtime (about 270 KB production, 97% of app.js) into every view, so a page of N
// views carries N copies. Here the runtime (main.js, everything it imports, shim included) is bundled once into `runtime.js`,
// a module whose default export `create(scope)` runs that code inside a fresh function scope: each call has its own `data`,
// `journal`, `clock` and the rest of the runtime's module-level state, and its own scoped-document shim bound to `scope`.
// `runtime.js` does not depend on the view (only on the build's feature flags and runtime variant), so views built from the same
// Exact with the same flags get byte-identical runtime.js files and a page can load one. The view's own generated modules
// (the compiled plan app.js, names.js, admission-data.js, grant-network.js) become the small `app.js`: it imports `./runtime.js`,
// calls `create(<its ?scope=>)`, hands the generated modules to that instance and boots it. Isolation is the same as before
// (one runtime instance per scope, own shadow root); only the code is shared.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';

// In dependency order (paint.js: the compiler's per-app feature flags; the plan imports it).
const PER_VIEW = ['paint.js', 'app.js', 'names.js', 'admission-data.js', 'grant-network.js'];
const unitId = (name) => 'unit_' + name.replace(/\W/g, '_');
const APP_ID = /const appId = "[^"\n]*";/;
const keyOf = (spec) => spec.replace(/^\.\//, '');

// The imports, exports and body of a generated module, as text edits (every module here is plain ESM: Exact's own generator output).
function analyse(file, code, units) {
  const { program, errors } = parseSync(file, code);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const imports = [], exports = [], edits = [];
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      imports.push({ source: node.source.value, specifiers: node.specifiers });
      edits.push({ start: node.start, end: node.end, text: `const ${destructure(node)} = ${units.has(keyOf(node.source.value)) ? unitId(keyOf(node.source.value)) : `__ns[${JSON.stringify(keyOf(node.source.value))}]`};` });
    } else if (node.type === 'ExportDefaultDeclaration') {
      exports.push(['default', '__default']);
      edits.push({ start: node.start, end: node.declaration.start, text: 'const __default = ' });
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const d = node.declaration;
        for (const name of d.type === 'VariableDeclaration' ? d.declarations.map(x => x.id.name) : [d.id.name]) exports.push([name, name]);
        edits.push({ start: node.start, end: d.start, text: '' });
      } else {
        for (const s of node.specifiers) exports.push([s.exported.name ?? s.exported.value, s.local.name]);
        edits.push({ start: node.start, end: node.end, text: '' });
      }
    }
  }
  return { imports, exports, edits };
}
function destructure(node) {
  const named = node.specifiers.filter(s => s.type === 'ImportSpecifier').map(s => s.imported.name === s.local.name ? s.local.name : `${s.imported.name ?? s.imported.value}: ${s.local.name}`);
  const ns = node.specifiers.find(s => s.type === 'ImportNamespaceSpecifier');
  if (ns) return ns.local.name; // import * as x: the namespace itself
  if (node.specifiers.some(s => s.type === 'ImportDefaultSpecifier')) throw new Error('a default import of a runtime module is not supported');
  return `{ ${named.join(', ')} }`;
}
const apply = (code, edits) => edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), code);

export async function buildFactory({ gen, out, here, names: given = {}, rolldown, bundleOptions, versionDefines, plugins, onLog, tsconfig }) {
  const read = (name) => readFileSync(resolve(gen, name), 'utf8');
  const views = PER_VIEW.filter(name => existsSync(resolve(gen, name)));
  const parts = Object.fromEntries(views.map(name => [name, analyse(name, read(name), new Set(views))]));

  // The slot: what the runtime reads from the view's modules, filled by `fill` before `boot`.
  const slotNames = (name) => parts[name]?.exports.map(([exported]) => exported) ?? [];
  const slotId = '\0q-factory-slot';
  const ident = (module, exported) => `${module.replace(/\W/g, '_')}__${exported}`;
  const slotSource = views.map(module => slotNames(module).map(e => `export let ${ident(module, e)};`).join('\n')).join('\n') + '\n'
    + `export function fill(v) {\n${views.map(module => slotNames(module).map(e => `  ${ident(module, e)} = v[${JSON.stringify(module)}][${JSON.stringify(e)}];`).join('\n')).join('\n')}\n}\n`;
  const virtualFor = (module) => `export { ${slotNames(module).map(e => `${ident(module, e)} as ${e === 'default' ? 'default' : e}`).join(', ')} } from ${JSON.stringify(slotId)};`;

  // What the view's generated code imports from the runtime, with whatever the caller says other views need: the runtime exports exactly
  // these names (live getters), so the bundle stays tree-shaken. A view that needs a name the runtime lacks needs a runtime built with it.
  const needs = new Map(Object.entries(given).map(([module, list]) => [module, new Set(list)]));
  for (const name of views) for (const i of parts[name].imports) {
    if (views.includes(keyOf(i.source))) continue;
    const set = needs.get(keyOf(i.source)) ?? needs.set(keyOf(i.source), new Set()).get(keyOf(i.source));
    for (const sp of i.specifiers) { if (sp.type !== 'ImportSpecifier') throw new Error(`scoped factory: ${name} imports ${i.source} other than by name`); set.add(sp.imported.name ?? sp.imported.value); }
  }
  const wanted = [...needs.keys()].sort();
  const exportsOf = Object.fromEntries(wanted.map(module => [module, [...needs.get(module)].sort()]));
  const main = read('main.js');
  const lines = main.split('\n');
  const importLines = lines.filter(l => /^import\s/.test(l));
  const body = lines.filter(l => !/^import\s/.test(l)).join('\n');
  if (!importLines.some(l => l.includes("'./app.js'"))) throw new Error('scoped factory: main.js does not import app.js as expected');
  writeFileSync(resolve(gen, 'factory-main.js'), [
    ...importLines.filter(l => !l.includes("'./app.js'")),
    `import { fill, ${ident('app.js', 'default')} as app, ${ident('app.js', 'sources')} as sources, ${ident('app.js', 'wait')} as wait } from ${JSON.stringify(slotId)};`,
    ...wanted.map((name, i) => `import { ${exportsOf[name].map(n => `${n} as m${i}_${n}`).join(', ')} } from './${name}';`),
    `export const modules = {${wanted.map((name, i) => ` ${JSON.stringify(name)}: { ${exportsOf[name].map(n => `get ${n}() { return m${i}_${n}; }`).join(', ')} },`).join('')} };`,
    `import { data as state_data, journal as state_journal } from './rt.js';`,
    `export const state = { get data() { return state_data; }, get journal() { return state_journal; } };`,
    `export { fill };`,
    `export function boot() {\n${body}\n}`,
  ].join('\n') + '\n');

  // The scoped-document shim, with its scope given by `create(scope)` instead of by the module's URL.
  const shimSource = readFileSync(resolve(here, 'scoped-document.js'), 'utf8');
  const named = "const name = new URL(import.meta.url).searchParams.get('scope');";
  if (!shimSource.includes(named)) throw new Error('scoped factory: scoped-document.js changed');
  writeFileSync(resolve(gen, 'scoped-document-factory.js'), shimSource.replace(named, 'const name = __scope;'));
  const shim = resolve(gen, 'scoped-document-factory.js');
  const inject = { __sw: [shim, 'sw'], document: [shim, 'document'], history: [shim, 'history'], location: [shim, 'location'] };

  const generated = new Map(views.filter(n => n !== 'app.js').map(n => [resolve(gen, n), n]));
  const factoryPlugin = {
    name: 'exact-factory',
    resolveId(source, importer) {
      if (source === slotId) return slotId;
      if (importer && source.startsWith('./')) { const full = resolve(importer, '..', source); if (generated.has(full)) return `${slotId}/${generated.get(full)}`; if (full === resolve(gen, 'app.js')) return `${slotId}/app.js`; }
      return null;
    },
    // ts-data.js carries the app's id (it keys storage): the runtime takes it from `create(scope, appId)` instead.
    transform(code, id) { return id === resolve(gen, 'ts-data.js') ? code.replace(APP_ID, 'const appId = __appId;') : null; },
    load(id) {
      if (id === slotId) return slotSource;
      if (id.startsWith(`${slotId}/`)) return virtualFor(id.slice(slotId.length + 1));
      return null;
    },
  };
  const b = await rolldown({ input: resolve(gen, 'factory-main.js'), ...(tsconfig ? { tsconfig } : {}),
    transform: { ...bundleOptions.transform, inject, define: { ...bundleOptions.transform.define, ...versionDefines, globalThis: '__sw', window: '__sw' } },
    plugins: [factoryPlugin, ...plugins()], logLevel: 'warn', onLog });
  let code;
  try {
    const result = await b.generate({ format: 'esm', minify: true, comments: false, codeSplitting: false });
    const chunk = result.output.find(f => f.type === 'chunk' && f.isEntry);
    code = chunk.code;
  } finally { await b.close(); }
  const tail = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(code);
  if (!tail) throw new Error('scoped factory: the runtime bundle has no export list');
  const api = tail[1].split(',').map(s => s.trim()).filter(Boolean).map(s => { const [local, exported] = s.split(/\s+as\s+/); return [exported ?? local, local]; });
  if (/^\s*(import\s|import\()/m.test(code.slice(0, tail.index).split('\n').filter(l => /^import\s/.test(l)).join('\n'))) throw new Error('scoped factory: the runtime bundle has imports left');
  const factory = `//# allFunctionsCalledOnLoad\nexport default function create(__scope, __appId) {${code.slice(0, tail.index)}\nreturn {${api.map(([exported, local]) => `${exported}:${local}`).join(',')}};}\n`;
  writeFileSync(resolve(out, 'runtime.js'), factory);

  // The view: its generated modules, each in its own function scope, then the instance.
  const appId = APP_ID.exec(read('ts-data.js'))?.[0].replace(/^const appId = /, '').replace(/;$/, '');
  if (!appId) throw new Error('scoped factory: ts-data.js has no app id');
  const unit = (name) => {
    const { exports, edits } = parts[name];
    return `const ${unitId(name)} = (() => {\n${apply(read(name), edits)}\nreturn { ${exports.map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`).join(', ')} };\n})();`;
  };
  // Units are evaluated in this order; the generated modules do not import one another except through the runtime.
  const unitSource = views.map(unit).join('\n');
  const view = [
    `import create from './runtime.js';`,
    `const __scope = new URL(import.meta.url).searchParams.get('scope');`,
    `const __rt = create(__scope, ${appId}), __ns = __rt.modules;`,
    unitSource,
    `__rt.fill({ ${views.map(n => `${JSON.stringify(n)}: ${unitId(n)}`).join(', ')} });`,
    `__rt.boot();`,
  ].join('\n') + '\n';
  writeFileSync(resolve(gen, 'factory-view.js'), view);
  const v = await rolldown({ input: resolve(gen, 'factory-view.js'), external: ['./runtime.js'], transform: { ...bundleOptions.transform }, logLevel: 'warn', onLog });
  try { await v.write({ file: resolve(out, 'app.js'), format: 'esm', minify: true, comments: false, codeSplitting: false }); }
  finally { await v.close(); }
  return { runtimeSha256: createHash('sha256').update(factory).digest('hex'), names: exportsOf };
}
