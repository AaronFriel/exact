# Recipe: wait for a click in a partitioned frame

In one mutation answer, `Promise.all([waitForClick(), click()])` stalls.
Arm first, then send the wait and click to separate targets.

Run `bun exact.mjs add @exact/browser-automation` and add these sources in `app.ts`.

```ts
import type { Answer, Sources } from './app.contract.d.ts';
import { addPreloadScript, evaluate } from '@exact/browser-automation';

export const grants = 'browser.automation';
const frame = { id: 'tab', sandbox: 'automation' };

const done = () => ({});
const sources: Sources = {
  registerSandbox: () => addPreloadScript({ ...frame, functionDeclaration: '() => {}' }).then(done),
  armClick: () => evaluate({ ...frame, expression: `(() => {
    const button = document.querySelector('#go');
    if (!button) throw new Error('Missing #go');
    window.nextClick = new Promise(resolve => {
      button.addEventListener('click', () => resolve('clicked'), { once: true });
    });
    return true;
  })()` }).then(done),
  waitForClick: async () => {
    const { result } = await evaluate({ ...frame, expression: 'window.nextClick', awaitPromise: true });
    if (String(result) !== 'clicked') throw new Error('No click armed in this document');
    return { text: 'clicked' };
  },
  click: () => evaluate({ ...frame, userActivation: true, expression: "document.querySelector('#go').click()" }).then(done),
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
```

Check `exactPage().iframePartition` and use a unique id. Android needs a new
document after registration. WebViews without isolated worlds reject it with
`NotSupportedError`.

Use your URLs and an enabled `<button type="button" id="go">Go</button>`.
Keep the same button and document mounted for the pair.

```contract
shape Done

shape Heard
  text: string

component BrowserTab
  state problem = ""
  mutation registered as shape Done then openPage
  mutation armed as shape Done then runPair
  mutation heard as shape Heard
  mutation acted as shape Done
  action loaded(e: FrameNavigation)
    problem = ""
    if registered == none
      if not pending(registered)
        send registered = registerSandbox()
    else if e.url == "https://example.com/form"
      send armed = armClick()
  action loadFailed(e: FrameNavigation)
    problem = e.message
  action openPage
    navigate("tab", "https://example.com/form")
  action runPair
    send heard = waitForClick()
    send acted = click()
  view
    column
      iframe id="tab" src="https://example.com/start" partition="persist:browser" navigatesuccess=loaded navigateerror=loadFailed
      text problem
      for err, i in [failure(registered), failure(armed), failure(heard), failure(acted)] key=i
        text (match err { case some(f) => f.message, case none => "" })
      text (match heard { case some(r) => r.text, case none => "" })
```

Setup answers when armed. The saved promise captures a synthetic click in
either order. Rearm per click and after navigation.
