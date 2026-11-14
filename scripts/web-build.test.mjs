import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { changedContractReads, contractReadReceipt, loopWebDist, privateWebBuild } from './web-build.mjs';
import { webChanges, webInputDigests } from './agent-launch.mjs';
import { replaceBuild } from '../host/web/serve.mjs';

test('loops and concurrent checks publish into directories they alone own', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-web-owners-'));
  const app = { dir, target: resolve(dir, 'target') }, other = { ...app, dir: resolve(dir, 'other') };
  const checks = ['test', 'verify', 'agent', 'test'].map(kind => privateWebBuild(app, kind));
  try {
    const loops = [loopWebDist(app, 'js'), loopWebDist(app, 'wasm'), loopWebDist(other, 'js')];
    const outputs = [...loops, ...checks.map(check => check.dist)];
    expect(new Set(outputs).size).toBe(outputs.length);
    for (const check of checks) expect(check.env).toEqual({ EXACT_WEB_DIST: check.dist, EXACT_WEB_TYPES: 'private' });
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
    writeFileSync(resolve(dist, 'output.contract'), 'output');
    expect(webChanges(dist, app).all).toEqual([]);
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
