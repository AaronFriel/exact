import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ensurePackageGpu, gpuModules, gpuVersionMatches, gpuView, gpuWorkspaceInputs, joinMetadata, packageGpuLock, packageGpuManifest, unregisteredSurfaces } from './app-shells.mjs';
import { fresh } from '../host/web-js/module.mjs';
import { withoutExtensions } from '../host/apple/extensions.mjs';
import { bakeTarget, HOST_DEV, linuxBinary, linuxBuild, patchLines } from './app.mjs';
import { androidBuild } from './agent-android.mjs';
import { webChanges, webNeeds } from './agent-launch.mjs';
import { webSourceRoots } from '../host/web/build.mjs';

test('Linux build commands put primary and alternate binaries where the driver reads them', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-linux-'));
  try {
    writeFileSync(resolve(dir, 'Cargo.toml'), '[workspace]\n[package]\nname="fixture-linux"\nversion="0.1.0"\nedition="2021"\n[profile.host-dev]\ninherits="dev"\n');
    mkdirSync(resolve(dir, 'src/bin'), { recursive: true });
    writeFileSync(resolve(dir, 'src/main.rs'), 'fn main() {}');
    writeFileSync(resolve(dir, 'src/bin/fixture-render.rs'), 'fn main() {}');
    for (const [hasGpu, modules] of [[false, {}], [true, {}], [false, { sky: ['sky'] }]]) {
      const app = { dir, workspace: dir, target: resolve(dir, 'target'), hasGpu, manifest: { gpu: { modules } }, crate: kind => `fixture-${kind}` };
      for (const bin of [null, 'fixture-render']) {
        const [command, ...args] = linuxBuild(app, bin);
        const built = spawnSync(command, args, { cwd: dir, env: { ...process.env, CARGO_TARGET_DIR: app.target }, encoding: 'utf8' });
        assert.equal(built.status, 0, built.stderr);
        const binary = linuxBinary(app, bin ?? app.crate('linux'));
        assert.ok(existsSync(binary), `${args.join(' ')} did not produce ${binary}`);
        assert.equal(spawnSync(binary).status, 0);
      }
      const android = androidBuild(app);
      assert.equal(android.filter(arg => arg === '--target').length, 1);
      assert.ok(android.includes('aarch64-linux-android'));
      const target = hasGpu || Object.keys(modules).length ? [bakeTarget('linux')] : [];
      assert.equal(linuxBinary(app), resolve(app.target, ...target, HOST_DEV, 'fixture-linux'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

test('a package GPU module whose targets omit a platform adds nothing to its build', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-omitted-'));
  try {
    const pkg = resolve(dir, 'node_modules/@fixture/sky');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    writeFileSync(resolve(pkg, 'package.json'), '{"exports":"./exact.json"}');
    const declaration = JSON.parse(readFileSync(resolve(import.meta.dir, '../packages/fixtures/sky/exact.json'), 'utf8'));
    writeFileSync(resolve(pkg, 'exact.json'), JSON.stringify({ ...declaration, gpu: { ...declaration.gpu, targets: ['macos'] } }));
    const app = { dir, workspace: dir, target: resolve(dir, 'target'), hasGpu: false, manifest: packageGpuManifest({}, dir), crate: kind => `fixture-${kind}` };
    assert.equal(linuxBuild(app).includes('--target'), false);
    assert.equal(linuxBinary(app), resolve(app.target, HOST_DEV, 'fixture-linux'));
    assert.deepEqual(webNeeds(app), []);
    assert.deepEqual(unregisteredSurfaces(app.manifest, 'web'), ['sky']);
    assert.deepEqual(unregisteredSurfaces(app.manifest, 'macos'), []);
    // On the web its canvas is neither a GPU nor a Canvas 2D surface, so the build refuses nothing (LLP 1153.003 D5.8).
    writeFileSync(resolve(dir, 'app.json'), JSON.stringify({ name: 'Sky', app: { id: 'test.exact.sky', name: 'Sky' }, rust: false }));
    writeFileSync(resolve(dir, 'app.contract'), 'component App\n  view\n    canvas surface=sky(false) width=10 height=10\n');
    const build = () => spawnSync(process.execPath, ['host/web/build.mjs', 'sky', '--render', 'none'], { cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, EXACT_APP_DIR: dir, EXACT_WEB_DIST: resolve(dir, 'dist') }, encoding: 'utf8' });
    const built = build();
    assert.equal(built.status, 0, built.stderr);
    const js = readFileSync(resolve(dir, 'dist/.gen/app.js'), 'utf8');
    assert.match(js, /cv\(e\d+\)/);
    assert.equal(js.includes('"sky"'), false);
    assert.equal(existsSync(resolve(dir, 'dist/.gen/canvas2d.flag')), false);
    assert.equal(existsSync(resolve(dir, '.exact/package-gpu')), false);
    // The build read the declaration: adding the web to its targets makes it stale.
    const omitted = readFileSync(resolve(pkg, 'exact.json'));
    writeFileSync(resolve(pkg, 'exact.json'), JSON.stringify({ ...declaration, gpu: { ...declaration.gpu, targets: ['macos', 'web'] } }));
    assert.ok(webChanges(resolve(dir, 'dist'), { ...app, name: 'sky' }).all.some(path => resolve(path) === resolve(pkg, 'exact.json')));
    writeFileSync(resolve(pkg, 'exact.json'), omitted);
    writeFileSync(resolve(dir, 'optional.ts'), 'export const helper = 1;\n');
    const data = "export const grants = '';\nexport const answer = () => { throw new Error('no source'); };\n";
    writeFileSync(resolve(dir, 'app.ts'), data + "export * from './optional';\n");
    const reexported = build();
    assert.equal(reexported.status, 0, reexported.stderr);
    assert.equal(readFileSync(resolve(dir, 'dist/.gen/app.js'), 'utf8').includes('"sky"'), false);
    assert.equal(existsSync(resolve(dir, 'dist/.gen/canvas2d.flag')), false);
    // A data source that draws keeps the name a Canvas 2D surface, as on a native host.
    const drawing = 'export const surfaces = { sky: 1 };\nexport const draw = () => false;\n';
    writeFileSync(resolve(dir, 'optional.ts'), drawing);
    for (const exports of [drawing, "export * from './optional';\n"]) {
      writeFileSync(resolve(dir, 'app.ts'), data + exports);
      const drawn = build();
      assert.equal(drawn.status, 0, drawn.stderr);
      assert.match(readFileSync(resolve(dir, 'dist/.gen/app.js'), 'utf8'), /c2\(e\d+,"sky"/);
    }
    rmSync(resolve(dir, 'app.ts'));
    // The app's own GPU module registering the name draws it instead, as a native host's primary does. Cached
    // stand-ins register it without a GPU toolchain build (host/web-js/build.test.mjs does the same).
    const cache = resolve(dir, 'target/web-js-gpu/sky'), deps = resolve(dir, 'target/wasm32-unknown-unknown/web');
    for (const d of [resolve(dir, 'gpu/src'), cache, deps]) mkdirSync(d, { recursive: true });
    writeFileSync(resolve(dir, 'gpu/src/lib.rs'), '');
    writeFileSync(resolve(dir, 'gpu/Cargo.toml'), '[package]\nname="sky-gpu"\nversion="0.1.0"\nedition="2021"\n');
    writeFileSync(resolve(dir, 'Cargo.toml'), `[workspace]\nmembers=["gpu"]\nresolver="2"\n[patch.crates-io]\n${patchLines(dir).join('\n')}\n`);
    const locked = spawnSync('cargo', ['generate-lockfile', '--offline'], { cwd: dir, encoding: 'utf8' });
    assert.equal(locked.status, 0, locked.stderr);
    writeFileSync(resolve(cache, 'gpu.js'), "export function initSync() {}\nexport function gpu_surfaces() { return '[\"sky\"]'; }\n");
    writeFileSync(resolve(cache, 'gpu_bg.wasm'), '');
    writeFileSync(resolve(cache, '.modules.json'), JSON.stringify([['gpu', 'sky-gpu']]));
    writeFileSync(resolve(deps, 'sky_gpu.d'), `sky_gpu: ${resolve(dir, 'app.json')}\n`);
    utimesSync(resolve(dir, 'app.json'), 0, 0);
    const primary = build();
    assert.equal(primary.status, 0, primary.stderr);
    assert.match(readFileSync(resolve(dir, 'dist/.gen/app.js'), 'utf8'), /gs\(e\d+,"sky"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

test('ordinary packages with nested conditional exports have no GPU declaration', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-exports-'));
  try {
    const pkg = resolve(dir, 'node_modules/ordinary');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { ordinary: '1.0.0' } }));
    for (const exports of [{ '.': { default: { import: './index.mjs', require: './index.cjs' } } }, { '.': { contract: { default: './index.mjs' } } }]) {
      writeFileSync(resolve(pkg, 'package.json'), JSON.stringify({ exports }));
      assert.deepEqual(gpuModules(packageGpuManifest({}, dir)), []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the GPU build graph selects package targets by the Apple destination', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-target-'));
  try {
    const pkg = resolve(dir, 'node_modules/@fixture/sky');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    writeFileSync(resolve(pkg, 'package.json'), '{"exports":"./exact.json"}');
    const declaration = JSON.parse(readFileSync(resolve(import.meta.dir, '../packages/fixtures/sky/exact.json'), 'utf8'));
    const source = readFileSync(resolve(import.meta.dir, 'app.mjs'), 'utf8');
    const body = source.slice(source.indexOf('function buildGraph('), source.indexOf('/** What a build writes'));
    const metadata = (name, workspace) => ({ workspace_root: workspace,
      packages: [{ id: name, name, targets: [] }], resolve: { nodes: [{ id: name, deps: [] }] }, workspace_members: [name] });
    const graph = new Function('gpuView', 'bakeMetadata', 'gpuModules', 'joinMetadata', `${body}; return buildGraph;`)(
      (app, module) => module ? { workspace: 'gpu' } : app,
      app => metadata(app.workspace === 'gpu' ? 'fixture-gpu-fixture-sky' : 'fixture-apple', app.workspace), gpuModules, joinMetadata);
    // No `targets` means every host that draws GPU surfaces, which the watch is not.
    for (const supported of ['ios', 'tvos', undefined]) {
      declaration.gpu.targets = supported && [supported];
      writeFileSync(resolve(pkg, 'exact.json'), JSON.stringify(declaration));
      const app = { workspace: 'host', manifest: packageGpuManifest({}, dir), crate: kind => `fixture-${kind}` };
      for (const destination of ['ios', 'tvos', 'watchos']) {
        const built = graph(app, `aarch64-apple-${destination}-sim`, 'apple', {}, false, 'ios');
        const expected = destination !== 'watchos' && (!supported || supported === destination);
        assert.deepEqual(built.modules.map(p => p.name), expected ? ['fixture-gpu-fixture-sky'] : [], `${supported} on ${destination}`);
      }
    }
    declaration.gpu.targets = ['watchos'];
    writeFileSync(resolve(pkg, 'exact.json'), JSON.stringify(declaration));
    assert.throws(() => packageGpuManifest({}, dir), /targets may name only web, macos, ios, tvos, android, linux, windows/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the web GPU cache watches package features and resolved workspace inputs', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-inputs-'));
  const pkg = resolve(dir, 'node_modules/@fixture/sky'), root = resolve(import.meta.dir, '../packages/fixtures/sky');
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    for (const file of ['package.json', 'exact.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/src/lib.rs']) put(resolve(pkg, file), readFileSync(resolve(root, file)));
    put(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    const manifest = resolve(pkg, 'rust/Cargo.toml');
    put(manifest, readFileSync(manifest, 'utf8').replace('[dependencies]', '[dependencies]\nhelper = {path="../helper"}'));
    put(resolve(pkg, 'helper/Cargo.toml'), '[package]\nname="helper"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[]\nred=[]\n');
    put(resolve(pkg, 'helper/src/lib.rs'), 'pub const RED: bool = cfg!(feature = "red");');
    const app = { dir, crate: kind => `fixture-${kind}` }, module = gpuModules(packageGpuManifest({}, dir))[0];
    const workspace = ensurePackageGpu(app, module), source = readFileSync(resolve(import.meta.dir, '../host/web-js/build.mjs'), 'utf8');
    const body = source.slice(source.indexOf('const gpuInputs ='), source.indexOf('    const roster ='));
    const inputs = new Function('target', 'declaredGpu', 'gpuLib', 'existsSync', 'shaderWatchRoots', 'gpuView', 'gpuWorkspaceInputs', 'resolve',
      `${body} return gpuInputs; } catch (error) { throw error; }`)(app, [module], resolve(dir, 'gpu/src/lib.rs'), existsSync, () => [], gpuView, gpuWorkspaceInputs, resolve);
    assert.ok(inputs.includes(resolve(import.meta.dir, '../Cargo.toml')), 'the checkout supplies Cargo profiles');
    const product = resolve(dir, 'gpu.wasm'), dep = `${product}.d`, built = Date.now() / 1000 + 10;
    put(product, 'cached wasm'); put(dep, `${product}: ${resolve(pkg, 'rust/src/lib.rs')}\n`);
    utimesSync(product, built, built);
    assert.equal(fresh(product, dep, inputs), true);
    for (const file of [manifest, resolve(pkg, 'helper/Cargo.toml'), ...['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml'].map(f => resolve(workspace, f))]) {
      const before = statSync(file);
      try {
        utimesSync(file, built + 1, built + 1);
        assert.equal(fresh(product, dep, inputs), false, file);
      } finally { utimesSync(file, before.atime, before.mtime); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test('web input discovery reads package declarations as they are now and leaves generated workspaces alone', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-discovery-'));
  const pkg = resolve(dir, 'node_modules/@fixture/sky'), root = resolve(import.meta.dir, '../packages/fixtures/sky');
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    for (const file of ['package.json', 'exact.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/src/lib.rs']) put(resolve(pkg, file), readFileSync(resolve(root, file)));
    put(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    // A dev loop's parent keeps the manifest it started with; the build after a declaration edit regenerates.
    const app = { dir, workspace: dir, target: resolve(dir, 'target'), manifest: packageGpuManifest({}, dir), crate: kind => `fixture-${kind}` };
    const declaration = JSON.parse(readFileSync(resolve(pkg, 'exact.json'), 'utf8'));
    declaration.gpu.surfaces.sky.arity = 2;
    put(resolve(pkg, 'exact.json'), JSON.stringify(declaration));
    const workspace = ensurePackageGpu(app, gpuModules(packageGpuManifest({}, dir))[0]);
    const lib = resolve(workspace, 'src/lib.rs'), generated = readFileSync(lib, 'utf8'), written = statSync(lib).mtimeMs;
    assert.match(generated, /\("sky", 2, /);
    const roots = webSourceRoots(app, true), files = roots.filter(r => r.file).map(r => r.file);
    assert.equal(readFileSync(lib, 'utf8'), generated);
    assert.equal(statSync(lib).mtimeMs, written);
    // What the build generates from these is not an input of its own: its own write would set the build aside.
    for (const file of [resolve(pkg, 'exact.json'), resolve(pkg, 'rust/Cargo.lock')]) assert.ok(files.includes(file), file);
    assert.ok(roots.includes(resolve(pkg, 'rust')));
    assert.equal(roots.some(r => (r.file ?? r).startsWith(workspace)), false);
    // A package that leaves the web out is still read, so that adding it back rebuilds.
    declaration.gpu.targets = ['macos'];
    put(resolve(pkg, 'exact.json'), JSON.stringify(declaration));
    const omitted = webSourceRoots(app, true).filter(r => r.file).map(r => r.file);
    for (const file of [resolve(pkg, 'exact.json'), resolve(pkg, 'rust/Cargo.lock')]) assert.ok(omitted.includes(file), file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test('package GPU modules resolve independently from shipped locks and reject incompatible declarations', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-package-'));
  const root = resolve(import.meta.dir, '../packages/fixtures/sky'), pkg = resolve(dir, 'node_modules/@fixture/sky');
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    for (const file of ['package.json', 'exact.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/src/lib.rs']) put(resolve(pkg, file), readFileSync(resolve(root, file)));
    put(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    const declared = () => gpuModules(packageGpuManifest({}, dir))[0];
    const manifestBeforeFiltering = packageGpuManifest({}, dir);
    assert.deepEqual(gpuModules(withoutExtensions(manifestBeforeFiltering, new Set())), gpuModules(manifestBeforeFiltering));
    const module = declared(), lock = readFileSync(resolve(pkg, 'rust/Cargo.lock'), 'utf8');
    for (const name of ['one', 'two']) {
      const workspace = ensurePackageGpu({ dir, crate: kind => `${name}-${kind}` }, module);
      const metadata = spawnSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], { cwd: workspace, encoding: 'utf8' });
      assert.equal(metadata.status, 0, metadata.stderr);
      const packages = JSON.parse(metadata.stdout).packages;
      assert.ok(packages.some(p => p.name === `${name}-gpu-fixture-sky`));
      assert.equal(packages.filter(p => p.name === 'exact-gpu').length, 1);
      assert.equal(packages.find(p => p.name === 'exact-gpu').source, null);
      assert.equal(packages.some(p => p.name === 'exact-js' || p.name === 'contract'), false);
      assert.equal(readFileSync(resolve(pkg, 'rust/Cargo.lock'), 'utf8'), lock);
    }
    const app = { dir, crate: kind => `one-${kind}` };
    assert.throws(() => ensurePackageGpu(app, { ...module, exactGpu: '0.3' }), /requires exact-gpu 0.3, but this checkout provides 0.2.0/);
    const cargo = readFileSync(resolve(pkg, 'rust/Cargo.toml'), 'utf8');
    put(resolve(pkg, 'rust/Cargo.toml'), cargo.replace('exact-gpu = "0.2"', 'exact-gpu = "0.3"'));
    assert.throws(() => ensurePackageGpu(app, module), /without a path, git or workspace dependency/);
    put(resolve(pkg, 'rust/Cargo.toml'), cargo.replace('exact-gpu = "0.2"', 'exact-gpu = "0.2"\nexact-plan = "0.1"'));
    assert.throws(() => ensurePackageGpu(app, module), /may depend on exact-gpu, not exact-plan/);
    put(resolve(pkg, 'rust/Cargo.toml'), cargo);
    rmSync(resolve(pkg, 'rust/Cargo.lock'));
    assert.throws(() => ensurePackageGpu(app, module), /must ship Cargo.lock/);
    assert.throws(() => packageGpuManifest({ gpu: { modules: { custom: ['sky'] } } }, dir), /surface sky is claimed by both/);
    assert.throws(() => packageGpuManifest({ gpu: { modules: { 'fixture-sky': ['other'] } } }, dir), /module fixture-sky is claimed by both/);
    const declaration = JSON.parse(readFileSync(resolve(pkg, 'exact.json'), 'utf8'));
    declaration.gpu.targets = ['macos'];
    put(resolve(pkg, 'exact.json'), JSON.stringify(declaration));
    const manifest = packageGpuManifest({}, dir);
    assert.equal(gpuModules(manifest, 'web').length, 0);
    assert.equal(gpuModules(manifest, 'macos').length, 1);
    const source = readFileSync(resolve(import.meta.dir, '../host/web-js/build.mjs'), 'utf8');
    const classify = source.slice(source.indexOf('gpuSurfaces = [...'), source.indexOf('// The compiler, run'));
    const surfaces = new Function('gpuModules', 'unregisteredSurfaces', 'manifest', 'declaredGpu', 'ts', 'rust', `let gpuSurfaces = []; ${classify}; return gpuSurfaces;`)(gpuModules, unregisteredSurfaces, manifest, gpuModules(manifest, 'web'), false, false);
    assert.deepEqual(surfaces, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test('a package lock replaces the GPU subtree and retains shared dependencies', () => {
  const block = (name, version, deps = [], source = '') => `[[package]]\nname = "${name}"\nversion = "${version}"\n${source ? `source = "${source}"\n` : ''}dependencies = ${JSON.stringify(deps)}\n`;
  const own = 'version = 4\n\n' + block('map', '1.0.0', ['exact-gpu', 'shared']) + block('exact-gpu', '0.1.0', ['old-only', 'shared'], 'registry+old') + block('old-only', '1.0.0') + block('shared', '1.0.0');
  const sdk = 'version = 4\n\n' + block('exact-gpu', '0.2.0', ['new-only', 'shared']) + block('new-only', '1.0.0') + block('shared', '1.0.0') + block('host', '1.0.0');
  const packages = Bun.TOML.parse(packageGpuLock(sdk, own)).package;
  assert.deepEqual(packages.map(p => p.name).sort(), ['exact-gpu', 'map', 'new-only', 'shared']);
  assert.equal(packages.find(p => p.name === 'exact-gpu').source, undefined);
  for (const requirement of ['0.2', '^0.2.0', '>=0.2, <0.3', '=0.2.0']) assert.ok(gpuVersionMatches('0.2.0', requirement), requirement);
  assert.equal(gpuVersionMatches('0.3.0', '0.2'), false);
});


test('a package resolves with an empty Cargo cache before enforcing its shipped versions', async () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '../target/gpu-cold-'));
  const cache = resolve(process.env.CARGO_HOME ?? resolve(homedir(), '.cargo'), 'registry');
  const pkg = resolve(dir, 'node_modules/@fixture/sky'), root = resolve(import.meta.dir, '../packages/fixtures/sky');
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const previous = process.env.CARGO_HOME;
  // Serve the machine's pinned registry bytes from a local sparse registry.
  const server = Bun.spawn([process.execPath, '-e', `
    import { existsSync, readdirSync, readFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    const cache = ${JSON.stringify(cache)};
    const find = (kind, name) => readdirSync(resolve(cache, kind)).map(index => resolve(cache, kind, index, name)).find(existsSync);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname.slice(1);
      if (path === 'config.json') return Response.json({ dl: server.url + 'crates/{crate}-{version}.crate' });
      if (path.startsWith('crates/')) {
        const file = find('cache', path.slice(7));
        return file ? new Response(Bun.file(file)) : new Response('uncached fixture archive', {status:404});
      }
      const file = find('index', '.cache/' + path);
      if (!file) return new Response('uncached fixture index', {status:404});
      const rows = readFileSync(file, 'utf8').split('\\0').filter(row => row.startsWith('{'));
      return new Response(rows.join('\\n') + '\\n');
    }});
    console.log(server.port);
  `], { stdout: 'pipe', stderr: 'inherit' });
  try {
    const port = Number(new TextDecoder().decode((await server.stdout.getReader().read()).value));
    assert.ok(port > 0);
    for (const file of ['package.json', 'exact.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/src/lib.rs']) put(resolve(pkg, file), readFileSync(resolve(root, file)));
    put(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { '@fixture/sky': '1.0.0' } }));
    const home = resolve(dir, 'cargo');
    put(resolve(home, 'config.toml'), `[source.crates-io]\nreplace-with="fixture"\n[source.fixture]\nregistry="sparse+http://127.0.0.1:${port}/"\n`);
    process.env.CARGO_HOME = home;
    const module = gpuModules(packageGpuManifest({}, dir))[0];
    const workspace = ensurePackageGpu({ dir, crate: kind => `cold-${kind}` }, module);
    const result = spawnSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).packages.some(p => p.name === 'cold-gpu-fixture-sky'));
  } finally {
    if (previous === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = previous;
    server.kill(); await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
