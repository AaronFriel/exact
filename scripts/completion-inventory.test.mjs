import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, inventory, markdown, rustFunctions } from './completion-inventory.mjs';

test('every source entry has exactly one ownership inference with evidence', () => {
  // The census reads runner/src, host/apple/src, host/web, host/web-js,
  // host/web-capabilities, host/web-geometry, host/render/src and host/painted/src.
  const result = inventory();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  for (const [host, symbol] of [
    ['runner', 'Runner::fulfill'], ['runner', 'Runner::presence_answer'],
    ['runner', 'Runner::answer_hold'], ['runner', 'Runner::set_shared'],
    ['runner', 'Runner::canvas_image'], ['runner', 'Runner::fire_native_timer'],
    ['runner', 'Runner::append_request#next_ticket:1'],
    ['runner', 'Runner::module_call#next:1'],
    ['apple', 'exact_fulfill_surface'], ['web', 'exact_fulfill'],
    ['apple', 'exact_frame_health_record'],
    ['apple', 'exact_widget_reload'],
    ['web-js', 'm_end'], ['painted', 'Presenter::pump'],
    ['painted', 'Java_dev_exact_canvas_Native_answer'], ['render', 'settle_aborts'],
  ]) {
    assert.ok(result.entries.some(e => e.host === host && e.symbol === symbol), `${host}:${symbol} missing`);
  }
  const text = markdown(result.entries);
  assert.ok(text.includes('durable when the ticket names'));
}, 60_000);

