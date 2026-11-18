// The web JS target's store. Run alone, `bun test ./host/web-js/store.test.js`: reorder.test.js mocks rt.js for its process.
import { test, expect, mock } from "bun:test";

// The build copies navigation.js and prompt-glue.js in from host/web and writes names.js.
mock.module("./navigation.js", () => import("../web/navigation.js"));
mock.module("./prompt-glue.js", () => ({}));
mock.module("./alert-message.js", () => ({}));
mock.module("./menu-rows.js", () => ({}));
mock.module("./names.js", () => ({ sourceTypes: {} }));
const { Store } = await import("./rt.js");
const { createSecretFacade } = await import("./admission.js");

test("a render's store refuses writes before changing memory or scheduling readers", () => {
  const saved = ['__exactRender', 'queueMicrotask', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const before = Store.save();
  let queued = 0, loaded = 0;
  globalThis.__exactRender = true;
  globalThis.queueMicrotask = () => queued++;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { loaded++; return 0; } } });
  Store.map = new Map(); Store.writes = []; Store.dirty = false;
  try {
    for (const value of ['kept', null]) {
      expect(() => Store.set('token', value)).toThrow("a render's store is empty and refuses writes");
      expect(Store.get('token')).toBeUndefined();
      expect([...Store.map]).toEqual([]);
      expect(Store.writes).toEqual([]);
      expect(Store.dirty).toBe(false);
      expect(queued).toBe(0);
    }
    Store.load();
    expect(loaded).toBe(0);
    Store.map.set('token', 'private');
    expect(Store.get('token')).toBeUndefined();
    expect(() => Store.set('token', 'private')).toThrow("a render's store is empty and refuses writes");
    expect([...Store.map]).toEqual([['token', 'private']]);
    expect(queued).toBe(0);
  } finally {
    Store.restore(before);
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

// As the runner's `Store::set`.
test("keeping what is already kept is no write", () => {
  Store.map = new Map([["token", "same"]]);
  Store.writes = [];
  Store.dirty = false;
  Store.set("token", "same");
  expect(Store.writes).toEqual([]);
  expect(Store.dirty).toBe(false);
  Store.set("token", "new");
  expect(Store.writes).toEqual([["token", "new"]]);
  Store.set("token", null);
  expect(Store.writes.at(-1)).toEqual(["token", null]);
  expect(Store.get("token")).toBeUndefined();
});

test("a shared-store lock reads another realm's committed value before writing", async () => {
  const { exclusiveSecret } = await import('../web/storage-environment.js');
  const saved = ['navigator', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const disk = new Map([['test.token', 'new']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v), removeItem: k => disk.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, work) => work() } } });
  const store = { map: new Map([['token', 'stale']]), pending: new Map(), persist() {} };
  try {
    expect(await exclusiveSecret(store, 'test.', 'token', async () => store.map.get('token'))).toBe('new');
    store.pending.set('token', {});
    expect(await exclusiveSecret(store, 'test.', 'token', async () => store.map.get('token'))).toBe('new');
    expect(store.pending.size).toBe(0);
    await expect(exclusiveSecret(store, 'test.', 'token', async () => { store.pending.set('token', {}); })).rejects.toThrow('persisted');
    expect(store.pending.size).toBe(0);
    expect(disk.has('test.token')).toBe(false);
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});


test("failed secret writes cannot overwrite a later realm's rotation", async () => {
  const { exclusiveSecret } = await import('../web/storage-environment.js');
  const saved = ['navigator', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const disk = new Map([['exact.secret.token', 'old']]); let fail = true;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => disk.get(k) ?? null,
    setItem: (k, v) => { if (fail) throw new Error('quota'); disk.set(k, v); }, removeItem: k => disk.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, work) => work() } } });
  Store.map = new Map([['token', 'old']]); Store.writes = []; Store.pending.clear();
  try {
    Store.writes.push(['token', 'ordinary-stale']); Store.persist();
    disk.set('exact.secret.token', 'another-realm'); fail = false; await Store.persist();
    expect(disk.get('exact.secret.token')).toBe('another-realm');
    await expect(exclusiveSecret(Store, 'exact.secret.', 'token', async () => { fail = true; Store.writes.push(['token', 'rotated-A']); })).rejects.toThrow('persisted');
    expect(Store.pending.size).toBe(0);
    disk.set('exact.secret.token', 'rotated-B'); disk.delete('exact.exclusive.exact.secret.token'); fail = false; Store.persist();
    expect(disk.get('exact.secret.token')).toBe('rotated-B');
    Store.writes.push(['token', 'queued-before-lease']);
    expect(await exclusiveSecret(Store, 'exact.secret.', 'token', async () => Store.get('token'))).toBe('rotated-B');
    expect(disk.get('exact.secret.token')).toBe('rotated-B');
  } finally {
    Store.writes = []; Store.pending.clear();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});


