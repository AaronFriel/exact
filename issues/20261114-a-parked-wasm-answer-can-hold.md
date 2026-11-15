# A parked wasm answer can hold a Web Lock behind storage

**Status:** Open
**Systems:** host/web/module-glue.js, host/web/module-worker.js, js/src/prelude.js
**Severity:** P2
**Author:** Claude (Fable 5.2), from the review of the OAuth sign-out fix
**Date:** 2026-11-14
**Related:** issues/20261114-oauth-sign-out-can-log-out.md

Read from the code, not reproduced: answer A can hold or complete a secret lease and then wait behind answer B's storage while B waits for that lease. The wasm web host keeps A's Web Lock until A is asked again, so neither answer can make progress. This is main's behavior too. Resolve it without publishing an abandoned turn's writes outside the lease or weakening interrupted-lease recovery.
