// @ref LLP 1027 D10 — database connections hand off the path lock and the OPFS handles together.
import { afterAll, beforeAll, expect } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { webkit } from 'playwright-core';
import { suiteBrowser } from '../../scripts/agent-launch.mjs';
import { engineTests } from '../../scripts/coverage.mjs';
import { hostFixtureFile } from './tests/glue-fixture.mjs';

const engines = ['chromium', 'firefox', 'webkit'], tests = await engineTests(engines);
const sqlite = resolve(import.meta.dir, '../../node_modules/@sqlite.org/sqlite-wasm/dist');
let server;
beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
    if (path === '/hold') return new Promise(resolve => {
      const finish = () => resolve(new Response('released'));
      const timer = setTimeout(finish, 10000);
      request.signal.addEventListener('abort', () => { clearTimeout(timer); finish(); }, { once: true });
    });
    if (path === '/cut.js') {
      const worker = hostFixtureFile(resolve(import.meta.dir, 'storage-worker.js'), 'utf8');
      return new Response(worker.replace("from './sqlite3.mjs'", "from './observed-sqlite.mjs'"), { headers: { 'content-type': 'text/javascript' } });
    }
    if (path === '/observed-sqlite.mjs') return new Response(observedSqlite, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/favicon.ico') return new Response(null, { status: 404 });
    if (path === '/capability.js') return new Response(`
      onmessage = async () => {
        try {
          const root = await navigator.storage.getDirectory(), name = crypto.randomUUID();
          const file = await root.getFileHandle(name, { create: true });
          const closed = (await file.createSyncAccessHandle()).close();
          await closed;
          await root.removeEntry(name);
          postMessage(!closed?.then);
        } catch { postMessage(false); }
      };`, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/storage-worker.js') {
      const source = hostFixtureFile(resolve(import.meta.dir, 'storage-worker.js'), 'utf8');
      return new Response(source.replace('db.checkRc(c.sqlite3_set_authorizer', `
        if (session.pool) postMessage({ durability: [db.selectValue('PRAGMA journal_mode'), db.selectValue('PRAGMA synchronous')] });
        db.checkRc(c.sqlite3_set_authorizer`), { headers: { 'content-type': 'text/javascript' } });
    }
    if (path === '/quota.js') return new Response(`
      import './storage-worker.js';
      const original = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
      FileSystemDirectoryHandle.prototype.getDirectoryHandle = function(name, options) {
        if (name === 'exact-sqlite-sahpool') {
          FileSystemDirectoryHandle.prototype.getDirectoryHandle = original;
          throw new DOMException('pool quota', 'QuotaExceededError');
        }
        return original.call(this, name, options);
      };`, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/without-opfs.js') return new Response(
      "import './storage-worker.js'; delete globalThis.FileSystemFileHandle?.prototype.createSyncAccessHandle;",
      { headers: { 'content-type': 'text/javascript' } });
    const file = path === '/sqlite3.mjs' ? resolve(sqlite, 'index.mjs')
      : path === '/sqlite3.wasm' ? resolve(sqlite, 'sqlite3.wasm') : resolve(import.meta.dir, path.slice(1));
    return new Response(hostFixtureFile(file), { headers: { 'content-type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
  } });
});
afterAll(() => server?.stop(true));

async function tab(context, appId, worker) {
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.evaluate(({ appId, worker }) => {
    const w = new Worker(worker, { type: 'module' }), calls = new Map();
    let sequence = 0;
    globalThis.imports = 0;
    w.onmessage = ({ data }) => {
      if (data.imported) { globalThis.imports++; return; }
      if (data.cut) {
        w.terminate();
        for (const { reject } of calls.values()) reject(new Error('interrupted ' + data.cut));
        return;
      }
      if (data.durability) { globalThis.durability = data.durability; return; }
      const { resolve, reject } = calls.get(data.id);
      calls.delete(data.id);
      if (data.error) reject(Object.assign(new Error(data.error.message), data.error));
      else resolve(data.value);
    };
    w.onerror = e => { for (const { reject } of calls.values()) reject(new Error(e.message)); };
    globalThis.ask = (op, ...args) => new Promise((resolve, reject) => {
      calls.set(++sequence, { resolve, reject });
      w.postMessage({ client: 1, id: sequence, appId, op, args });
    });
  }, { appId, worker });
  return page;
}

