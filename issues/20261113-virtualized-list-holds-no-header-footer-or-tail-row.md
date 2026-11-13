# A virtualized list holds nothing but its one `for`, so headers, footers and a streaming row become data

**Status:** Open
**Systems:** contract/lower/src/collection.rs (`lower-collection-template`), collection runtime (LLP 1070), docs/recipes/chat-thread.md
**Severity:** P3
**Author:** Claude (Opus 5.5), from Exact diaries sent 2026-11-11 to 2026-11-13
**Date:** 2026-11-13

## What is wrong

The compiler and the runner, web, painted and terminal presenters admit fixed
lead and trail content around a vertical virtualized list's keyed `for` with
`appearance="none"`. The remaining work is the Apple presenter and its
simulator, macOS and device runs.

The original refusal forced headers, loading and end states into synthetic
data rows. A streaming reply concatenated to the transcript through a derive
recomputed that list on each token; that cost was reported, not measured.

## The failure

- A chat app (exact2 `5434f4325`, then `4d295cadc`): the streaming tail row
  beside the `for` was refused, and the tail was concatenated into the one
  list through a derive. `docs/recipes/chat-thread.md` shows a settled
  transcript only, and does not say how to show a reply while it streams.
- A port of an existing mobile app (diary on `94b8671f7`): a plain `scroll`
  with a `for` mounted every row and froze for 170 ms when a page arrived;
  `list virtualized=true` fixed that, but the feed's header and footer had to
  become synthetic rows. It asked for header and footer slots, and for a build
  hint when a `for` over a resource sits in a plain `scroll`.

## Fix

Select LLP 1035.005.000 D11 with these consumers: fixed nodes before and
after the `for` in a virtualized list, as a scrolling container on the web
holds them. Measure them as items in the height index, retaining authored
padding and the children's formatting context.

The approved chat recipe keeps a streaming reply as the keyed last data row
so its focus, selection and state survive completion. A fixed trail serves
loading and end notices.

## Implementation

The refusal now says what to write today and names `docs/recipes/long-lists.md`,
whose loading row is the pattern: a row of the `for`'s collection, appended by
a derive. The chat-thread recipe has no room under its size cap for the
streaming case. What remains is selecting LLP 1035.005.000 D11.

## Decision (2026-11-14)

LLP 1035.005.000 D11 stays unselected, amended 2026-11-14 from a blind panel
(`llp/reviews/panel-2026-11-14-diary-decisions.*`, D3). Two of three seats found
the runtime cost small (`concat` clones `Rc` items; the 65,536-step meter is far
above a chat screen) and the authoring cost real. When D11 is selected, its first
build changes only the compiler: fixed nodes before and after the `for` lower to
synthetic rows of the same collection with reserved keys. The trigger is a third
diary hitting this, not a performance number. This issue stays open as that
evidence.

## Height-index build

The compiler admits lead and trail nodes around the one direct keyed `for`
on a vertical list with `appearance="none"`, with named refusals for the
unsupported shapes. Runtimes without fixed-item geometry refuse the shape.
This issue stays open until the Apple implementation and its parity and
accessibility runs land; the Linux lane cannot qualify Apple behavior.

The runner, shared painted presenter (Linux and Windows), terminal presenter
and web geometry reader now measure fixed items separately from authored
padding. Runner tests cover an empty data set, a followed trail growing,
and anchoring inside long fixed content when history grows. Apple refuses
the shape before boot. Its remaining stage must measure the authored fixed
children without wrappers, report both fixed measurement identities, preserve
anchors inside them, follow and reach the trail's end, gate trail accessibility,
and pass eager parity, end-growth and device interaction runs.

The JS target also implements fixed items. Web, Linux and terminal pass eager
box parity and followed trail growth. The trail's accessibility gate and logical
copy order are covered, and the fixed-content corpus agrees across the runner,
Lean and JS target. The long-list notice still applies inside fixed content.

The issue remains open for the Apple stage described above. The Linux lane
cannot run UIKit, AppKit, momentum, rubber banding, keyboard/refresh or VoiceOver
qualification on Apple devices.
