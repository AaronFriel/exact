import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureWebProducts, cargoContractReads, changedContractReads, contractReadReceipt, loopWebDist, privateNativeBuild, privateWebBuild } from './web-build.mjs';
import { appleArtifacts } from '../host/apple/build.mjs';
import { resolveApp } from './app.mjs';
import { webChanges, webInputDigests } from './agent-launch.mjs';
import { replaceBuild } from '../host/web/serve.mjs';
let fallbackRoots = [];
mock.module('../host/web/build.mjs', () => ({ webSourceRoots: () => fallbackRoots }));

test('loops and concurrent checks publish into directories they alone own', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-web-owners-'));
  const app = { dir, target: resolve(dir, 'target') }, other = { ...app, dir: resolve(dir, 'other') };
  const checks = ['test', 'verify', 'agent', 'test'].map(kind => privateWebBuild(app, kind));
  try {
    const loops = [loopWebDist(app, 'js'), loopWebDist(app, 'wasm'), loopWebDist(other, 'js')];
    const outputs = [...loops, ...checks.map(check => check.dist)];
    expect(new Set(outputs).size).toBe(outputs.length);
    expect(new Set(checks.map(check => check.env.EXACT_BAKE_OUTPUT)).size).toBe(checks.length);
    for (const check of checks) expect(check.env.EXACT_WEB_TYPES).toBe('private');
    for (const [n, dist] of outputs.entries()) {
      const stage = resolve(dir, `stage-${n}`);
      mkdirSync(stage);
      writeFileSync(resolve(stage, 'index.html'), `server-${n}`);
      replaceBuild(stage, dist);
    }
    for (const [n, dist] of outputs.entries()) expect(readFileSync(resolve(dist, 'index.html'), 'utf8')).toBe(`server-${n}`);
    checks[0].close();
    expect(existsSync(checks[0].dist)).toBe(false);
    for (const dist of outputs.filter(dist => dist !== checks[0].dist)) expect(existsSync(resolve(dist, 'index.html'))).toBe(true);
  } finally { for (const check of checks) check.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Contract freshness compares compiled reads, including deletion and edits at an unchanged mtime', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-web-reads-'));
  const app = { dir, target: resolve(dir, 'target'), manifest: {} }, dist = resolve(app.target, 'dist');
  const entry = resolve(dir, 'app.contract'), used = resolve(dir, 'used.contract'), unused = resolve(dir, 'unused.contract');
  const text = 'component App\n  text "compiled"\n';
  const hash = value => createHash('sha256').update(value).digest('hex');
  try {
    mkdirSync(dist, { recursive: true });
    for (const path of [entry, used, unused]) writeFileSync(path, text);
    writeFileSync(resolve(dist, 'app.plan.map.json'), JSON.stringify({ sources: [entry, used].map(file => ({ file, sha256: hash(text) })) }));
    const reads = { contract: contractReadReceipt(dist) };
    const inputs = webInputDigests(app, true, []);
    writeFileSync(resolve(dist, '.exact-build.json'), JSON.stringify({ inputs, inputRoots: [], inputsAt: 0, reads }));
    expect(webChanges(dist, app).all).toEqual([]);
    writeFileSync(unused, 'changed');
    writeFileSync(resolve(dir, 'new.contract'), 'not imported');
    const output = resolve(dir, 'output.contract');
    writeFileSync(output, 'output');
    expect(webChanges(dist, app).all).toEqual([]);
    writeFileSync(resolve(dist, '.exact-build.json'), JSON.stringify({ inputs, inputRoots: [], inputsAt: 0 }));
    expect(webChanges(dist, app).app).toContain(output);
    writeFileSync(resolve(dist, '.exact-build.json'), JSON.stringify({ inputs, inputRoots: [], inputsAt: 0, reads }));
    utimesSync(used, 1, 1);
    expect(changedContractReads(reads.contract)).toEqual([]);
    // A save after compilation but before receipt publication must not be certified by a final reread.
    writeFileSync(used, 'changed during build');
    utimesSync(used, 1, 1);
    expect(contractReadReceipt(dist)[used]).toBe(hash(text));
    expect(webChanges(dist, app).app).toContain(used);
    rmSync(used);
    expect(changedContractReads(reads.contract)).toEqual([used]);
    writeFileSync(used, text);
    expect(webChanges(dist, app).all).toEqual([]);
    // Cargo can independently read Contract text with include_str!, outside the plan's graph.
    const included = resolve(dir, 'included.contract');
    writeFileSync(included, 'Rust input');
    const inputRoots = [{ file: included }];
    writeFileSync(resolve(dist, '.exact-build.json'), JSON.stringify({ inputs: webInputDigests(app, true, inputRoots), inputRoots, inputsAt: 0, reads }));
    writeFileSync(included, 'changed Rust input');
    expect(webChanges(dist, app).app).toContain(included);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['asset edit', 'asset deletion', 'Cargo alias', 'loop fallback', 'loop deletion'])('%s stays a Contract input', kind => {
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-contract-inputs-'));
  const app = { dir, target: resolve(dir, 'target'), manifest: {} }, dist = resolve(app.target, 'dist');
  const included = resolve(dir, 'included.contract'), asset = resolve(dir, 'assets/example.contract');
  const alias = resolve(dir, 'alias');
  try {
    mkdirSync(dist, { recursive: true });
    mkdirSync(resolve(dir, 'assets'));
    symlinkSync(dir, alias);
    for (const path of [included, asset]) writeFileSync(path, 'read');
    const inputRoots = [{ file: realpathSync(included) }], reads = { contract: {} };
    const marker = resolve(dist, '.exact-build.json');
    writeFileSync(marker, JSON.stringify({ target: 'js', inputs: webInputDigests(app, true, inputRoots), inputRoots, inputsAt: 0, reads }));
    if (kind.startsWith('asset')) {
      if (kind === 'asset edit') writeFileSync(asset, 'edited asset');
      else rmSync(asset);
      expect(webChanges(dist, app).all).toContain(asset);
    } else if (kind === 'Cargo alias') {
      const linked = { ...app, dir: alias };
      writeFileSync(marker, JSON.stringify({ target: 'js', inputs: webInputDigests(linked, true, inputRoots), inputRoots, inputsAt: 0, reads }));
      writeFileSync(included, 'edited Cargo read');
      expect(webChanges(dist, linked).all).toContain(realpathSync(included));
    } else {
      fallbackRoots = inputRoots;
      const cargo = kind === 'loop deletion' ? cargoContractReads([{ file: included }]) : {};
      writeFileSync(marker, JSON.stringify({ target: 'js', inputsAt: 0, reads: { ...reads, cargo } }));
      if (kind === 'loop deletion') rmSync(included);
      else writeFileSync(included, 'edited Cargo read');
      expect(webChanges(dist, app).all.some(path => path === included || path === inputRoots[0].file)).toBe(true);
    }
  } finally { fallbackRoots = []; rmSync(dir, { recursive: true, force: true }); }
});

