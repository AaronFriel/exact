import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// LLP 1172.010 E11: a frontend owns its publication; checks own one per invocation.
export function loopWebDist(app, target) {
  const identity = createHash('sha256').update(resolve(app.dir)).digest('hex').slice(0, 16);
  return resolve(app.target, 'web-loops', identity, target);
}

export function privateWebBuild(app, kind) {
  const root = resolve(app.target, 'web-runs');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, `${kind}-`));
  const dist = resolve(directory, 'dist');
  return { dist, env: { EXACT_WEB_DIST: dist, EXACT_BAKE_OUTPUT: resolve(directory, 'bake'), EXACT_WEB_TYPES: 'private' }, close: () => rmSync(directory, { recursive: true, force: true }) };
}

export function privateNativeBuild(app, kind) {
  const root = resolve(app.target, 'native-runs');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, `${kind}-`));
  return { env: { EXACT_APPLE_OUTPUT: resolve(directory, 'apple'), EXACT_BAKE_OUTPUT: resolve(directory, 'bake'), EXACT_WEB_TYPES: 'private' },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Copy while the producer still holds its Cargo product claims (LLP 1172.010 E11). */
export function captureWebProducts(receipt, directory) {
  mkdirSync(directory, { recursive: true });
  return Object.fromEntries(receipt.products.filter(product => product.path.endsWith('.wasm')).map(product => {
    const path = resolve(directory, basename(product.path));
    copyFileSync(product.path, path);
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== product.sha256) throw new Error(`Cargo product changed before capture: ${product.path}`);
    return [product.path, path];
  }));
}

export function cargoContractReads(roots) {
  return Object.fromEntries(roots.filter(root => root.file?.endsWith('.contract') && existsSync(root.file))
    .map(({ file }) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
}

/** Hashes of the text the compiler consumed, never a reread of moving sources. */
export function contractReadReceipt(directory) {
  const map = JSON.parse(readFileSync(resolve(directory, 'app.plan.map.json'), 'utf8'));
  return Object.fromEntries(map.sources.filter(source => !source.file.startsWith('exact:'))
    .map(source => [resolve(source.file), source.sha256]));
}

export function changedContractReads(reads) {
  return Object.entries(reads).filter(([path, expected]) => {
    try { return createHash('sha256').update(readFileSync(path)).digest('hex') !== expected; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return true; throw error; }
  }).map(([path]) => path);
}
