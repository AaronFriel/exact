// `--scoped --factory` (scoped-factory.mjs): two views built apart share one runtime.js, fetched once, and keep their state apart.
// Needs Chromium (CHROME or /usr/bin/chromium-browser) and a built target/debug/exact-web-js.
import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dir, '../..');
const target = resolve(root, 'target');
mkdirSync(target, { recursive: true });
const scratch = mkdtempSync(resolve(target, 'scoped-factory-'));
const bun = process.execPath;
const view = (title) => `routes nav
  home "/"

component App
  state n = 0
  action bump
    n = n + 1
  view
    column testId="${title}-root"
      text \`${title} \${n}\` id="label" testId="label"
      button id="btn" press=bump testId="bump"
        text "bump"
`;
const apps = { alpha: view('Alpha'), beta: view('Beta') };
const build = (name, extra = []) => {
  const built = spawnSync(bun, ['host/web-js/build.mjs', resolve(scratch, name, 'stage'), '--scoped', '--factory', '--render', 'none', '--production', '--out', resolve(scratch, name, 'out'), ...extra], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw Error(`${name}: ${built.stderr.slice(-600)}`);
};
for (const [name, src] of Object.entries(apps)) {
  const stage = resolve(scratch, name, 'stage');
  mkdirSync(stage, { recursive: true });
  writeFileSync(resolve(stage, 'app.contract'), src);
  writeFileSync(resolve(stage, 'app.json'), JSON.stringify({ name, short_name: name, id: `dev.exact.${name}`, app: { id: `dev.exact.${name}`, name }, host: { web: {} } }));
  writeFileSync(resolve(stage, 'package.json'), '{"name":"v","private":true,"type":"module"}');
  writeFileSync(resolve(stage, 'app.ts'), "export const grants = '';\nexport const answer = () => { throw Error('no sources'); };\n");
  build(name);
}
// The runtime exports the names its views import; a second pass builds both against the union, so the two runtime.js files are one.
const names = {};
for (const name of Object.keys(apps)) for (const [module, list] of Object.entries(JSON.parse(readFileSync(resolve(scratch, name, 'out/runtime.json'), 'utf8')).names)) names[module] = [...new Set([...(names[module] ?? []), ...list])];
writeFileSync(resolve(scratch, 'names.json'), JSON.stringify(names));
for (const name of Object.keys(apps)) build(name, ['--factory-names', resolve(scratch, 'names.json')]);

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const requests = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
  const url = new URL(request.url), m = /^\/v\/(\w+)\/(.+)$/.exec(url.pathname);
  requests.push(url.pathname + url.search);
  if (url.pathname === '/') return new Response('<!doctype html><meta charset="utf-8"><div id="a"></div><div id="b"></div>', { headers: { 'content-type': 'text/html' } });
  // One shared runtime, as Q serves it: every view's `./runtime.js` is rewritten to one URL.
  if (url.pathname === '/shared/runtime.js') return new Response(Bun.file(resolve(scratch, 'alpha', 'out/runtime.js')), { headers: { 'content-type': 'text/javascript' } });
  if (m && m[2] === 'app.js') {
    const text = readFileSync(resolve(scratch, m[1], 'out/app.js'), 'utf8');
    if (!text.includes('"./runtime.js"')) return new Response('view does not import ./runtime.js', { status: 500 });
    return new Response(text.replace('"./runtime.js"', '"/shared/runtime.js"'), { headers: { 'content-type': 'text/javascript' } });
  }
  const file = m && resolve(scratch, m[1], 'out', m[2]);
  return file && !m[2].includes('..') && existsSync(file) ? new Response(Bun.file(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' } }) : new Response('Not found', { status: 404 });
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
afterAll(async () => { await browser.close(); server.stop(true); rmSync(scratch, { recursive: true, force: true }); });

test('two views built apart carry the same runtime.js', () => {
  const [a, b] = ['alpha', 'beta'].map(name => readFileSync(resolve(scratch, name, 'out/runtime.js')));
  expect(a.equals(b)).toBe(true);
  const [appA, appB] = ['alpha', 'beta'].map(name => readFileSync(resolve(scratch, name, 'out/app.js')).length);
  // The view is the plan and a call: a small fraction of the runtime.
  expect(appA).toBeLessThan(a.length / 8); expect(appB).toBeLessThan(a.length / 8);
});

test('views from one factory do not share state, and one runtime.js is fetched', async () => {
  const p = await browser.newPage(), errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`http://127.0.0.1:${server.port}/`);
  await p.evaluate(async origin => {
    const { mount } = await import(`${origin}/v/alpha/scoped-mount.mjs`);
    window.mounted = {};
    for (const [name, host] of [['alpha', 'a'], ['beta', 'b']]) window.mounted[name] = await mount(document.getElementById(host), { base: `${origin}/v/${name}/`, scope: name, mode: 'open' });
  }, `http://127.0.0.1:${server.port}`);
  await new Promise(r => setTimeout(r, 500));
  const text = id => p.evaluate(h => document.getElementById(h).shadowRoot.querySelector('[data-testid$="root"]')?.innerText, id);
  const bump = id => p.evaluate(h => document.getElementById(h).shadowRoot.querySelector('[data-testid="bump"]').click(), id);
  expect(await text('a')).toContain('Alpha 0'); expect(await text('b')).toContain('Beta 0');
  await bump('a'); await bump('a');
  await new Promise(r => setTimeout(r, 200));
  expect(await text('a')).toContain('Alpha 2');
  expect(await text('b')).toContain('Beta 0');   // the other instance's state is untouched
  await bump('b');
  await new Promise(r => setTimeout(r, 200));
  expect(await text('b')).toContain('Beta 1'); expect(await text('a')).toContain('Alpha 2');
  // The runtime's own state is per instance: two `create` calls from the same module have distinct `data` stores.
  const distinct = await p.evaluate(async origin => {
    const { default: create } = await import(`${origin}/shared/runtime.js`);
    const one = create('alpha', 'probe.one'), two = create('beta', 'probe.two');
    return one !== two && one.state.data !== undefined && one.state.data !== two.state.data && one.state.journal !== two.state.journal;
  }, `http://127.0.0.1:${server.port}`).catch(error => String(error));
  expect(distinct).toBe(true);
  expect(requests.filter(r => r.includes('runtime.js')).length).toBe(1);   // one fetch for the runtime, two views
  expect(errors).toEqual([]);
  await p.close();
});
