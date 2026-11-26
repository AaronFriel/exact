// Mount a `--scoped` Exact build into a closed shadow root of a host element (host/web-js/build.mjs).
// `globals` (optional) are page-owned values this instance sees as its own globals (never shared with other instances).
// `mount(host, {base, scope})` returns `{ready, unmount}`; the page that holds `host` keeps the only reference to
// the shadow tree. `refresh(source)` asks the view's resources that read a page-owned source again. The view's ids, styles, focus and popovers live inside it; it cannot write the page's
// title, history, location or head (host/web-js/scoped-document.js). `base` is the build's directory URL.
export async function mount(host, { base, scope, css, mode = 'closed', focus = false, globals = {} }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope)) throw new Error('scope must be a short plain name');
  const registry = (self.__exactScopes ??= new Map());
  if (registry.has(scope)) throw new Error(`scope ${scope} is already mounted`);
  const shadow = host.attachShadow({ mode });
  const root = document.createElement('div');
  root.id = 'exact-root';
  shadow.append(root);
  // The build's sheet is written for a page (`:root`, `html`, `body`); in a shadow tree they are the host.
  const text = css ?? await (await fetch(new URL('style.css', base))).text();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text.replace(/(^|\})\s*html\s*,\s*body\s*\{/g, '$1:host{display:block;').replace(/(^|[},])\s*html\s*\{/g, '$1:host{').replace(/:root\b/g, ':host'));
  shadow.adoptedStyleSheets = [sheet];
  registry.set(scope, { shadow, globals: Object.freeze({ ...globals }) });
  // A view must not take focus from the page while it boots (`autofocus`): the tree is inert until it has painted, unless the host asked for focus.
  if (!focus) root.inert = true;
  try {
    // One module instance per scope: the `?scope=` query makes the URL, and so the instance, its own.
    await import(new URL(`app.js?scope=${scope}`, base).href);
  } catch (error) { registry.delete(scope); throw error; }
  if (!focus) await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => { root.inert = false; done(); })));
  return {
    // `refresh(source)`: the page's value behind that source changed (a `globals` function it reads); every resource of this
    // view that reads the source is asked again, and the view keeps its state.
    refresh(source) { registry.get(scope)?.own?.get('exact')?.refreshSource?.(String(source)); },
    // `refreshLibraries()`: the page's `exactLibrary` registry changed; every `iframe library=…` of this view resolves again.
    refreshLibraries() { registry.get(scope)?.own?.get('exact')?.refreshLibraries?.(); },
    unmount() { registry.delete(scope); root.remove(); },
  };
}