test('new runner APIs, host exports, adapters and mint sites cannot pass unclassified', () => {
  const root = mkdtempSync(join(tmpdir(), 'exact-completion-inventory-'));
  try {
    for (const dir of ['runner/src', 'host/apple/src', 'host/apple/Sources', 'host/web/src', 'host/web-js/motion/src',
      'host/web-capabilities/src', 'host/web-geometry/src', 'host/render/src', 'host/painted/src']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const file = join(root, 'runner/src/runner.rs');
    writeFileSync(file, 'impl<D> Runner<D> { pub fn known(&mut self) -> CommitReceipt { self.commit() } }');
    const table = [{ family: 'fixture', lifetime: 'fixture session', class: 'UI-owned', inference: true,
      evidence: 'fixture owns its pending completion', ids: ['runner:runner/src/runner.rs:Runner::known'] }];
    assert.deepEqual(inventory(root, table).errors, []);
    writeFileSync(file, readFileSync(file, 'utf8') + `
      impl<D: Source<Vec<Item>>> Runner<D> where D: for<'a> Source<&'a Item> {
        pub const fn new_receipt<F: Fn(u64)>(&self, f: F) -> Result<Option<CommitReceipt>, Error> { todo!() }
        pub fn new_completion(&mut self, outcome: Outcome) {
          self.next_ticket += 1;
          #[cfg(test)] { self.next_ticket += 1; }
        }
        fn other_allocator(&mut self) { self.extensions.next += 1; SERIAL.fetch_add(1, Relaxed); }
      }
    `);
    writeFileSync(join(root, 'host/apple/src/extra.rs'), `macro_rules! exports { () => {
      #[unsafe(no_mangle)] pub unsafe extern "C" fn new_apple() {}
      #[export_name = "aliased_export"] extern "C" fn internal_name() {}
    }; }`);
    writeFileSync(join(root, 'runner/src/external.rs'), `macro_rules! shared_exports { () => {
      #[no_mangle] pub extern "C" fn new_external() {}
    }; }`);
    writeFileSync(join(root, 'host/apple/src/imported.rs'), 'exact_runner::shared_exports!();');
    writeFileSync(join(root, 'host/apple/Sources/Extra.swift'), `
      // @_cdecl("comment_only")
      @_cdecl("new_swift_export") public func callback() {}
    `);
    writeFileSync(join(root, 'host/web/src/extra.rs'), '#[no_mangle] pub extern "C" fn new_web() {}');
    writeFileSync(join(root, 'host/web-js/motion/src/extra.rs'), '#[no_mangle] pub extern "C" fn new_motion() {}');
    writeFileSync(join(root, 'host/web-capabilities/src/extra.rs'), '#[no_mangle] pub extern "C" fn new_capability() {}');
    writeFileSync(join(root, 'host/render/src/extra.rs'), 'fn adapter(runner: &mut Runner<D>) { runner.new_completion(outcome); }');
    writeFileSync(join(root, 'host/painted/src/extra.rs'), `
      impl<D> CanvasHost<D> { pub fn new_reader_answer(&mut self) {} }
      impl<D> Presenter<D> { pub fn new_presenter_answer(&mut self) {} }
      #[no_mangle] pub unsafe extern "system" fn Java_new_answer() {}
    `);
    const result = inventory(root, table);
    const expected = [
      'runner:runner/src/runner.rs:Runner::new_receipt',
      'runner:runner/src/runner.rs:Runner::new_completion',
      'runner:runner/src/runner.rs:Runner::new_completion#next_ticket:1',
      'runner:runner/src/runner.rs:Runner::other_allocator#next:1',
      'runner:runner/src/runner.rs:Runner::other_allocator#SERIAL.fetch_add:1',
      'apple:host/apple/src/extra.rs:new_apple',
      'apple:host/apple/src/extra.rs:aliased_export',
      'apple:runner/src/external.rs:new_external',
      'apple:host/apple/Sources/Extra.swift:new_swift_export',
      'web:host/web/src/extra.rs:new_web',
      'web-js:host/web-js/motion/src/extra.rs:new_motion',
      'web-capabilities:host/web-capabilities/src/extra.rs:new_capability',
      'render:host/render/src/extra.rs:adapter',
      'painted:host/painted/src/extra.rs:CanvasHost::new_reader_answer',
      'painted:host/painted/src/extra.rs:Presenter::new_presenter_answer',
      'painted:host/painted/src/extra.rs:Java_new_answer',
    ];
    assert.deepEqual(result.entries.filter(e => !e.evidence).map(e => e.id).sort(), expected.sort());
    assert.equal(result.errors.length, expected.length);
    assert.ok(result.errors.every(e => e.startsWith('unclassified:')));
    assert.equal(result.entries.find(e => e.symbol === 'Runner::new_receipt').returnsReceipt, true);
    assert.ok(inventory(root, [...table, ...table]).errors.some(e => e.startsWith('classified twice:')));
    assert.ok(inventory(root, [{ ...table[0], ids: ['gone'] }]).errors.some(e => e === 'stale classification: gone'));
    assert.ok(inventory(root, [{ ...table[0], inference: false }]).errors.some(e => e.startsWith('incomplete classification:')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the lexer excludes strings, nested comments and test items without hiding following APIs', () => {
  const code = `
    // pub fn fake() -> CommitReceipt {}
    /* outer /* pub fn fake() {} */ still a comment */
    const RAW: &str = br##"pub fn fake() {}"##;
    const NORMAL: &str = "http://example/ /* fake */";
    const CHAR: char = '{';
    struct State { #[cfg(test)] calls: usize, value: u64 }
    #[cfg(test)] use crate::{Fake, Other};
    impl<D> Runner<D> {
      #[cfg(test)] pub fn test_only() {}
      pub(crate) fn internal() {}
      pub fn real<'a>(&'a self) -> CommitReceipt { todo!() }
    }
    #[cfg(test)] mod nested { impl<D> Runner<D> { pub fn fake() {} } }
    impl<D> Runner<D> { pub fn after() {} }
  `;
  const f = rustFunctions('runner/src/fixture.rs', code).functions;
  assert.deepEqual(f.filter(f => f.public).map(f => f.name), ['real', 'after']);
  assert.equal(rustFunctions('runner/src/fixture_tests.rs', code).functions.length, 0);
  assert.equal(rustFunctions('runner/src/tests/fixture.rs', code).functions.length, 0);
  assert.throws(() => rustFunctions('host/apple/src/new.rs', `
    macro_rules! new_export { ($name:ident) => { #[no_mangle] pub extern "C" fn $name() {} }; }
  `), /computed API name/);
  assert.throws(() => rustFunctions('runner/src/broken.rs', 'impl Runner<D> {'), /unclosed/);
});
