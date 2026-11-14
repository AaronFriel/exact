import {test, expect} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {encodePng} from '../png.mjs';
import {checkpoint} from './checkpoint.mjs';
import {blind, comparePixels, compareTrees, imageFacts, targetPoint, verdict} from './compare.mjs';
import {parse} from './main.mjs';

const picture = () => ({width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255])});

test('every unpaired semantic element and differing comparable field is retained', () => {
  const r = compareTrees([{identifier: 'a', label: 'Old', enabled: true}, {label: 'inside'}],
    [{identifier: 'a', label: 'New', enabled: false}, {label: 'outside'}]);
  expect(r.findings.map(f => f.kind)).toEqual(['tree-field', 'tree-field', 'inside-only', 'outside-only']);
  expect(compareTrees([{label: 'same'}], [{label: 'same'}]).joins[0].via).toBe('name-only');
  expect(compareTrees([{identifier: 'a'}], [{identifier: 'a'}, {identifier: 'a'}]).findings.some(f => f.kind === 'blind-spot')).toBe(true);
});

test('one changed pixel counts; dimensions and blank pictures cannot be blessed', () => {
  const a = picture(), b = picture();
  b.data[0] = 1;
  expect(comparePixels(a, b, 'test')[0]).toMatchObject({changed: 1, bounds: [0, 0, 1, 1]});
  expect(comparePixels(a, a, 'test')).toEqual([]);
  expect(verdict(comparePixels(a, {...b, width: 1}, 'test'))).toBe('inconclusive');
  expect(imageFacts({...a, data: new Uint8Array(8)}).uniform).toBe(true);
  expect(verdict([blind('test', 'permission denied')])).toBe('inconclusive');
});

test('outside aiming never falls back to model coordinates', () => {
  expect(() => targetPoint({elements: []}, 'button', {nodes: [{props: {testId: 'button'}, frame: [0, 0, 10, 10]}]})).toThrow('0 matches');
  const tree = {elements: [{identifier: 'button', frame: [10, 20, 30, 40]}]};
  expect(targetPoint(tree, 'button', {}).point).toEqual([25, 40]);
  expect(() => targetPoint({elements: [...tree.elements, ...tree.elements]}, 'button', {})).toThrow('2 matches');
});

test('checkpoint keeps independent evidence and fails closed on motion, blank capture and permission denial', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'see-test-'));
  try {
    let reads = 0;
    const session = {host: 'macos', clock: async () => ({settled: true}),
      tree: async () => ({nodes: [{id: 1, props: {testId: 'button', text: 'OK'}}]}),
      state: async () => ({slots: {revision: reads++}}),
      screenshot: async path => { writeFileSync(path, encodePng(picture())); return {screenshot: path}; }};
    const observer = {identity: {pid: 12},
      tree: async () => ({elements: [{identifier: 'button', label: 'OK'}]}),
      capture: async path => { writeFileSync(path, encodePng({...picture(), data: new Uint8Array(8)})); return {path}; }};
    const r = await checkpoint(session, observer, resolve(dir, 'moving'));
    expect(r.report.status).toBe('inconclusive');
    expect(r.report.findings.some(f => f.source === 'driver/state')).toBe(true);
    expect(r.report.findings.filter(f => f.reason?.includes('uniform')).length).toBe(2);
    observer.tree = async () => { throw new Error('AX denied'); };
    const denied = await checkpoint(session, observer, resolve(dir, 'denied'));
    expect(denied.report.findings.filter(f => f.reason?.includes('AX denied')).length).toBe(2);
    expect(JSON.parse(readFileSync(resolve(dir, 'denied/outside-before.json'))).error).toBe('AX denied');
    expect(denied.model.nodes).toHaveLength(1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('CLI rejects unknown flags, missing simulator and invalid gestures', () => {
  expect(parse(['--help']).help).toBe(true);
  expect(() => parse(['ios', '--app', 'shelf', '--out', 'x'])).toThrow('--sim');
  expect(() => parse(['macos', '--app', 'shelf', '--out', 'x', '--typo'])).toThrow('unknown');
  expect(() => parse(['macos', '--app', 'shelf', '--out', 'x', '--drag', 'row', '0', '0', '300'])).toThrow('nonzero');
});

test('removal inventory contains every experiment file and every outside hook', () => {
  const root = resolve(import.meta.dir, '../..');
  const removal = readFileSync(resolve(import.meta.dir, 'REMOVING.md'), 'utf8');
  const listed = [...removal.matchAll(/^- `(scripts\/see\/[^`]+)`/gm)].map(m => m[1]).sort();
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts/see'], {cwd: root, encoding: 'utf8'});
  expect(git.status).toBe(0);
  expect([...new Set(git.stdout.trim().split('\n'))].sort()).toEqual(listed);
  const tracked = spawnSync('git', ['grep', '-l', '-E', 'see: removable|[./]see/', '--', ':!scripts/see', ':!llp'], {cwd: root, encoding: 'utf8'});
  expect(tracked.stdout.trim().split('\n')).toEqual(['scripts/exact.mjs']);
  expect(removal).toContain('`scripts/exact.mjs`');
  const entry = readFileSync(resolve(root, 'scripts/exact.mjs'), 'utf8');
  const hook = entry.match(/\/\/ see: removable \(LLP 1172\.021\)\nif \(import\.meta\.main && process\.argv\[2\] === 'see'\) \{\n  process\.exit\(spawnSync[^\n]+\n\}/g);
  expect(hook).toHaveLength(1);
});
