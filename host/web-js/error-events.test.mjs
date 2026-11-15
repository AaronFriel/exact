import { hostFixtureFile } from '../web/tests/glue-fixture.mjs';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/utils';
import { suiteBrowser } from '../../scripts/agent-launch.mjs';

// LLP 1175's shared fixture (js/tests/fixtures/error-events.ts) on the web JS target: the page's own error events,
// heard by the module as js/tests/it/error_events.rs hears them natively, against the same error-events.json.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = resolve(ROOT, 'js/tests/fixtures/error-events.ts');
const EXPECTED = JSON.parse(readFileSync(resolve(ROOT, 'js/tests/fixtures/error-events.json'), 'utf8'));

// The fixture as the JS target's build gives a module its bindings (build.mjs `scopedModule`): the answer's own
// timers, the scheduler's promise and the scoped global from ts-fetch.js. Its native export line becomes an ES export.
function source() {
  const authored = readFileSync(FIXTURE, 'utf8').replace(/^\(globalThis as any\)\.exact = .*$/m, 'export { answer };');
  const bound = ['setTimeout', 'clearTimeout', 'queueMicrotask', 'Promise', 'AbortSignal', 'fetch'];
  const result = transformSync(FIXTURE, authored, { tsconfig: false, inject: {
    ...Object.fromEntries(bound.map(name => [name, ['/host/web-js/ts-fetch.js', name]])),
    globalThis: ['/host/web-js/ts-fetch.js', 'appGlobal'] } });
  if (result.errors.length) throw new Error(result.errors.map(e => e.message).join('\n'));
  return result.code;
}

test('the shared fixture hears on the web what it hears natively', async () => {
  const glue = readFileSync(resolve(ROOT, 'host/web-js/ts-data.js'), 'utf8')
    .replace('__APP_TS__', '/source.js').replace('__FETCH_MODULE__', './ts-fetch.js')
    .replace('__AUTH_IMPORT__', '').replace('__AUTH_INSTALL__', '');
  const generated = {
    '/source.js': source(),
    '/host/web-js/ts-data.js': glue,
    '/host/web-js/names.js': 'export const sourceTypes = { run: [["s"], "s"] };',
    '/host/web-js/admission-data.js': "import { createGrantSet } from './admission.js'; export const tsGrantSet = createGrantSet('');",
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response('<div id="exact-root"></div>', { headers: { 'content-type': 'text/html' } });
    if (generated[path]) return new Response(generated[path], { headers: { 'content-type': 'text/javascript' } });
    const local = resolve(ROOT, '.' + path);
    const file = existsSync(local) ? local : resolve(ROOT, 'host/web', path.split('/').at(-1));
    return existsSync(file) ? new Response(hostFixtureFile(file), { headers: { 'content-type': 'text/javascript' } }) : new Response('Not found', { status: 404 });
  } });
  let browser;
  try {
    browser = await suiteBrowser();
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.evaluate(async () => {
      const rt = await import('/host/web-js/rt.js');
      const { install } = await import('/host/web-js/ts-data.js');
      const { answering } = await import('/host/web-js/ts-fetch.js');
      install(rt.data);
      // An answer as the runtime asks one, its value once it lands; a task after it, so what a browser queues as a
      // task (`unhandledrejection` after a promise's own task, `rejectionhandled`) has run.
      const task = () => new Promise(r => setTimeout(r, 20));
      window.run = async kind => {
        let value;
        try {
          const out = rt.data.answer('run', [kind], {}, 'run');
          value = out.promise ? await out.promise : out.v;
        } catch { value = null; }
        await task();
        return value;
      };
      window.journal = () => answering.page.journal.map(l => l.replace(/^t=\S+ /, ''));
    });
    expect(await page.evaluate(() => run('probe'))).toBe(EXPECTED.probe);
    for (const scenario of EXPECTED.scenarios) {
      const kind = scenario.run, from = await page.evaluate(() => journal().length);
      const answered = await page.evaluate(k => run(k), kind);
      if (scenario.fails) expect(answered).not.toBe(kind);
      else expect(answered).toBe(kind);
      const journal = await page.evaluate(n => journal().slice(n), from);
      const heard = JSON.parse(await page.evaluate(() => run('log')));
      expect([kind, heard]).toEqual([kind, scenario.heard.web ?? scenario.heard]);
      const reports = l => l.includes('unhandled rejection') || l.includes('callback threw');
      expect([kind, journal.filter(reports)]).toEqual([kind, scenario.journal.web]);
    }
  } finally { await browser?.close(); server.stop(true); }
}, 30000);
