import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { categories, census, ceilingFor, check, compare } from './seam-ratchets.mjs';
import { gateParts } from './gate.mjs';

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

test('the blocking gate runs the census and these tests', () => {
  expect(gateParts.some(p => p[2].includes('scripts/seam-ratchets.mjs'))).toBe(true);
  expect(gateParts.find(p => p[0] === 'scripts')[2]).toContain('./scripts/seam-ratchets.test.mjs');
});
