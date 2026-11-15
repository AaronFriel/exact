// LLP 1175 D2: a module whose evaluation throws, after it listens for the
// global's `error` event.
addEventListener("error", (e: Event) => {
  console.log("heard " + (e as ErrorEvent).error.message);
});
(globalThis as any).exact = { abi: 1, appId: "test.error-events-load", grants: "", answer() {} };
throw new Error("at load");
