// A scoped build's view of the page (build.mjs `--scoped`). The runtime reads `document`, `globalThis`,
// `window`, `history` and `location` as free names; a scoped build has Rolldown replace each with this
// module's exports (`globalThis` and `window` become `sw`; the shim itself reaches the page through `self`). Unscoped (no `?scope=` on this module's URL) they pass straight through. Scoped, the
// instance sees only its own shadow tree: ids, focus, popovers, selectors and sheets resolve inside it,
// globals it sets stay its own (`exact`, `__exact*`), and it cannot write the page's title, history,
// location or head. `mount()` (scoped-mount.mjs) registers the shadow root under the scope name first.
const win = self;
const name = new URL(import.meta.url).searchParams.get('scope');
const entry = name ? win.__exactScopes?.get(name) : null;
if (name && !entry) throw new Error(`no exact mount registered for scope ${name}`);
const shadow = entry?.shadow ?? null;
// Fail closed: a scoped URL whose registry entry is not {shadow, globals} (a mismatched mount) must never fall through to the real page.
if (name && !(shadow instanceof win.ShadowRoot)) throw new Error(`exact mount for scope ${name} has no shadow root`);
// Methods (no `prototype`) are bound to the real object so a call through the proxy is not an illegal invocation; classes are returned as they are.
const bind = (target, v) => (typeof v === 'function' && !('prototype' in v) ? v.bind(target) : v);
// Events only the document gets: they never reach a shadow root, so they stay on the real document.
const DOCUMENT_EVENTS = new Set(['visibilitychange', 'readystatechange', 'DOMContentLoaded', 'fullscreenchange', 'fullscreenerror', 'selectionchange', 'pointerlockchange', 'freeze', 'resume']);
let scopeBody = null; // the shadow tree's `body`, `head` and `documentElement`: a div the instance may fill
const stand = () => scopeBody ??= (() => { const d = win.document.createElement('div'); d.setAttribute('data-exact-scope-body', ''); d.style.display = 'contents'; shadow.append(d); return d; })();

const scopedDocument = !shadow ? win.document : new Proxy(win.document, {
  get(real, k) {
    switch (k) {
      case 'getElementById': return id => shadow.getElementById(id);
      case 'querySelector': return s => shadow.querySelector(s);
      case 'querySelectorAll': return s => shadow.querySelectorAll(s);
      case 'elementFromPoint': return (x, y) => shadow.elementFromPoint(x, y);
      case 'elementsFromPoint': return (x, y) => shadow.elementsFromPoint(x, y);
      case 'activeElement': return shadow.activeElement;
      case 'styleSheets': return shadow.styleSheets;
      case 'adoptedStyleSheets': return shadow.adoptedStyleSheets;
      case 'body': case 'head': case 'documentElement': return stand();
      case 'title': return '';
      case 'cookie': return '';
      case 'defaultView': return scopedWindow;
      case 'location': return scopedLocation;
      case 'addEventListener': return (type, fn, opts) => (DOCUMENT_EVENTS.has(type) ? real : shadow).addEventListener(type, fn, opts);
      case 'removeEventListener': return (type, fn, opts) => (DOCUMENT_EVENTS.has(type) ? real : shadow).removeEventListener(type, fn, opts);
      default: return bind(real, real[k]);
    }
  },
  // `document.title = …`, `document.cookie = …`, handlers: refused, silently, for a scoped instance.
  set: () => true,
});

const refuse = () => undefined;
const scopedHistory = !shadow ? win.history : new Proxy(win.history, {
  get: (real, k) => (['pushState', 'replaceState', 'back', 'forward', 'go'].includes(k) ? refuse : bind(real, real[k])),
  set: () => true,
});
const scopedLocation = !shadow ? win.location : new Proxy(win.location, {
  get: (real, k) => (['assign', 'replace', 'reload'].includes(k) ? refuse : bind(real, real[k])),
  set: () => true, // `location.hash = …` and `location.href = …` do not navigate the page
});

// Globals the instance defines stay its own; everything else reads through to the page.
// `globals` are what the mounting page hands this instance (host/web/scoped-mount.mjs `globals`), e.g. the function its `app.ts` calls.
// Kept on the registry entry, not module-local: the app and each lazy module (storage, documents, pickers) bundle their own copy of this shim, and all copies of a scope must share one set of globals.
const own = entry ? (entry.own ??= new Map(Object.entries(entry.globals ?? {}))) : new Map();
const scopedWindow = !shadow ? win : new Proxy(win, {
  get(real, k) {
    if (own.has(k)) return own.get(k);
    switch (k) {
      case 'document': return scopedDocument;
      case 'history': return scopedHistory;
      case 'location': return scopedLocation;
      case 'window': case 'self': case 'globalThis': case 'top': case 'parent': case 'frames': return scopedWindow;
      case 'name': return '';
      default: return bind(real, real[k]);
    }
  },
  set(_, k, v) { own.set(k, v); return true; },
  has: (real, k) => own.has(k) || k in real,
  deleteProperty: (_, k) => own.delete(k),
});

// build.mjs defines `globalThis` and `window` as `__sw` and injects it from here.
export { scopedDocument as document, scopedHistory as history, scopedLocation as location, scopedWindow as sw };