test("a new secret owner invalidates a credential left by an interrupted update", async () => {
  const { exclusiveSecret } = await import('../web/storage-environment.js');
  const saved = ['navigator', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const disk = new Map([['test.token', 'spent'], ['exact.exclusive.test.token', '1']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v), removeItem: k => disk.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, work) => work() } } });
  const store = { map: new Map([['token', 'spent']]), pending: new Map(), persist() {} };
  try {
    expect(await exclusiveSecret(store, 'test.', 'token', async () => store.map.get('token'))).toBeUndefined();
    expect(disk.size).toBe(0);
    disk.set('test.token', 'current');
    await expect(exclusiveSecret(store, 'test.', 'token', async arm => { arm(); throw new Error('interrupted'); })).rejects.toThrow('interrupted');
    expect(disk.size).toBe(0);
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

// LLP 1146 D5, as on every host: recovery is armed by a lease's first write or request with effects, and only an
// armed lease that fails loses the secret.
test("a secret lease is armed by its first write, and a failed lease that never armed keeps the secret", async () => {
  const { exclusiveSecret } = await import('../web/storage-environment.js');
  const saved = ['navigator', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const disk = new Map([['exact.secret.token', 'old']]), marker = 'exact.exclusive.exact.secret.token';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v), removeItem: k => disk.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, work) => work() } } });
  Store.map = new Map(); Store.writes = []; Store.pending.clear();
  try {
    await expect(exclusiveSecret(Store, 'exact.secret.', 'token', async () => {
      Store.set('token', 'old'); // keeping what it holds is no write
      expect(disk.has(marker)).toBe(false);
      throw new Error('before any write');
    })).rejects.toThrow('before any write');
    expect([...disk]).toEqual([['exact.secret.token', 'old']]);
    await expect(exclusiveSecret(Store, 'exact.secret.', 'absent', async () => {
      Store.set('absent', null); // nor is forgetting what it does not hold
      expect(disk.has('exact.exclusive.exact.secret.absent')).toBe(false);
      throw new Error('forgot nothing');
    })).rejects.toThrow('forgot nothing');
    await expect(exclusiveSecret(Store, 'exact.secret.', 'token', async () => {
      Store.set('token', 'partial');
      expect(disk.get(marker)).toBe('1');
      throw new Error('after a write');
    })).rejects.toThrow('after a write');
    expect([...disk]).toEqual([]);
  } finally {
    Store.map = new Map(); Store.writes = []; Store.pending.clear();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

// One lease at a time in an answer (LLP 1146 D5): a lease asked for inside another is refused, where one Web Lock
// would wait for the other forever, and another answer's waits its turn.
test("an answer's lease inside its own is refused, and another answer's waits for it", async () => {
  const { exclusiveSecret } = await import('../web/storage-environment.js');
  const saved = ['navigator', 'localStorage', '__exact_async_context'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const disk = new Map([['exact.secret.token', 'old']]), held = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v), removeItem: k => disk.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (name, work) => {
    const run = (held.get(name) ?? Promise.resolve()).then(() => work());
    held.set(name, run.catch(() => {}));
    return run;
  } } } });
  let current = null, reaction = null;
  class Owned extends Promise {}
  globalThis.__exact_async_context = { Promise: Owned, current: () => [current, null, '', null, reaction], swap(to) { const before = [current, null, '', null, reaction]; current = to[0]; reaction = to[4]; return before; } };
  const store = createSecretFacade({ get: k => Store.get(k), set: (k, v) => Store.set(k, v), exclusive: (k, work) => exclusiveSecret(Store, 'exact.secret.', k, work) },
    { version: 1, entries: [[1, "secret.keep token", ["secret-keep", "token"], null]], error: null, seal: "b22a759eedfe6bc2" }, () => null);
  const as = (call, run) => { const before = current; current = call; try { return run(); } finally { current = before; } };
  Store.map = new Map(); Store.writes = []; Store.pending.clear();
  try {
    const a = {}, b = {};
    let inner, other;
    let reacted;
    const first = as(a, () => store.exclusive('token', () => {
      inner = store.exclusive('token', async () => 'inner ran');
      // A promise reaction's answer, as ts-fetch.js's AnswerPromise makes it current
      reacted = (() => { const before = current; current = null; reaction = a; try { return store.exclusive('token', async () => 'reaction ran'); } finally { current = before; reaction = null; } })();
      other = as(b, () => store.exclusive('token', async () => store.get('token')));
      store.set('token', 'first');
      return 'first';
    }));
    // What follows a lease is still its answer's: the lease answers the answer's promise.
    expect(first).toBeInstanceOf(Owned);
    expect(await first).toBe('first');
    expect(await inner.catch(e => e.message)).toBe('nested secret leases are unsupported');
    expect(await reacted.catch(e => e.message)).toBe('nested secret leases are unsupported');
    expect(await other).toBe('first');
    expect(await as(a, () => store.exclusive('token', async () => store.get('token')))).toBe('first');
  } finally {
    Store.map = new Map(); Store.writes = []; Store.pending.clear();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

// The grant set is the Rust parser's normalized `secret.keep token`.
test("a render's source facade reads no secret and refuses writes before calling its backing store", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, '__exactRender');
  let reads = 0, writes = 0, keys = 0;
  const store = createSecretFacade({ get() { reads++; return 'private'; }, set() { writes++; } },
    { version: 1, entries: [[1, "secret.keep token", ["secret-keep", "token"], null]], error: null, seal: "b22a759eedfe6bc2" }, () => { keys++; return Promise.resolve({ put() {} }); });
  globalThis.__exactRender = true;
  try {
    expect(store.get('token')).toBeNull();
    expect(store.has('token')).toBe(false);
    expect(await store.unlock('token')).toBeNull();
    expect(await store.key('token')).toBeNull();
    for (const write of [() => store.set('token', 'kept'), () => store.forget('token')]) {
      expect(write).toThrow("a render's store is empty and refuses writes");
    }
    for (const write of [() => store.exclusive('token', () => { throw new Error('work ran'); }), () => store.keepKey('token', {})]) {
      expect(await write().catch(e => e.message)).toBe("a render's store is empty and refuses writes");
    }
    expect({ reads, writes, keys, read: store.read }).toEqual({ reads: 0, writes: 0, keys: 0, read: true });
  } finally {
    if (saved) Object.defineProperty(globalThis, '__exactRender', saved); else delete globalThis.__exactRender;
  }
});

