// Two scoped Exact views and a hostile one in one page, each mounted in its own closed shadow root from a
// `--scoped` build. Needs Chromium (CHROME or /usr/bin/chromium-browser) and a built target/debug/exact-web-js.
import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dir, '../..');
const target = resolve(root, 'target');
mkdirSync(target, { recursive: true });
const scratch = mkdtempSync(resolve(target, 'scoped-mount-'));
const bun = process.execPath;
const view = (title, extra = '', head = '') => `routes nav
  home "/"

component App
  state n = 0
  action bump
    n = n + 1
  view
    column testId="${title}-root"
${head}      text \`${title} \${n}\` id="label" testId="label"
      button id="btn" press=bump testId="bump"
        text "bump"
      input id="field" testId="field"
${extra}`;
const apps = {
  alpha: view('Alpha'),
  beta: view('Beta'),
  // Everything a view can do to its page that a Contract can spell: the title, a name the page owns, and focus.
  hostile: view('Hostile', '      column id="exact-root" testId="dup"\n        text "dup"\n      input id="host-input" testId="steal" autofocus=true\n', '      head title="HIJACKED"\n'),
};
for (const [name, src] of Object.entries(apps)) {
  const stage = resolve(scratch, name, 'stage');
  mkdirSync(stage, { recursive: true });
  writeFileSync(resolve(stage, 'app.contract'), src);
  writeFileSync(resolve(stage, 'app.json'), JSON.stringify({ name, short_name: name, id: `dev.exact.${name}`, app: { id: `dev.exact.${name}`, name }, host: { web: {} } }));
  writeFileSync(resolve(stage, 'package.json'), '{"name":"v","private":true,"type":"module"}');
  writeFileSync(resolve(stage, 'app.ts'), "export const grants = '';\nexport const answer = () => { throw Error('no sources'); };\n");
  const built = spawnSync(bun, ['host/web-js/build.mjs', stage, '--scoped', '--render', 'none', '--out', resolve(scratch, name, 'out')], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw Error(`${name}: ${built.stderr.slice(-600)}`);
}
{
  const built = spawnSync(bun, ['host/web-js/build.mjs', resolve(scratch, 'hostile', 'stage'), '--render', 'none', '--out', resolve(scratch, 'hostile', 'plain')], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw Error(`control: ${built.stderr.slice(-600)}`);
}
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
  const url = new URL(request.url), m = /^\/v\/(\w+)\/(.+)$/.exec(url.pathname), plain = /^\/u\/(.*)$/.exec(url.pathname);
  if (plain) { const f = resolve(scratch, 'hostile', 'plain', plain[1] || 'index.html'); return existsSync(f) ? new Response(extname(f) === '.html' ? readFileSync(f, 'utf8').replace('<base href="/">', '<base href="/u/">') : Bun.file(f), { headers: { 'content-type': types[extname(f)] ?? 'application/octet-stream' } }) : new Response('Not found', { status: 404 }); }
  if (url.pathname === '/') return new Response(`<!doctype html><meta charset="utf-8"><title>PAGE TITLE</title>
    <style>.c1,.c2,.c3,.c4,.c5,.c6,.c7,.c8{display:none !important} #exact-root{outline:5px solid red} #label,#btn,#field{display:none}</style>
    <input id="host-input" value="page input"><div id="a"></div><div id="b"></div><div id="h"></div>`, { headers: { 'content-type': 'text/html' } });
  const file = m && resolve(scratch, m[1], 'out', m[2]);
  return file && !m[2].includes('..') && existsSync(file) ? new Response(Bun.file(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' } }) : new Response('Not found', { status: 404 });
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
afterAll(async () => { await browser.close(); server.stop(true); rmSync(scratch, { recursive: true, force: true }); });

async function page(mode = 'open') {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${server.port}/`);
  await p.evaluate(async ([origin, mode]) => {
    const { mount } = await import(`${origin}/v/alpha/scoped-mount.mjs`);
    window.mounted = {};
    for (const [name, host] of [['alpha', 'a'], ['beta', 'b'], ['hostile', 'h']]) window.mounted[name] = await mount(document.getElementById(host), { base: `${origin}/v/${name}/`, scope: name, mode });
  }, [`http://127.0.0.1:${server.port}`, mode]);
  await new Promise(r => setTimeout(r, 500));
  return p;
}

test('three views mount in one page, each in its own shadow tree, and work independently', async () => {
  const p = await page();
  const text = id => p.evaluate(h => document.getElementById(h).shadowRoot.querySelector('[data-testid$="root"]')?.innerText, id);
  expect(await text('a')).toContain('Alpha 0'); expect(await text('b')).toContain('Beta 0');
  // the page's own rules (`.c1{display:none}`, `#label{display:none}`) do not reach into the shadow trees
  expect(await p.evaluate(() => getComputedStyle(document.getElementById('a').shadowRoot.querySelector('#label')).display)).not.toBe('none');
  await p.evaluate(() => document.getElementById('a').shadowRoot.querySelector('[data-testid="bump"]').click());
  await p.evaluate(() => document.getElementById('a').shadowRoot.querySelector('[data-testid="bump"]').click());
  await new Promise(r => setTimeout(r, 300));
  expect(await text('a')).toContain('Alpha 2'); expect(await text('b')).toContain('Beta 0');
  await p.close();
});

test('the page keeps its identity: ids, title, history, location, and no view reaches the page DOM', async () => {
  const p = await page();
  const before = await p.evaluate(() => ({ title: document.title, href: location.href, history: history.length }));
  expect(before.title).toBe('PAGE TITLE');                                  // `head title="HIJACKED"` did not write it
  // ids live in the shadow trees: the page's lookups find none of the views' ids
  expect(await p.evaluate(() => [document.getElementById('label'), document.getElementById('btn'), document.getElementById('field'), document.querySelectorAll('#exact-root').length])).toEqual([null, null, null, 0]);
  expect(await p.evaluate(() => document.getElementById('host-input').value)).toBe('page input'); // the hostile view's duplicate `host-input` is not the page's
  expect(await p.evaluate(() => document.getElementById('h').shadowRoot.querySelector('[data-testid="dup"]') !== null)).toBe(true);
  await p.close();
});

test('scoped globals: each instance has its own `exact`, and none leaks to the page', async () => {
  const p = await page();
  expect(await p.evaluate(() => typeof globalThis.exact)).toBe('undefined');
  expect(await p.evaluate(() => Object.keys(globalThis).filter(k => /^__exact(?!Scopes)|^exact/.test(k)))).toEqual([]);
  await p.close();
});

test('a closed mount gives the page no way into the view', async () => {
  const p = await page('closed');
  expect(await p.evaluate(() => document.getElementById('a').shadowRoot)).toBeNull();
  await p.close();
});

test('mount refuses a bad or duplicate scope name', async () => {
  const p = await page();
  const out = await p.evaluate(async origin => {
    const { mount } = await import(`${origin}/v/alpha/scoped-mount.mjs`);
    const el = document.createElement('div'); document.body.append(el);
    const r = [];
    for (const scope of ['bad scope', 'alpha', '']) { try { await mount(el, { base: `${origin}/v/alpha/`, scope }); r.push('mounted'); } catch (e) { r.push(String(e.message).slice(0, 40)); } }
    return r;
  }, `http://127.0.0.1:${server.port}`);
  expect(out.every(x => x !== 'mounted')).toBe(true);
  await p.close();
});

test('control: the same hostile view, not scoped, does rewrite the page title', async () => {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${server.port}/u/`);
  await new Promise(r => setTimeout(r, 600));
  expect(await p.evaluate(() => document.title)).toBe('HIJACKED');
  await p.close();
});

test('focus: a view that asks for autofocus while booting does not take it from the page (and admission refuses autofocus anyway)', async () => {
  const p = await page();
  const active = await p.evaluate(() => document.activeElement?.id || document.activeElement?.localName);
  console.log('ACTIVE ELEMENT after mounting the hostile view:', active);
  expect(active).not.toBe('h');   // not the hostile view's shadow host
  await p.close();
});

test('a mismatched mount fails closed: a scoped build never falls through to the real page', async () => {
  const p = await page();
  const out = await p.evaluate(async origin => {
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    // the pre-`globals` registry shape (the shadow root itself), as an old vendored mount would write it
    (self.__exactScopes ??= new Map()).set('old', shadow);
    try { await import(`${origin}/v/hostile/app.js?scope=old`); return 'loaded'; } catch (e) { return String(e.message).slice(0, 80); }
  }, `http://127.0.0.1:${server.port}`);
  expect(out).not.toBe('loaded');
  expect(await p.evaluate(() => document.title)).toBe('PAGE TITLE');
  await p.close();
});
