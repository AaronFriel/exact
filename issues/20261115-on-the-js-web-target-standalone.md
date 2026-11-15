# On the JS web target standalone output held for presentation survives a freeze

**Status:** Open
**Systems:** host/web-js/facts.js, host/web-js/rt.js, host/web-js/transport.js, host/web-js/sounds.js, host/web-js/midi.js
**Severity:** P3
**Author:** Claude Fable 5.2
**Date:** 2026-11-15
**Related:** issues/20261114-on-the-wasm-web-target-a.md

## What is wrong

On the JS web target, standalone physical output can wait with a tree update
behind a view transition. `rt.js:549-577` does not apply `playSound`,
`sendMIDI` or `haptic` until the transition runs that update. If the page
freezes first, those commands survive and run when presentation is released.

The target already stops a sequence in the freeze commit
(`transport.js:401-407`). That does not cover standalone commands, and the
target does not always see the freeze. `watchPage` (`facts.js:91`) is what
listens for it, and only `page()` (`facts.js:87`, emitted for a plan with an
`exactPage` reader) and `sequence()` (`transport.js:419`) call it. A plan with
neither never registers the listener: `pageChanged` stays the no-op declared at
`facts.js:66`. A plan with no sequence whose readers read other page fields only
(`onLine`, say) does register it, and the early return at `facts.js:102` then
skips the freeze edge. A reader of `frozen` causes a commit, but that commit
still leaves the standalone commands with the deferred update.

The wasm web target now consumes an explicit mark on the freeze batch. On its
first application, it discards starts still held for presentation and delivers
ends and cleanup in order. Resume does not restore a discarded start, and a
replay of the held freeze batch cannot settle later output. This issue is the
JS target's corresponding work, split from the related wasm issue after review
found that the two runtimes need different mechanisms.

## Reproduction

Use a plan with no sequence and no `exactPage` reader. From an action, change a
tree that waits in a view transition and issue standalone `playSound`,
`sendMIDI` and `haptic` commands. Freeze the page before allowing the
transition's update, then release it. The sound plays, MIDI is sent and the
haptic runs after the freeze.

## Required behavior

- Observe the transition into frozen whatever the plan declares. Two places
  lose it today: a plan with no sequence and no `exactPage` reader never calls
  `watchPage`, so nothing listens (`facts.js:66`, `:87`, `:91`;
  `transport.js:419`); and with a reader of other page fields only, the early
  return at `facts.js:102` skips the edge. Changing that return alone does not
  fix the reproduction below.
- In the freeze commit, settle every output operation still held for
  presentation. Discard starts: sound plays, haptics, MIDI note-ons, Start,
  Continue and Timing Clock. Deliver ends and cleanup, including sound stops,
  note-offs, all-notes-off and MIDI Stop, in their original order. They must not
  wait for `rt.js:549-577` to apply the deferred tree.
- Do not arm and flush a deferred sequence's starts before stopping it.
  `transport.js:401-407` currently calls `Sounds.stood`, whose `after` flushes
  sound and MIDI at `transport.js:277-279`, before the background stop.
- Discarding a sound start must retain its implicit group stop. Group playback
  cuts an earlier voice in `sounds.js:56-61`; dropping the whole `playSound`
  command loses that cleanup.
- An invalid held command must still produce its diagnostic. In particular,
  MIDI validation and connection diagnostics belong to `midi.js:131-138` and
  cannot disappear when starts are classified.
- Tests use controlled transition and output fakes, with no wall-clock sleeps,
  and no harness that calls `facts.page(...)` first: that hides the first case.
  The standalone regression uses a plan with no sequence and no `exactPage`
  reader; sequence ordering is covered separately.