// The Rust parser's normalized `secret.keep token user-presence optional` and `secret.keep key user-presence`.
const presence = { entries: [[1, "secret.keep token user-presence optional", ["secret-keep", "token"], null], [2, "secret.keep key user-presence", ["secret-keep", "key"], null]], error: null, keepsNoAnswers: false, seal: "b130c25d0bbbe8c6", version: 1 };

test("every write to a name that must be locked is refused before either backing store changes (LLP 1133.010 D15)", async () => {
  const backing = Object.assign(new Map([['key', 'older']]), { exclusive: (_name, work) => work() }), puts = [];
  const keys = () => Promise.resolve({ put: (handle, pair) => { puts.push([handle, pair]); }, get: () => null });
  const store = createSecretFacade(backing, presence, keys);
  const pair = { privateKey: {}, publicKey: {} }, refused = { name: 'NotSupportedError' };
  expect(() => store.set('key', 's')).toThrow(expect.objectContaining(refused));
  await expect(store.exclusive('key', () => 'ran')).rejects.toMatchObject(refused);
  await expect(store.keepKey('key', pair)).rejects.toMatchObject(refused);
  await expect(store.protect('key')).rejects.toMatchObject(refused);
  expect([[...backing], puts]).toEqual([[['key', 'older']], []]);
  // An `optional` name stays plain: each write goes through.
  store.set('token', 'open');
  expect(await store.exclusive('token', () => 'ran')).toBe('ran');
  await store.keepKey('token', pair);
  expect(backing.get('token')).toMatch(/^exact\.key:/);
  expect(puts).toEqual([[backing.get('token'), pair]]);
});

test("a kept key's name holds its new handle only once the pair is kept, and the newest write of the name wins", async () => {
  const granted = { version: 1, entries: [[1, "secret.keep token", ["secret-keep", "token"], null]], error: null, seal: "b22a759eedfe6bc2" };
  const backing = new Map(), kept = new Map(), writes = [];
  let opening = null;
  // Each put waits until the test settles it: `writes.at(i).ok()` or `.fail(error)`.
  const service = {
    put: (handle, pair) => new Promise((resolve, reject) => writes.push({ ok: () => { kept.set(handle, pair); resolve(); }, fail: reject })),
    get: handle => kept.get(handle) ?? null,
  };
  const store = createSecretFacade(backing, granted, () => opening ?? Promise.resolve(service));
  const settle = () => new Promise(r => setTimeout(r, 0));
  const first = { privateKey: {}, publicKey: {} }, second = { privateKey: {}, publicKey: {} };

  const keeping = store.keepKey('token', first);
  await settle();
  expect(backing.has('token')).toBe(false);
  writes.at(-1).ok();
  await keeping;
  const held = backing.get('token');
  expect(await store.key('token')).toBe(first);

  // A refused write, and a key service that does not open, leave the key the name held.
  const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const refused = store.keepKey('token', second);
  await settle();
  writes.at(-1).fail(quota);
  await expect(refused).rejects.toBe(quota);
  opening = Promise.reject(new Error('the database did not open'));
  await expect(store.keepKey('token', second)).rejects.toThrow('the database did not open');
  opening = null;
  expect(backing.get('token')).toBe(held);
  expect(await store.key('token')).toBe(first);

  // A forget while the pair is written is not undone when it lands.
  const forgotten = store.keepKey('token', second);
  await settle();
  store.forget('token');
  writes.at(-1).ok();
  await forgotten;
  expect(backing.get('token')).toBeNull();

  // Two replacements: the later call's pair is the name's, whichever lands first.
  const older = store.keepKey('token', first);
  await settle();
  const newer = store.keepKey('token', second);
  await settle();
  writes.at(-1).ok();
  await newer;
  writes.at(-2).ok();
  await older;
  expect(await store.key('token')).toBe(second);
});

