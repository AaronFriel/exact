# Recipe: keep rows on a warm tab return

Set `app=docs/recipes/progressive-tabs` in two terminals at the repo root. Run one command per terminal. Reply after `Held`. Use one client.

```sh
bun "$app/server.mjs"
bun host/apple/build.mjs "$app" --ios --run
```

Open Explore. Give `/rows/Stocks 200`. Rows appear. Give `/history/Stocks 200`.

[History](progressive-tabs/data/src/lib.rs) uses `request.independent_http(4096)`. Its GET and parser may reorder because neither affects rows. Keep writes and dependent reads ordered. Bodies over 4 KiB fail (valid ceiling 1 byte–64 MiB). Native admits 128 within 68 MiB, six running (LLP 1041 §8.4). [HTTP scheduling](../reference.md#what-a-data-module-can-use)

## Leave and return

Tap Home, then Explore. Its keyed [entry](progressive-tabs/app.contract) survives. Both `when shown` resources keep their values and ask again. An `if current(rows)` guard would show a placeholder. On wake `pending` is true. `current` stays false until success. Refreshing a current answer at the same arguments leaves it true.

```text
if rows.filter == filter
  for item in rows.items key=item
    text item
```

Changing arguments keeps the answer. Contract cannot read its key. Rust returns the requested filter with its items. Nonempty filters never match `empty().filter`. Include account or window in the call, answer and guard if they identify the data.

Send `/rows/Stocks 503`, then `/history/Stocks 503`. Both keep their data and report errors via `failed`. Switch filter. Lend hides both Stocks answers, showing a placeholder until `/rows/Lend 200`.

Each resource keeps one answer despite `Cache-Control: no-store`. Headers govern the native GET cache. Durable offline rows need app storage.

## Compare native GETs

Relaunch. Choose **Use ordered history**, then Explore. Give rows 200. Rows stay pending until history gets 503. Ordinary native reads overlap and deliver in request order (LLP 1162 D1). Read the Linux journal.

```sh
bun scripts/build-linux.mjs "$app"
bun scripts/agent.mjs linux --app "$app" 'tap compare' 'tap tab-explore' 'clock until state pending == [] within 60000' logs
```

```text
t=0 fulfil 2 (rows) [HTTP 200, 11 bytes; wall 27 ms; delivery wait 467 ms] → epoch 5 (+1 −1 ~1)
```

## Trace the warm return

Repeat the warm return in Chromium with `bun host/web/dev.mjs --app "$app"`. Read console state before and after the rows 503.

```js
await (await exact.attachReads())({op: 'state'})
```

On `/explore`, rows ticket 4 was pending at epoch 6 and failed at 7. Press ⌥⇧T. Set `file` to its path.

```sh
bun scripts/agent.mjs trace "$file"
jq -c '.frames.records[] | select(.seq) | {t,seq}' "$file"
# {"t":288.1,"seq":[6,6]}
# {"t":338.1,"seq":[7,7]}
```

In `.journal.lines`, ticket 4 ends with `it keeps its last value: HTTP 503`. Frame callbacks carry the observed epochs. This trace lacks touch delivery, wire arrival and physical presentation times.

On iOS tap with four fingers, choose **Save Trace** and run `bun scripts/agent.mjs trace --phone <name-or-UDID> --app <app-dir>`.
