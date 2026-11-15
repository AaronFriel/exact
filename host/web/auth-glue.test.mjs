// auth-glue.js across two same-origin tabs, each its own import of the module: the
// callback page's broadcast reaches every tab, and only the tab whose session's
// state it carries takes it.
import { afterAll, expect, test } from 'bun:test';
import { suiteBrowser } from '../../scripts/agent-launch.mjs';

const saved = ['BroadcastChannel', 'window', 'location', 'navigator', 'addEventListener', 'removeEventListener']
  .map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
afterAll(() => {
  for (const [k, d] of saved) if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
});

// One origin's channels: a post reaches every other open channel of its name.
const open = new Set();
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; open.add(this); }
  postMessage(data) { for (const c of open) if (c !== this && c.name === this.name) c.onmessage?.({ data }); }
  close() { open.delete(this); }
};
globalThis.window = { open: () => ({ closed: false, close() {} }) };
globalThis.location = { origin: 'https://app.example' };
globalThis.navigator = {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const CALLBACK = 'https://app.example/.exact/auth/callback';
/** A tab with one sign-in pending under `state`; `done` collects what it reports. */
async function tab(name, ticket, state) {
  const { arm } = await import(`./auth-glue.js?tab=${name}`);
  const done = [];
  arm({ ticket }, {
    agent: false, log() {}, active: () => true, deliver() {},
    call: req => {
      if (req.op === 'done') done.push(req);
      return req.op === 'arm' ? { present: { url: `https://login.example/authorize?state=${state}`, callback: CALLBACK, state } } : {};
    },
  });
  return done;
}
// The callback page's post (auth-callback.js).
const broadcast = url => {
  const channel = new BroadcastChannel('exact-auth');
  channel.postMessage({ type: 'exact-auth', url });
  channel.close();
};

test("a broadcast callback ends only the sign-in whose state it carries, in either order", async () => {
  const a = await tab('a', 1, 'state-a'), b = await tab('b', 2, 'state-b');
  for (const url of [`${CALLBACK}?code=c`, `${CALLBACK}?code=c&state=state-a&state=state-b`, `${CALLBACK}?state=other`, 'not a url']) broadcast(url);
  expect([a, b]).toEqual([[], []]);
  broadcast(`${CALLBACK}?code=b&state=state-b`);
  expect([a, b]).toEqual([[], [{ op: 'done', ticket: 2, url: `${CALLBACK}?code=b&state=state-b` }]]);
  broadcast(`${CALLBACK}?code=a&state=state-a`);
  expect(a).toEqual([{ op: 'done', ticket: 1, url: `${CALLBACK}?code=a&state=state-a` }]);
  expect(b.length).toBe(1);
  expect(open.size).toBe(0);
});

// Real browsing-context separation, with the app's clock controlled independently of the provider.
for (const engine of ['chromium', 'webkit']) test(`${engine}: auth waits through COOP, closure and focus return until a callback, supersession or the bound`, async () => {
  const html = body => new Response(body, { headers: { 'content-type': 'text/html' } });
  const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const url = new URL(request.url), callback = url.searchParams.get('callback');
    if (url.searchParams.has('quick')) return Response.redirect(callback);
    const response = html(`<button id="approve">Approve</button><script>
      document.querySelector('button').onclick = () => location.href = ${JSON.stringify(callback)};
    </script>`);
    if (url.searchParams.has('coop')) response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return response;
  } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/auth-glue.js' || path === '/auth-callback.js')
      return new Response(Bun.file(new URL(`.${path}`, import.meta.url)), { headers: { 'content-type': 'text/javascript' } });
    if (path === '/.exact/auth/callback') return html('<script src="/auth-callback.js"></script>');
    return html(`<button id="sign-in">Sign in</button><script type="module">
      import { arm } from '/auth-glue.js';
      window.reports = []; window.deliveries = []; window.logs = [];
      window.ticket = 0; window.mode = 'coop';
      const open = window.open.bind(window);
      window.open = (...args) => window.popup = open(...args);
      document.querySelector('button').onclick = () => {
        const current = ++window.ticket;
        const callback = location.origin + '/.exact/auth/callback';
        const state = 'state-' + current;
        arm({ ticket: current }, {
          agent: false, active: t => t === window.ticket,
          deliver: t => deliveries.push(t), log: line => logs.push(line),
          call: req => {
            if (req.op === 'done') reports.push(req);
            return req.op === 'arm' ? { present: { callback, state,
              url: ${JSON.stringify(provider.url.href)} + '?' + mode + '&callback=' +
                encodeURIComponent(callback + '?state=' + state + '&code=fixture') } } : {};
          },
        });
      };
    </script>`);
  } });
  let browser;
  try {
    browser = await suiteBrowser(engine);
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const start = async mode => {
      await page.evaluate(mode => { window.mode = mode; }, mode);
      const opened = page.waitForEvent('popup');
      await page.locator('#sign-in').click();
      return opened;
    };
    const reports = () => page.evaluate(() => reports);
    const popup = await start('coop');
    await popup.locator('#approve').waitFor();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(await page.evaluate(() => popup.closed)).toBe(true);
    expect(popup.isClosed()).toBe(false);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(6000);
    expect(await reports()).toEqual([]);
    await popup.locator('#approve').click();
    await page.waitForFunction(() => reports.length === 1);
    expect(await reports()).toEqual([{ op: 'done', ticket: 1, url: `${server.url.origin}/.exact/auth/callback?state=state-1&code=fixture` }]);
    expect(await page.evaluate(() => logs)).toContain('auth 1: a callback arrived (channel)');

    // A redirect that immediately closes its window still delivers exactly once.
    await page.evaluate(() => { window.savedChannel = window.BroadcastChannel; window.BroadcastChannel = undefined; });
    await start('quick');
    await page.waitForFunction(() => reports.length === 2);
    expect((await reports())[1]).toEqual({ op: 'done', ticket: 2, url: `${server.url.origin}/.exact/auth/callback?state=state-2&code=fixture` });
    expect(await page.evaluate(() => logs)).toContain('auth 2: a callback arrived (opener)');
    await page.evaluate(() => { window.BroadcastChannel = window.savedChannel; });

    // Closing a real window is indistinguishable from COOP to its opener.
    const closed = await start('plain');
    await closed.locator('#approve').waitFor();
    expect(await page.evaluate(() => popup.closed)).toBe(false);
    await closed.close();
    expect(await page.evaluate(() => popup.closed)).toBe(true);
    await page.clock.runFor(6000);
    expect((await reports()).length).toBe(2);
    await page.clock.fastForward(600_000 - 6000 - 1);
    expect((await reports()).length).toBe(2);
    await page.clock.runFor(1);
    expect((await reports())[2]).toEqual({ op: 'done', ticket: 3, status: 499, message: 'cancelled' });

    const stale = await start('coop');
    await stale.locator('#approve').waitFor();
    const current = await start('plain');
    await current.locator('#approve').waitFor();
    await Promise.all([stale.waitForEvent('close'), stale.locator('#approve').click()]);
    await current.locator('#approve').click();
    await page.waitForFunction(() => reports.length === 4);
    expect((await reports())[3].ticket).toBe(5);

    // A forgotten request closes its reachable popup and never delivers a cancellation.
    const forgotten = await start('plain');
    await forgotten.locator('#approve').waitFor();
    await page.evaluate(() => { window.ticket = 0; });
    await Promise.all([forgotten.waitForEvent('close'), page.clock.runFor(250)]);
    await page.clock.fastForward(600_000);
    expect((await reports()).length).toBe(4);
    expect(await page.evaluate(() => deliveries)).toEqual([1, 2, 3, 5]);
  } finally {
    await browser?.close(); server.stop(true); provider.stop(true);
  }
}, 30_000);