test('secret names and values use the native string conversion', () => {
  const granted = { version: 1, entries: [[1, 'secret.keep token', ['secret-keep', 'token'], null]], error: null, seal: 'b22a759eedfe6bc2' };
  const backing = new Map(), store = createSecretFacade(backing, granted, () => Promise.resolve({}));
  const name = { toString: () => 'token' };
  store.set(name, 42);
  expect(backing.get('token')).toBe('42');
  expect(store.get(name)).toBe('42');
  store.forget(name);
  expect(store.get('token')).toBeNull();
});

test('denied secret writes throw ordinary errors', () => {
  const granted = { version: 1, entries: [[1, 'secret.keep token', ['secret-keep', 'token'], null]], error: null, seal: 'b22a759eedfe6bc2' };
  const store = createSecretFacade(new Map(), granted, () => Promise.resolve({}));
  const denied = (() => { try { store.set('missing', 'x'); } catch (error) { return error; } })();
  expect(denied).toBeInstanceOf(Error);
  expect(denied.refuse).toBeUndefined();
});

// LLP 1030.004 D2: another tab's write or removal of a key is taken, unless this tab owes its own write of it.
test("another tab's store write is taken unless this tab's own is owed", () => {
  Store.map = new Map([["token", "old"], ["gone", "x"]]); Store.writes = []; Store.pending.clear();
  Store.peer("token", "theirs");
  expect(Store.get("token")).toBe("theirs");
  Store.peer("gone", null);
  expect(Store.get("gone")).toBeUndefined();
  Store.set("token", "mine");
  Store.peer("token", "later");
  expect(Store.get("token")).toBe("mine");
  Store.writes = [];
});

// A request with effects arms its answer's lease before it goes (LLP 1146 D5), as a native host's park does; a GET
// or HEAD does not. ts-fetch.js is copied beside an admission whose fetch answers at once.
test("a lease's request with effects arms its recovery, and a safe one does not", async () => {
  const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(resolve(tmpdir(), 'exact-lease-fetch-'));
  try {
    cpSync(resolve(import.meta.dir, 'ts-fetch.js'), resolve(dir, 'ts-fetch.js'));
    writeFileSync(resolve(dir, 'admission.js'), `export { ownWithout, redirectOf, socketProtocols } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, 'admission.js')).href)};
export class FetchError extends Error {} export const overlaying = { on: false }; export const inOverlay = what => new Error(what);
export const signalDeadline = { arm: null }; export const fetchWith = async () => new Response('sent');\n`);
    writeFileSync(resolve(dir, 'admission-data.js'), 'export const tsGrantSet = {};\n');
    const tsf = await import(pathToFileURL(resolve(dir, 'ts-fetch.js')).href);
    let arms = 0;
    const call = { lease: { arm: () => { arms++; } } };
    const sent = [];
    // The last one from a promise reaction of the answer's (ts-fetch.js `AnswerPromise`)
    for (const [input, init, field = 'call'] of [['https://api.test/a'], ['https://api.test/a', { method: 'head' }],
      [new Request('https://api.test/a')], ['https://api.test/a', { method: 'post' }], [new Request('https://api.test/a', { method: 'DELETE' })],
      ['https://api.test/a', { method: 'PUT' }, 'promiseCall']]) {
      tsf.answering[field] = call;
      const response = tsf.fetch(input, init);
      tsf.answering[field] = null;
      await response;
      sent.push(arms);
    }
    expect(sent).toEqual([0, 0, 0, 1, 2, 3]);
    // A request refused before it goes arms nothing.
    tsf.answering.call = { ...call, mutation: true, turn: true, socketOps: [{}] };
    const refused = tsf.fetch('https://api.test/a', { method: 'POST' });
    tsf.answering.call = null;
    expect(await refused.catch(e => e.message)).toBe(tsf.SOCKET_AND_FETCH);
    tsf.answering.call = call;
    const invalid = tsf.fetch('https://api.test/a', { method: 'POST', redirect: 'bad' });
    tsf.answering.call = null;
    expect(await invalid.catch(e => e.message)).toBe('redirect must be follow, manual or error');
    expect(arms).toBe(3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
