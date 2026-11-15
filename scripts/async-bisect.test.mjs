import { expect, test } from 'bun:test';
import { bisectAffected, bisectFailures, probeOutcomes } from './async-bisect.mjs';

test('an hourly range finds separate breaking commits and shares probes', async () => {
  const calls = [], commits = Array.from({ length: 17 }, (_, i) => String(i));
  const result = await bisectFailures(commits, ['test: a', 'glue: b'], async sha => {
    calls.push(sha);
    return { 'test: a': Number(sha) >= 3 ? 'fail' : 'pass', 'glue: b': Number(sha) >= 13 ? 'fail' : 'pass' };
  });
  expect(result).toEqual({ 'test: a': { commit: '3', parent: '2' }, 'glue: b': { commit: '13', parent: '12' } });
  expect(new Set(calls).size).toBe(calls.length);
  expect(calls.length).toBeLessThan(12);
});

test('an old failure and an obstructed probe are never blamed on a commit', async () => {
  const result = await bisectFailures(['base', 'middle', 'tip'], ['old', 'blocked'], async sha => ({ old: 'fail', blocked: sha === 'base' ? 'pass' : sha === 'tip' ? 'fail' : 'unknown' }));
  expect(result.old).toEqual({ preexisting: 'base' });
  expect(result.blocked).toEqual({ unresolved: 'probe did not finish at middle', good: 'base', bad: 'tip' });
  expect((await bisectFailures(['base', 'tip'], ['x'], async () => ({ x: 'unknown' }))).x.commit).toBeUndefined();
});

test('only a finished probe can clear a failure; a failure it found still counts when another binary stopped', () => {
  const wanted = ['test: a', 'test: b', 'fmt: c', 'glue: d'];
  expect(probeOutcomes({ failures: ['test: a'], checks: { test: { complete: false }, fmt: { complete: true, status: 0 }, glue: { skipped: 'cached', complete: true } } }, wanted))
    .toEqual({ 'test: a': 'fail', 'test: b': 'unknown', 'fmt: c': 'pass', 'glue: d': 'unknown' });
  expect(probeOutcomes({ failures: [], checks: { test: { complete: true, status: 1 } } }, ['test: absent'])).toEqual({ 'test: absent': 'unknown' });
});

import { failureSelection, nothing, probeSteps, extraChecks, covers, failureAffected } from './async.mjs';
test('bisection runs the failing affected suites and their prerequisite builds', () => {
  const selection = { ...nothing(), full: true, cargo: ['one', 'two'], glue: ['./a.test.mjs', './b.test.mjs'], ios: true };
  const wanted = ['test: -p one --lib fails', 'glue: bad', 'ios: ExactKitTests.ATests bad failed'];
  const owners = { [wanted[0]]: ['cargo:one'], [wanted[1]]: ['bun:a.test.mjs'], [wanted[2]]: ['xctest:ios:ATests'] };
  const narrowed = failureSelection(selection, wanted, owners);
  expect(narrowed.cargo).toEqual(['one']);
  expect(narrowed.glue).toEqual(['./a.test.mjs']);
  expect(narrowed.iosOnly).toEqual(['ATests']);
  expect([...probeSteps(wanted)].sort()).toEqual(['glue', 'ios', 'prepare', 'test']);
});

test('affected suites outside glue, including macOS XCTest and app tests, have hourly commands', () => {
  const steps = extraChecks([
    { suite: { kind: 'bun', file: 'scripts/in-glue.test.mjs' } },
    { suite: { kind: 'bun', file: 'packages/p/test/other.test.mjs' } },
    { suite: { kind: 'xctest', host: 'macos' }, only: ['A'] },
    { suite: { kind: 'app', app: 'fixture', host: 'web', files: ['apps/fixture/screen.test.contract'] } },
  ], ['./scripts/in-glue.test.mjs']);
  expect(steps.map(s => s[0])).toEqual(['other-glue', 'macos', 'build-app:fixture:web', 'app:fixture:web:0']);
  expect(steps[0][2]).toEqual(['EXACT_REQUIRED=1', 'bun', 'test', '--isolate', './packages/p/test/other.test.mjs']);
  expect(steps[1][2]).toEqual(['host/apple/build.mjs', '--test', '--only', 'A']);
});

test('a full hourly run never claims default-member tests covered other workspace packages', () => {
  expect(covers('default-test', { full: true, defaultCargo: ['one'] })).toEqual(['cargo:one']);
});

test('attribution excludes unrelated commits and preserves unknown coverage', () => {
  const known = new Set(['cargo:one', 'xctest:ios']), untouched = { ...nothing(), ids: [] };
  expect(failureAffected(untouched, ['cargo:one'], known, 'default-test')).toBe(false);
  expect(failureAffected(untouched, ['cargo:unknown'], known, 'default-test')).toBe(true);
  expect(failureAffected(untouched, [], known, 'ios')).toBe(false);
  expect(failureAffected({ ...untouched, ids: ['cargo:one'] }, ['cargo:one'], known, 'default-test')).toBe(true);
  const classes = { ...untouched, ids: ['xctest:ios'], ios: true, iosOnly: ['BTests'] };
  expect(failureAffected(classes, ['xctest:ios:ATests'], known, 'ios')).toBe(false);
  expect(failureAffected(classes, ['xctest:ios:BTests'], known, 'ios')).toBe(true);
});

test('a pruned range confirms the real parent, and refuses a missed input or an unrelated failure', async () => {
  const commits = ['0', '1', '2', '3', '4'], calls = [];
  const candidates = new Map([['a', ['2']], ['missed', ['3']], ['unrelated', []]]);
  const result = await bisectAffected('0', '4', [...candidates.keys()], candidates, async sha => {
    calls.push(sha);
    return { a: Number(sha) >= 2 ? 'fail' : 'pass', missed: Number(sha) >= 2 ? 'fail' : 'pass' };
  }, sha => commits[Number(sha) - 1]);
  expect(result.a).toEqual({ commit: '2', parent: '1' });
  expect(result.missed.commit).toBeUndefined();
  expect(result.missed.unresolved).toContain('actual parent');
  expect(result.unrelated.commit).toBeUndefined();
  expect(new Set(calls).size).toBe(calls.length);
});
