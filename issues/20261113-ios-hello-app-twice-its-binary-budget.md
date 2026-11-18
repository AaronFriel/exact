# The iOS hello app is about 4.5 MB over its 8 MB size target

**Status:** Open
**Systems:** host/apple (iOS binary size), runner (native module seam), scripts/metrics.mjs
**Severity:** P2
**Author:** Claude (Opus 5.5), async lane triage
**Date:** 2026-11-13

`bun scripts/metrics.mjs --long` measures the hello app's stripped iOS simulator executable over an empty UIKit
app's (LLP 1047.001 D8) and gates it at `IOS_HELLO_BYTES`. The size row's target is 8 MB, 8,000,000 B (Charlie,
2026-11-17: "trying to get to 8MB is maybe worth it"). Main at 02639b8ea, measured on an M5 Max with Xcode 27.2:

| row | measured | ceiling | target |
|---|---:|---:|---:|
| optimized for size (the embed default) | 12,489,072 B | 12,590,000 B | 8,000,000 B |
| balanced (the iOS and tvOS app default) | 17,352,512 B | 17,460,000 B | |
| optimized for speed (the Mac default) | 19,599,408 B | 19,700,000 B | |

The ceilings are a tripwire at main's size plus about 100 KB, not an accepted size. A row over its ceiling says how
far over in 100 KB steps (`VIOLATION by 0.2 MB`), and the async lane's failure carries the step, so each further
step up is a new failure the lane attributes to the commit that took it, and a step down is not
(`scripts/async-bisect.mjs`, `newFailures` and `holds`). The target needs about 4.5 MB cut from the size build. Byte counts differ between Xcode versions, so
measure with the lane's.

## How to reproduce

`bun scripts/metrics.mjs --long` prints the three `iOS: hello app` rows. To measure them alone, run what the
`ios-size` step runs: for each of `speed`, `size` and `balanced`, `EXACT_UPDATE_TRUST=production
EXACT_UPDATE_GENESIS=1 bun host/apple/build.mjs hello-apple --ios --no-install --optimize <mode>`, then `xcrun
strip -o <copy>` the executable `appleArtifacts(hello, { destination: 'ios-simulator', trust: 'production',
optimize })` names, and subtract the stripped `host/apple/ios/floor.swift` built with `swiftc -Osize` (53,680 B).
The dSYM beside the executable attributes the bytes by symbol.

## How it grew

Speed row, bytes over the floor, on one Mac with Xcode 27.2 (commits before 2026-11-01 are the private
repository's):

| commit | date | speed | Rust text | Swift text |
|---|---|---:|---:|---:|
| e6caf40bf (the October ceiling) | 10-08 | 8,495,136 | 3.17 MB | 3.80 MB |
| c4d5e135bb | 10-16 | 10,252,832 | 3.76 MB | 4.62 MB |
| 636ff1263c | 10-17 | 11,035,728 | 4.06 MB | 4.95 MB |
| bffeda03f6 | 10-22 | 13,201,360 | 4.84 MB | 5.97 MB |
| f2447c136d | 10-23 | 13,568,704 | 4.98 MB | 6.16 MB |
| 8388cd0a48 | 10-28 | 16,290,928 | 6.55 MB | 7.07 MB |
| 029cd282d3 | 11-01 | 16,813,472 | 6.57 MB | 7.45 MB |
| 2a2f95a00 | 11-13 | 18,806,368 | 7.35 MB | 8.53 MB |

About 0.3 MB a day, with no single jump. Once a row was over its ceiling, further growth was the same failure, so
the lane attributed none of it; the stepped failure above is the fix for that.

Cut so far: the launch preloads (LLP 1162.000) are held as a `dyn LaunchWork` that only `IoLinks` makes (−82 KB
speed, −33 KB size), and a production composition compiles none of the Swift agent (−993 KB speed, −783 KB size;
its development builds keep it, and the production link proof in `metrics.mjs` checks both).

## Where the size build's bytes are

By the symbols in the size build's dSYM at 02639b8ea (each symbol sized to the next in its section; a generic
from `core` or `alloc` charged to the crate it is instantiated over), of 11.59 MB the symbols cover:

| | bytes |
|---|---:|
| ExactKit | 5,127,896 |
| `exact_runner` | 1,276,180 |
| ExactCore | 850,712 |
| `exact_kernel` | 725,969 |
| Swift standard library | 508,426 |
| outlined by the linker (unattributed) | 464,060 |
| `exact_apple` | 373,796 |
| `core` (its own tables and code) | 329,216 |
| `taffy` | 227,765 |
| the C ABI exports | 191,588 |
| everything else | 1,517,298 |

Swift is about 6.5 MB of it, so most of the cut has to come from ExactKit and ExactCore.

`runner::modules` is 0.31 MB of `exact_runner` here (0.93 MB at speed), counting the generics instantiated over
its types. Hello's plan names no module, yet one switch cannot cut it: the directory holds more than the module
seam. It holds four things a plan reaches without naming a module:

- **Call provenance** (`admit.rs`): origins, causes and invocation stamping, which every commit and request goes
  through (`ticket_origin`, `as_invocation_caused`, `origin_for` from settlement, the queue, overrun, mapper turns
  and replies). This is core runner machinery.
- **Tool calls** (`calls.rs`, LLP 1111), keyed on the plan's `tools` table, not its `modules` table.
- **Presence secrets** (`presence.rs`), driven by the data code's `secret.keep` grants and reached from `kept.rs`
  and `query.rs`; `Capability::Presence` already names them.
- **The native modules proper**: substitutes, admission, wakes, processes, devices, sheets, samples and agent
  tickets.

About 150 functions defined there are called from the rest of the runner (most from `commit.rs`,
`module_work.rs`, `reply.rs`, `advance.rs`, `gates.rs` and `admission.rs`), and about 20 public runner methods
from the Apple and web hosts and `host/executor` (`bind_extensions`, `invoke_module`, `take_module_effects`,
`install_presence` and others).

## What is next

1. **The module seam's design**, as an amendment to LLP 1047.001: provenance moves into the core; the native
   modules sit behind one seam the composition supplies when the plan's `modules` table is not empty, and tool
   calls behind one supplied when its `tools` table is not empty; presence follows `Capability::Presence`; each
   refuses a plan that needs what the binary lacks (D5), and development links all of them (D6).
2. **A measured cut list for 8 MB**: bytes by family for ExactKit, ExactCore and each Rust crate, each marked as
   needed by a one-text, one-button plan (D1's core) or not, with what selects it today and how it would come
   out. The module seam is about 0.3 MB of the 4.5 MB.

This closes when the size row is at or under 8,000,000 B and its ceiling has come down with it.
