import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { categories, census, ceilingFor, check, compare } from './seam-ratchets.mjs';
import { gateParts } from './gate.mjs';
import { seamCensus } from './probes/seamcensus.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'exact-seam-ratchets-'));
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  for (const [file, owner] of [
    ['ExactKit/IOS/NodeViewIOS.swift', 'NodeView'], ['ExactKit/Mac/NodeViewMac.swift', 'NodeView'],
    ['ExactKit/IOS/PresenterIOS.swift', 'Presenter'], ['ExactKit/Mac/PresenterMac.swift', 'Presenter'],
    ['ExactCore/Bridge.swift', 'Runtime'],
  ]) write(`host/apple/Sources/${file}`, `class ${owner} {}`);
  write('runner/src/runner.rs', 'impl<D> Runner<D> {}');
  write('host/apple/src/lib.rs', '');
  const save = () => write('scripts/seam-ceilings.json', JSON.stringify(ceilingFor(census(root), 'fixture')));
  try { run({ root, write, save }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const path = 'host/apple/Sources/ExactKit/Casts.swift';
const original = 'func old(_ view: Any) { let node = view as? NodeView }';

test('an added cast fails, names its site, and passes after removing it', () => fixture(({ root, write, save }) => {
  write(path, original); save();
  write(path, original + '\nfunc added(_ view: Any) { let node = view as! NodeView }');
  const lines = [];
  expect(check({ root, report: line => lines.push(line) })).toBe(1);
  expect(lines.join('\n')).toContain('nodeViewCasts: 2 / 1; GREW by 1');
  expect(lines.join('\n')).toContain(`new: ${path}:2: view as! NodeView`);
  write(path, original);
  expect(check({ root, report: () => {} })).toBe(0);
}));

test('a cast at file scope cannot escape the count', () => fixture(({ root, write, save }) => {
  save();
  write(path, 'let node = view as? NodeView');
  expect(check({ root, report: () => {} })).toBe(1);
  expect(census(root).nodeViewCasts).toHaveLength(1);
}));

test('a fall requires lowering in the same commit, and --lower cannot raise any ceiling', () => fixture(({ root, write, save }) => {
  write(path, original); save();
  write(path, '');
  const lines = [];
  expect(check({ root, report: s => lines.push(s) })).toBe(1);
  expect(lines.join('\n')).toContain('fell by 1');
  expect(lines.join('\n')).toContain('bun scripts/seam-ratchets.mjs --lower');
  expect(check({ root, lower: true, report: () => {} })).toBe(0);
  expect(check({ root, report: () => {} })).toBe(0);
  const saved = readFileSync(join(root, 'scripts/seam-ceilings.json'), 'utf8');
  write(path, original);
  expect(check({ root, lower: true, report: () => {} })).toBe(1);
  expect(readFileSync(join(root, 'scripts/seam-ceilings.json'), 'utf8')).toBe(saved);
}));

test('all five counts grow independently; comments, literals, visibility and nested signatures are parsed', () => fixture(({ root, write, save }) => {
  save();
  write(path, `
    /* /* nested */ as? NodeView .superview */
    let text = #"as! NodeView .superview"#
    func walk(_ view: Any) {
      let parent = view.superview
      let node = parent as? NodeView
      let children = node?.subviews
    }
    func ignored() { print("as? NodeView") }
  `);
  write('host/apple/Sources/ExactCore/Bridge.swift', `class Runtime {
    func result(
      _ callback: (Int) -> Void
    ) -> (Int, String) { (1, "") }
    private func hidden() -> Int { 0 }
    func later() async -> Int { 0 }
    func void() -> Void {}
    func unit() -> () {}
    func callback(_ done: (Int) -> Void) {}
  }`);
  write('runner/src/runner.rs', `
    // pub fn decoy() -> CommitReceipt {}
    impl<D> Runner<D> {
      pub fn result<F: Fn(u64)>(&self, f: F) -> Result<Option<CommitReceipt>, Error> { todo!() }
      pub fn aggregate(&self) -> Advanced { todo!() }
      pub(crate) fn hidden(&self) -> CommitReceipt { todo!() }
      fn private(&self) -> CommitReceipt { todo!() }
      #[cfg(test)] pub fn test_only() -> CommitReceipt { todo!() }
    }
    impl Other { pub fn result() -> CommitReceipt { todo!() } }
    macro_rules! exported { () => {
      #[unsafe(no_mangle)] pub extern "C" fn shared() {}
    }; }
  `);
  write('host/apple/src/lib.rs', `
    exact_runner::exported!();
    #[no_mangle] pub extern "C" fn new_export() {}
    #[export_name = "renamed"] extern "C" fn internal() {}
    pub extern "C" fn mangled() {}
    const TEXT: &str = r#"#[no_mangle] pub extern "C" fn fake() {}"#;
    #[cfg(test)] mod tests { #[no_mangle] pub extern "C" fn test_only() {} }
  `);
  const sites = census(root);
  expect(Object.fromEntries(categories.map(k => [k, sites[k].length]))).toEqual({
    nodeViewCasts: 1, treeWalks: 2, synchronousBridgeReturns: 1, runnerReceiptMethods: 2, appleAbiExports: 3,
  });
  const lines = [];
  expect(check({ root, report: s => lines.push(s) })).toBe(1);
  expect(lines.filter(s => s.includes('GREW'))).toHaveLength(5);
}));

test('site matching survives shifted lines and names a duplicate cast added on the same line', () => fixture(({ root, write, save }) => {
  write(path, original); save();
  write(path, '\n\n' + original);
  expect(check({ root, report: () => {} })).toBe(0);
  write(path, original.replace(' }', '; let other = view as? NodeView }'));
  const lines = [];
  expect(check({ root, report: s => lines.push(s) })).toBe(1);
  expect(lines.filter(s => s.includes('new:'))).toHaveLength(1);
}));

test('invalid ceilings fail closed and a decrease never hides growth in another count', () => {
  const empty = Object.fromEntries(categories.map(k => [k, []]));
  const saved = ceilingFor(empty, 'fixture');
  saved.counts.nodeViewCasts = { ceiling: 1, sites: ['old'] };
  const sites = { ...empty, appleAbiExports: [{ id: 'new', path: 'new.rs', line: 1, text: 'export' }] };
  const result = compare(sites, saved);
  expect(result.grown).toEqual(['appleAbiExports']);
  expect(result.fallen).toEqual(['nodeViewCasts']);
  delete saved.counts.treeWalks;
  expect(compare(empty, saved).grown).toEqual(['treeWalks']);
});

test('bridge closures return values even when their result is Void or unit', () => fixture(({ root, write, save }) => {
  save();
  write('host/apple/Sources/ExactCore/Bridge.swift', `final class Runtime {
    func asyncCallback() -> (Int) async -> Void { { _ in } }
    func callback() -> (Int) -> Void { { _ in } }
    func unitCallback() -> () -> () { {} }
    func constrained<T>() -> (T) -> Void where T: Equatable { { _ in } }
    func void() -> Void {}
    func unit() -> () {}
    func constrainedVoid<T>(_ value: T) -> Void where T: Equatable {}
    func later() async -> (Int) -> Void { { _ in } }
  }`);
  expect(census(root).synchronousBridgeReturns.map(s => s.text)).toEqual([
    'func asyncCallback ( ) -> ( Int ) async -> Void',
    'func callback ( ) -> ( Int ) -> Void',
    'func constrained < T > ( ) -> ( T ) -> Void where T : Equatable',
    'func unitCallback ( ) -> ( ) -> ( )',
  ]);
  expect(check({ root, report: () => {} })).toBe(1);
}));

test('static bridge methods count while static stored model properties stay excluded', () => fixture(({ root, write, save }) => {
  save();
  write('host/apple/Sources/ExactCore/Bridge.swift', `final class Runtime {
    package static func extra() -> Batch { fatalError() }
    private static func hidden() -> Batch { fatalError() }
    static func void() -> Void {}
  }`);
  write('host/apple/Sources/ExactKit/IOS/NodeViewIOS.swift', `class NodeView {
    static let shared = 1
    let model = 2
  }`);
  expect(census(root).synchronousBridgeReturns.map(s => s.text)).toEqual(['func extra ( ) -> Batch']);
  expect(seamCensus({ root: join(root, 'host/apple'), countsOnly: true }).inventory
    .filter(s => s.owner === 'NodeView').flatMap(s => s.names)).toEqual(['model']);
  expect(check({ root, report: () => {} })).toBe(1);
}));

test('receipt constraints do not turn a unit or unrelated return into a receipt', () => fixture(({ root, write, save }) => {
  save();
  write('runner/src/runner.rs', `impl<D> Runner<D> {
    pub fn observe<F>(&self, f: F) where F: FnOnce(CommitReceipt) {}
    pub fn explicit_unit<F>(&self, f: F) -> () where F: FnOnce(Advanced) {}
    pub fn unrelated<F>(&self, f: F) -> bool where F: FnOnce(Dispatched) { true }
  }`);
  expect(census(root).runnerReceiptMethods).toHaveLength(0);
  expect(check({ root, report: () => {} })).toBe(0);
  write('runner/src/extra.rs', `impl<D> Runner<D> {
    pub fn receipt<F>(&self, f: F) -> Result<CommitReceipt, E> where F: FnOnce() { todo!() }
  }`);
  expect(census(root).runnerReceiptMethods.map(s => s.text)).toEqual(['Runner::receipt']);
  expect(check({ root, report: () => {} })).toBe(1);
}));

test('Swift ABI exports count in Sources and optional arms, excluding comments, strings and tests', () => fixture(({ root, write, save }) => {
  save();
  write('host/apple/webarm/WebArm.swift', `
    // @_cdecl("comment") func fake() {}
    let text = "@_cdecl(\\"literal\\") func fake() {}"
    @_cdecl("exact_new_export") public func callback() {}
  `);
  write('host/apple/modules/Module.swift', '@_cdecl("exact_module") public func callback() {}');
  write('host/apple/Sources/Widget.swift', '@_cdecl("exact_widget") public func callback() {}');
  write('host/apple/tests/Fixture.swift', '@_cdecl("test_only") public func callback() {}');
  expect(census(root).appleAbiExports.map(s => s.text).sort()).toEqual([
    'exact_module', 'exact_new_export', 'exact_widget',
  ]);
  const lines = [];
  expect(check({ root, report: s => lines.push(s) })).toBe(1);
  expect(lines.join('\n')).toContain('exact_new_export');
}));

test('probe deltas are informational and survive lowering the enforcement ceilings', () => fixture(({ root, write, save }) => {
  write(path, original); save();
  const file = 'scripts/seam-ceilings.json';
  const saved = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const probe = { commit: 'probe-commit', counts: Object.fromEntries(categories.map(k => [k, 0])) };
  write(file, JSON.stringify({ ...saved, probe }));
  const lines = [];
  expect(check({ root, report: s => lines.push(s) })).toBe(0);
  expect(lines.join('\n')).toContain('probe-commit');
  expect(lines.join('\n')).toContain('nodeViewCasts: 1 / 1; vs probe 0: +1');
  write(path, '');
  expect(check({ root, lower: true, report: () => {} })).toBe(0);
  expect(JSON.parse(readFileSync(join(root, file), 'utf8')).probe).toEqual(probe);
}));

test('the blocking gate runs the census and these tests', () => {
  expect(gateParts.some(p => p[2].includes('scripts/seam-ratchets.mjs'))).toBe(true);
  expect(gateParts.find(p => p[0] === 'scripts')[2]).toContain('./scripts/seam-ratchets.test.mjs');
});