test('packaging retains each wasm product after another build replaces the Cargo name', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-web-products-'));
  const path = resolve(dir, 'app.wasm'), sha256 = text => createHash('sha256').update(text).digest('hex');
  try {
    writeFileSync(path, 'first wasm');
    const first = captureWebProducts({ products: [{ path, sha256: sha256('first wasm') }] }, resolve(dir, 'first'));
    writeFileSync(path, 'second wasm');
    const second = captureWebProducts({ products: [{ path, sha256: sha256('second wasm') }] }, resolve(dir, 'second'));
    expect(readFileSync(first[path], 'utf8')).toBe('first wasm');
    expect(readFileSync(second[path], 'utf8')).toBe('second wasm');
    expect(() => captureWebProducts({ products: [{ path, sha256: sha256('first wasm') }] }, resolve(dir, 'bad'))).toThrow('changed before capture');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native verification owns its captures, products, bundle and receipt through launch', () => {
  const app = resolveApp('caltrain'), builds = ['test', 'verify', 'agent'].map(kind => privateNativeBuild(app, kind));
  const previous = process.env.EXACT_APPLE_OUTPUT;
  try {
    const paths = builds.map(build => {
      process.env.EXACT_APPLE_OUTPUT = build.env.EXACT_APPLE_OUTPUT;
      return appleArtifacts(app, { destination: 'ios-simulator' });
    });
    for (const field of ['capture', 'products', 'bundle', 'scratch', 'lock']) expect(new Set(paths.map(p => p[field])).size).toBe(builds.length);
    expect(new Set(paths.map(p => p.swift)).size).toBe(1);
    for (const [n, p] of paths.entries()) {
      mkdirSync(p.bundle, { recursive: true });
      writeFileSync(resolve(p.bundle, 'receipt.json'), `receipt-${n}`);
    }
    builds[0].close();
    expect(readFileSync(resolve(paths[1].bundle, 'receipt.json'), 'utf8')).toBe('receipt-1');
    expect(readFileSync(resolve(paths[2].bundle, 'receipt.json'), 'utf8')).toBe('receipt-2');
  } finally {
    if (previous === undefined) delete process.env.EXACT_APPLE_OUTPUT; else process.env.EXACT_APPLE_OUTPUT = previous;
    for (const build of builds) build.close();
  }
});
