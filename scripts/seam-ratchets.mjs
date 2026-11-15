#!/usr/bin/env bun
// LLP 1172.019 §2. Source definitions, including inactive platform branches.
// Swift uses the probe's lexical scopes: conditional/forced NodeView casts and
// superview/subviews edges in members containing a cast or type test. It misses
// string interpolations, generated sources outside Sources, aliases of NodeView,
// interprocedural/custom ancestor helpers and dynamic dispatch; regex literals
// can confuse it. Bridge returns cover explicit non-Void Runtime declarations in
// ExactCore/Bridge.swift only, not inferred returns or Runtime extensions elsewhere.
// Rust uses the inventory's structural parser, not macro expansion or type checking.
// Receipt aliases beyond CommitReceipt/Advanced/Dispatched/Timed can escape. Count
// Apple C ABI source exports (Rust, Swift @_cdecl and imported runner macros) once per definition;
// generated exports without source definitions, linker aliases and cfg_attr exports
// can escape. A macro with a computed API name is refused by the Rust parser.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { seamCensus } from './probes/seamcensus.mjs';
import { rustFunctions, swiftCExports } from './completion-inventory.mjs';

const ROOT = resolve(import.meta.dir, '..');
const CEILINGS = 'scripts/seam-ceilings.json';
export const categories = ['nodeViewCasts', 'treeWalks', 'synchronousBridgeReturns', 'runnerReceiptMethods', 'appleAbiExports'];

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => e.isDirectory() && !['tests', 'fixtures'].includes(e.name) ? rustFiles(join(dir, e.name))
      : e.isFile() && e.name.endsWith('.rs') ? [join(dir, e.name)] : []);
}

export function census(root = ROOT) {
  const swift = seamCensus({ root: join(root, 'host/apple'), countsOnly: true });
  const sites = Object.fromEntries(categories.map(k => [k, []]));
  const sources = new Map();
  function swiftSite(row, text) {
    const path = relative(root, row.path);
    if (!sources.has(path)) sources.set(path, readFileSync(row.path, 'utf8').split('\n'));
    text ??= sources.get(path)[row.line - 1].trim();
    return { id: `${path}: ${text.replace(/\s+/g, ' ')}`, path, line: row.line, text };
  }
  sites.nodeViewCasts = swift.casts.map(r => swiftSite(r, r.expression));
  sites.treeWalks = swift.walks.map(r => swiftSite(r));
  sites.synchronousBridgeReturns = swift.inventory.filter(r => r.owner === 'Runtime' && !r.async)
    .map(r => swiftSite(r, r.header));
  const runner = rustFiles(join(root, 'runner/src')).flatMap(path => {
    const file = relative(root, path);
    const source = readFileSync(path, 'utf8');
    return /Runner|macro_rules/.test(source) ? [{ file, ...rustFunctions(file, source) }] : [];
  });
  function rustSite(f) {
    const text = `${f.owner ? f.owner + '::' : ''}${f.exportName ?? f.name}`;
    return { id: `${f.file}: ${text}`, path: f.file, line: f.line, text };
  }
  sites.runnerReceiptMethods = runner.flatMap(r => r.functions)
    .filter(f => f.owner === 'Runner' && f.public && /\b(?:CommitReceipt|Advanced|Dispatched|Timed)\b/.test(f.returnType))
    .map(rustSite);
  const imported = runner.flatMap(r => r.macros.map(m => ({ ...m,
    functions: r.functions.filter(f => f.cExport && m.start < f.start && f.end < m.end),
  }))).filter(m => m.functions.length);
  const seen = new Set();
  for (const path of rustFiles(join(root, 'host/apple/src'))) {
    const file = relative(root, path), source = readFileSync(path, 'utf8');
    if (!/no_mangle|export_name/.test(source) && !imported.some(m => source.includes(m.name))) continue;
    const { functions, t } = rustFunctions(file, source);
    sites.appleAbiExports.push(...functions.filter(f => f.cExport).map(rustSite));
    for (const m of imported) {
      if (seen.has(m.name) || !t.some((v, i) => v.value === m.name && t[i + 1]?.value === '!')) continue;
      seen.add(m.name);
      sites.appleAbiExports.push(...m.functions.map(rustSite));
    }
  }
  sites.appleAbiExports.push(...swiftCExports(root).map(rustSite));
  for (const k of categories) sites[k].sort((a, b) => a.id.localeCompare(b.id) || a.line - b.line);
  return sites;
}

export function ceilingFor(sites, baseline, probe) {
  return { baseline, ...(probe ? { probe } : {}), counts: Object.fromEntries(categories.map(k => [k,
    { ceiling: sites[k].length, sites: sites[k].map(s => s.id) }])) };
}

export function compare(sites, ceiling) {
  const lines = [], grown = [], fallen = [];
  if (ceiling.probe) lines.push(`Probe ${ceiling.probe.commit}: informational comparison only.`);
  for (const k of categories) {
    const saved = ceiling.counts?.[k];
    if (!saved || !Number.isInteger(saved.ceiling) || saved.ceiling < 0 ||
        !Array.isArray(saved.sites) || saved.sites.length !== saved.ceiling || saved.sites.some(s => typeof s !== 'string')) {
      lines.push(`${k}: invalid or missing ceiling and site inventory`); grown.push(k); continue;
    }
    const count = sites[k].length, delta = count - saved.ceiling;
    const probe = ceiling.probe?.counts?.[k], probeDelta = count - probe;
    const info = Number.isInteger(probe) && probe >= 0 ? `; vs probe ${probe}: ${probeDelta >= 0 ? '+' : ''}${probeDelta}` : '';
    lines.push(`${k}: ${count} / ${saved.ceiling}${delta > 0 ? `; GREW by ${delta}` : delta < 0 ? `; fell by ${-delta}` : ''}${info}`);
    if (delta > 0) {
      grown.push(k);
      const remaining = new Map();
      for (const id of saved.sites) remaining.set(id, (remaining.get(id) ?? 0) + 1);
      for (const site of sites[k]) {
        const left = remaining.get(site.id) ?? 0;
        if (left) remaining.set(site.id, left - 1);
        else lines.push(`  new: ${site.path}:${site.line}: ${site.text}`);
      }
    }
    if (delta < 0) fallen.push(k);
  }
  if (fallen.length) lines.push('Lower the ceilings in the same commit: bun scripts/seam-ratchets.mjs --lower');
  return { lines, grown, fallen, status: grown.length || fallen.length ? 1 : 0 };
}

export function check({ root = ROOT, lower = false, report = console.log } = {}) {
  const path = join(root, CEILINGS), ceiling = JSON.parse(readFileSync(path, 'utf8'));
  const sites = census(root), result = compare(sites, ceiling);
  result.lines.forEach(line => report(line));
  if (lower && !result.grown.length && result.fallen.length) {
    writeFileSync(path, JSON.stringify(ceilingFor(sites, ceiling.baseline, ceiling.probe), null, 2) + '\n');
    report(`Lowered ${result.fallen.join(', ')} in ${CEILINGS}; commit it with the source change.`);
    return 0;
  }
  return result.status;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('bun scripts/seam-ratchets.mjs [--lower]\nFails on growth or an unlowered ceiling. --lower only writes when no count has grown.');
  else if (args.some(a => a !== '--lower')) { console.error('Unknown option; use --help'); process.exitCode = 1; }
  else {
    try { process.exitCode = check({ lower: args.includes('--lower') }); }
    catch (error) { console.error(`seam ratchets: ${error.message}`); process.exitCode = 1; }
  }
}