for (const engine of engines) tests[engine](`two tabs hand off one committed SQLite file on either store (${engine})`, async () => {
  const browser = await suiteBrowser(engine);
  const profile = engine === 'webkit' ? mkdtempSync(resolve(tmpdir(), 'exact-storage-')) : null;
  try {
    for (const [worker, persistent] of [['/storage-worker.js', false], ['/without-opfs.js', false], ...(profile ? [['/storage-worker.js', true]] : [])]) {
      const context = persistent ? await webkit.launchPersistentContext(profile) : await browser.newContext();
      try {
        const [first, second] = await Promise.all([tab(context, 'tabs', worker), tab(context, 'tabs', worker)]);
        const path = 'app:/data/database';
        await first.evaluate(async path => {
          globalThis.db = await ask('open', path);
          await ask('execute', db, 'create table notes(n integer)', []);
        }, path);
        const waiting = second.evaluate(async path => { globalThis.db = await ask('open', path); }, path);
        await first.waitForFunction(async path => (await navigator.locks.query()).pending.some(lock => lock.name.endsWith(path)), path);
        await first.evaluate(async () => {
          await ask('execute', db, 'insert into notes values(42)', []);
          await ask('close', db);
        });
        await waiting;
        expect(await second.evaluate(async () => {
          const n = (await ask('query', db, 'select n from notes', [])).rows[0][0];
          await ask('close', db);
          return Number(n);
        })).toBe(42);
        const stored = await first.evaluate(async path => {
          const db = await new Promise(resolve => { const r = indexedDB.open('exact-storage:tabs'); r.onsuccess = () => resolve(r.result); });
          try {
            return await new Promise(resolve => {
              const r = db.transaction('files').objectStore('files').get(path);
              r.onsuccess = () => resolve(r.result.pool ? 'opfs' : 'indexeddb');
            });
          } finally { db.close(); }
        }, path);
        const capable = worker !== '/without-opfs.js' && await first.evaluate(() => new Promise(resolve => {
          const probe = new Worker('/capability.js');
          probe.onmessage = e => { probe.terminate(); resolve(e.data); };
          probe.postMessage(null);
        }));
        expect(stored).toBe(capable ? 'opfs' : 'indexeddb');
        if (capable) expect(await first.evaluate(() => globalThis.durability)).toEqual(['delete', 2]);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); if (profile) rmSync(profile, { recursive: true, force: true }); }
}, 60_000);

tests.chromium('a failed pool installation leaves no visible database and a lost pool never opens empty', async () => {
  const browser = await suiteBrowser(), context = await browser.newContext(), path = 'app:/data/notes';
  try {
    const page = await tab(context, 'failure', '/quota.js');
    const first = await page.evaluate(async path => {
      const error = await ask('open', path).then(() => null, e => e.code);
      const { createFileStore } = await import('/storage-fs.js'), files = createFileStore('failure');
      try { return [error, await files.readdir('app:/data')]; }
      finally { files.close(); }
    }, path);
    expect(first).toEqual(['failed', []]);
    await page.evaluate(async path => {
      const db = await ask('open', path);
      await ask('execute', db, 'create table notes(n)', []);
      await ask('close', db);
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('exact-sqlite-sahpool', { recursive: true });
    }, path);
    await page.close();
    const next = await tab(context, 'failure', '/storage-worker.js');
    expect(await next.evaluate(path => ask('open', path).then(() => 'opened', e => e.code), path)).toBe('failed');
  } finally { await context.close(); await browser.close(); }
}, 30_000);

// Stop the actual worker at each durable boundary. The wait keeps it at the named
// instruction until the page terminates it, including inside a synchronous VFS write.
const observedSqlite = `
import init from './sqlite3.mjs';
const cut = new URL(location.href).searchParams.get('cut');
function checkpoint(name) {
  if (cut !== name) return;
  postMessage({ cut });
  const hold = new XMLHttpRequest(); hold.open('GET', '/hold', false); hold.send();
  throw new Error('test did not terminate the worker');
}
const send = self.postMessage.bind(self);
self.postMessage = message => {
  if ('value' in message) checkpoint('after publication');
  send(message);
};
let associating = false, measuring = false;
const size = FileSystemSyncAccessHandle.prototype.getSize;
FileSystemSyncAccessHandle.prototype.getSize = function() {
  const bytes = size.call(this);
  if (measuring) {
    measuring = false;
    checkpoint('after size read');
    if (cut === 'wrong size') return bytes + 1;
  }
  return bytes;
};
const original = FileSystemSyncAccessHandle.prototype.write;
FileSystemSyncAccessHandle.prototype.write = function(bytes, opts) {
  if (associating && cut === 'short association' && opts.at < 4096) return 0;
  if (associating && cut === 'changed payload' && bytes.byteLength >= 8192) {
    const altered = new Uint8Array(bytes).slice();
    altered[altered.length - 1] ^= 1; // A valid integer field with a different value.
    return original.call(this, altered, opts);
  }
  if (cut === 'partial copy' && bytes.byteLength >= 8192) {
    original.call(this, new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 4096), opts);
    checkpoint('partial copy');
  }
  return original.call(this, bytes, opts);
};
const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function(value, ...args) {
  const request = put.call(this, value, ...args);
  if (value.kind === 'sqlite-opfs') checkpoint('before publication');
  return request;
};
export default async function(options) {
  const sqlite = await init(options), install = sqlite.installOpfsSAHPoolVfs;
  const control = sqlite.capi.sqlite3_file_control;
  sqlite.capi.sqlite3_file_control = (...args) => {
    if (args[2] === sqlite.capi.SQLITE_FCNTL_FILE_POINTER) measuring = true;
    return control(...args);
  };
  sqlite.installOpfsSAHPoolVfs = async (...args) => {
    const pool = await install(...args);
    const copy = pool.importDb.bind(pool);
    pool.importDb = (...args) => {
      checkpoint('before copy');
      associating = true;
      const size = copy(...args);
      associating = false;
      postMessage({ imported: true });
      checkpoint('after copy');
      return size;
    };
    return pool;
  };
  return sqlite;
}`;

tests.chromium('an interrupted import keeps one complete source until SQLite verifies its replacement', async () => {
  const browser = await suiteBrowser();
  try {
    for (const cut of ['before copy', 'partial copy', 'after copy', 'after size read', 'before publication', 'after publication', 'wrong size', 'short association', 'changed payload', 'corrupt source']) {
      const context = await browser.newContext(), path = 'app:/data/db';
      try {
        const seed = await tab(context, 'import', '/without-opfs.js');
        await seed.evaluate(async ({ path, corrupt }) => {
          const id = await ask('open', path);
          await ask('execute', id, 'create table notes(n)', []);
          await ask('execute', id, 'insert into notes values(123)', []);
          await ask('close', id);
          if (corrupt) {
            const { createFileStore } = await import('/storage-fs.js');
            const files = createFileStore('import'), bytes = new Uint8Array(await files.readFile(path));
            bytes[100] = 255; // Page one's b-tree header follows the 100-byte database header.
            await files.writeFile(path, bytes);
            files.close();
          }
        }, { path, corrupt: cut === 'corrupt source' });
        const attempt = await tab(context, 'import', '/cut.js?cut=' + encodeURIComponent(cut));
        const error = await attempt.evaluate(path => ask('open', path).then(() => '', e => e.message), path);
        if (cut === 'corrupt source') expect(error).toMatch(/malformed|integrity check/i);
        else if (cut === 'short association') expect(error).toMatch(/open|I.O/i);
        else if (cut === 'changed payload') expect(error).toContain('contents mismatch');
        else if (cut === 'wrong size') expect(error).toContain('size mismatch');
        else expect(error).toBe('interrupted ' + cut);
        await attempt.close();
        const image = await seed.evaluate(async path => {
          const { createFileStore } = await import('/storage-fs.js');
          const files = createFileStore('import');
          try { return (await files.databaseEntry(path, false)).entry.contents?.byteLength ?? 0; }
          finally { files.close(); }
        }, path);
        expect(image > 0).toBe(cut !== 'after publication');
        if (cut === 'corrupt source') continue;
        if (cut === 'after copy') await seed.evaluate(async path => {
          const db = await ask('open', path);
          await ask('execute', db, 'update notes set n=456', []);
          await ask('close', db);
        }, path);
        const peers = await Promise.all([tab(context, 'import', '/cut.js'), tab(context, 'import', '/cut.js')]);
        const reopened = await Promise.all(peers.map(page => page.evaluate(async path => {
          const id = await ask('open', path);
          const n = (await ask('query', id, 'select n from notes', [])).rows[0][0];
          await ask('close', id);
          return [Number(n), globalThis.imports];
        }, path)));
        expect(reopened.map(r => r[0])).toEqual(cut === 'after copy' ? [456, 456] : [123, 123]);
        expect(reopened.reduce((n, r) => n + r[1], 0)).toBe(cut === 'after publication' ? 0 : 1);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}, 90_000);

tests.chromium('empty files and Blob images import, and removing a staged source reclaims its pool', async () => {
  const browser = await suiteBrowser(), context = await browser.newContext();
  try {
    const fallback = await tab(context, 'legacy', '/without-opfs.js');
    const pooled = await tab(context, 'legacy', '/storage-worker.js');
    await fallback.evaluate(async () => {
      const empty = await ask('open', 'app:/data/empty');
      await ask('close', empty);
      const full = await ask('open', 'app:/data/full');
      await ask('execute', full, 'create table notes(n)', []);
      await ask('close', full);
      const { createFileStore } = await import('/storage-fs.js'), files = createFileStore('legacy');
      try {
        const blob = new Blob([await files.readFile('app:/data/full')]);
        await files.putBlob('app:/data/blob', blob);
      } finally { files.close(); }
    });
    expect(await pooled.evaluate(async () => {
      const counts = [];
      for (const path of ['empty', 'blob']) {
        const db = await ask('open', 'app:/data/' + path);
        counts.push(Number((await ask('query', db, "select count(*) from sqlite_schema where name='notes'", [])).rows[0][0]));
        await ask('close', db);
      }
      return counts;
    })).toEqual([0, 1]);
    const attempt = await tab(context, 'legacy', '/cut.js?cut=after%20copy');
    expect(await attempt.evaluate(() => ask('open', 'app:/data/full').catch(e => e.message))).toBe('interrupted after copy');
    await attempt.close();
    const remaining = await fallback.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('exact-sqlite-sahpool');
      const pools = async () => { const names = []; for await (const name of root.keys()) names.push(name); return names.length; };
      const before = await pools();
      const { createFileStore } = await import('/storage-fs.js'), files = createFileStore('legacy');
      try {
        await files.rename('app:/data/full', 'app:/data/moved');
        const db = await ask('open', 'app:/data/moved');
        const count = Number((await ask('query', db, "select count(*) from sqlite_schema where name='notes'", [])).rows[0][0]);
        await ask('close', db);
        return [before - await pools(), count];
      } finally { files.close(); }
    });
    expect(remaining).toEqual([1, 1]);
  } finally { await context.close(); await browser.close(); }
}, 30_000);
