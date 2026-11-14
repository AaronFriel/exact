# Seeing what people see

This is the disposable first experiment of LLP 1172.021, not a new driver
operation or an extension of authored tests or `verify`. Run it explicitly:

```sh
bun scripts/exact.mjs see macos --app caltrain --out target/see-caltrain
bun scripts/exact.mjs see ios --app shelf --sim <owned-simulator-udid> --out target/see-shelf
```

## Checkpoint semantics

An **observation** is one read with its source, target identity, start and end
wall times, result or refusal, and saved raw evidence. Outside evidence comes
from AXUIElement and `screencapture` on macOS, or XCTest's accessibility snapshot
and `simctl io screenshot` on the simulator. Driver evidence keeps the driver's
plain tree, state and screenshot. The sources are never substituted for each
other when a read fails.

A **checkpoint** asserts only that these instruments agreed on the fields and
region explicitly compared during a stable observation interval. It does not
assert that the app is correct, accessible, or identical to another platform.
An input reply means delivery finished, not that presentation finished. The
driver's `clock settle` is recorded, then two outside tree/frame observations
bracket the inside reads; inside tree/state reads bracket those observations.
Changed trees, states, frame pixels, target identity or unsettled work make the
checkpoint inconclusive. We do not retry until a convenient picture appears.

The state comparison covers `slots`, `derives`, `resources`, `pending`, `queued`,
`tasks`, `device`, `time`, `language`, `navigation`, `dialog`, `keyboard`, `focus`,
`store` and `collections`. Diagnostics such as launch times, read counters and
memory sizes stay in the raw evidence, outside the assertion. The report lists
these fields. Within a session the tree's epoch and incarnation must stay fixed.

There is no shared compositor transaction identifier in this experiment.
Matching endpoints establish sampled stability, not atomicity: a transient
between samples can be missed. Every report states this limit. Native animation,
the cursor and wall-clock content may prevent stability. The agent clock does
not pretend to control the window server or the input system.

A **blind spot** is evidence a checkpoint needs but cannot obtain or correlate:
permissions, an absent or truncated tree, an empty or uniform capture, an
ambiguous window or target, a failed command, a moving observation, or regions
whose coordinate mapping is unknown. Each is a finding with its source and
reason. It is never a pass, and makes the checkpoint inconclusive even when
other observations agree. A uniform picture may be intentional; it still
cannot witness that the intended app content was presented.

Tree comparisons report every unmatched named element in either direction and
every differing comparable field on a uniquely joined identifier. Raw roles
remain platform-specific; no web geometry oracle or guessed role equivalence
is used. Anonymous structural nodes are retained as evidence but excluded from
semantic claims. A missing identifier does not justify a guessed match: a
unique exact label may establish a weaker name-only join, recorded as such.
These are instrument disagreements, not automatically accessibility defects.

Pictures are compared only at the same pixel size and with an explicit region
mapping. Different extents are findings and an unaligned region is a blind
spot; the experiment does not resize, guess a crop, or hide native chrome.
Every changed pixel in a mapped region contributes to the reported count and
bounding box. No perceptual threshold declares an unexplained change a pass.

Reports use `agreement`, `disagreement`, or `inconclusive`; exit codes are 0, 1,
and 2 respectively. Even `agreement` covers only the listed comparisons.
Evidence and timings stay local in the output directory.

## Input comparison

`--tap <test-id>` or `--drag <test-id> <dx> <dy> <milliseconds>` runs two fresh
driver sessions with the same launch facts and setup (`--setup-tap <test-id>`,
repeatable). One dispatches through the existing driver, the other uses
CGEvent or XCTest. Both resolve the same semantic target. Platform coordinates
come from the outside tree; ambiguity or absence refuses that leg. A drag is
target-relative, measured in platform points and wall milliseconds. Its
delivered duration is recorded; release velocity in the app is not inferred.

The before checkpoints must agree on their comparable model and outside tree
before outcomes are compared. Differing initial conditions, a failed delivery,
or an inconclusive checkpoint prevents an input-equivalence claim. A matching
outcome proves no more than the sampled state and tree; it does not prove the
target received the event. Raw input receipts and pictures remain available.
The outside outcome comparison uses identifiers, labels, roles, values, enabled
and selected states; absolute window positions and keyboard focus are omitted
because relaunch and physical input can change them independently. Differing
outcomes with incomplete evidence remain provisional findings.

## Scope and removal

The experiment uses platform chrome in its own sessions, retaining the driver's
frozen clock in both input legs. Physical input still uses wall time. It
starts no simulator implicitly: iOS requires a caller-owned booted simulator.
The existing XCTest touch runner supplies the simulator's external tree and
input; there is no new iOS helper or core dependency. Accessibility clients can
activate platform accessibility machinery in the app; this is not a performance
measurement of an app without accessibility clients.

See `REMOVING.md` for the complete deletion list and its test. Step 2 is a
hand-judged corpus of disagreements and seeded misses, followed by precision
measurements for each proposed finding kind. Accepted baselines, cross-host
layout, replay and changes to `verify` remain outside this experiment.
