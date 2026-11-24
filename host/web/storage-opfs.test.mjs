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
    w.onmessage = ({ data }) => {
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
