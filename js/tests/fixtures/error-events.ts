// LLP 1175's shared fixture (§5, piece 1): a data module that listens for its
// global's error events as a page does, and a source that makes each kind of
// report happen. js/tests/it/error_events.rs runs it natively and
// host/web-js/error-events.test.mjs on the web JS target, each against
// error-events.json: the listener calls every host makes, and what each
// host's journal says.
type Heard = (string | number | boolean)[];
let heard: Heard[] = [];
let held: Promise<unknown>[] = [];
// What the next report does: `cancel` cancels an `error` event in `onerror`,
// `rethrow` throws from the `unhandledrejection` listener, `async` makes the
// first `error` listener return a promise that rejects.
let mode = "";

const text = (e: unknown): string =>
  e !== null && typeof e === "object" && "message" in e ? `${(e as Error).name}: ${(e as Error).message}` : String(e);
const which = (p: Promise<unknown>): number => held.indexOf(p);
// The reporter's probe (#519), before this module sets a handler.
const g = globalThis as any;
const probe = [typeof g.onerror, typeof g.addEventListener, typeof g.reportError, typeof g.onunhandledrejection].join(",");

addEventListener("error", (e: Event) => {
  const event = e as ErrorEvent;
  heard.push(["error", text(event.error), event.cancelable, event instanceof ErrorEvent]);
  if (mode === "async") return Promise.reject(new Error("from the listener"));
});
onerror = (message, _filename, _lineno, _colno, error) => {
  heard.push(["onerror", text(error), typeof message]);
  return mode === "cancel";
};
addEventListener("error", (e: Event) => {
  heard.push(["after", e.defaultPrevented]);
});
addEventListener("unhandledrejection", (e: Event) => {
  const event = e as PromiseRejectionEvent;
  heard.push(["unhandledrejection", text(event.reason), which(event.promise), event.cancelable]);
  if (mode === "rethrow") throw new Error("the listener threw");
});
onunhandledrejection = (e: PromiseRejectionEvent) => {
  heard.push(["onunhandledrejection", text(e.reason)]);
};
addEventListener("rejectionhandled", (e: Event) => {
  const event = e as PromiseRejectionEvent;
  heard.push(["rejectionhandled", text(event.reason), which(event.promise)]);
});

function answer(_source: string, args: unknown[]): unknown {
  const kind = String(args[0]);
  switch (kind) {
    case "probe":
      return probe;
    case "names": {
      // Natively only: what else the events binding gives, and what it does not.
      let tracker = "replaced";
      try {
        g.HermesInternal.enablePromiseRejectionTracker({ allRejections: true, onUnhandled() {} });
      } catch (e) {
        tracker = text(e);
      }
      const before = onerror;
      onerror = () => {};
      const assigned = typeof onerror === "function" && onerror !== before;
      onerror = before;
      return JSON.stringify([typeof g.self, typeof g.navigator, new Event("x").timeStamp,
        new AbortController().signal instanceof EventTarget, assigned, tracker]);
    }
    case "log": {
      const said = JSON.stringify(heard);
      heard = [];
      mode = "";
      return said;
    }
    case "report":
      reportError(new Error("reported"));
      heard.push(["returned"]);
      return kind;
    case "cancel":
      mode = "cancel";
      reportError(new Error("cancelled"));
      return kind;
    case "async":
      mode = "async";
      reportError(new Error("async"));
      return kind;
    case "microtask":
      queueMicrotask(() => {
        throw new Error("task");
      });
      return kind;
    case "abort": {
      const controller = new AbortController();
      controller.signal.addEventListener("abort", () => {
        throw new RangeError("listener");
      });
      controller.abort();
      return kind;
    }
    case "timer":
      return new Promise((resolve) => {
        setTimeout(() => {
          throw new Error("timer");
        }, 0);
        setTimeout(() => resolve(kind), 0);
      });
    case "rejection":
      held = [Promise.reject(new Error("lost"))];
      return kind;
    case "shared": {
      const reason = new Error("shared");
      held = [Promise.reject(reason), Promise.reject(reason)];
      return kind;
    }
    case "late":
      held = [Promise.reject(new Error("late"))];
      return kind;
    case "handle":
      held[0].catch(() => {});
      return kind;
    case "rethrow":
      mode = "rethrow";
      held = [Promise.reject(new Error("rethrown"))];
      return kind;
    case "answer-throws":
      throw new Error("the answer failed");
    case "answer-rejects":
      return Promise.reject(new Error("the answer rejected"));
  }
  throw new Error("no such kind " + kind);
}

(globalThis as any).exact = { abi: 1, appId: "test.error-events", grants: "", answer };
