# @exact/clipboard

A Paste button sends a mutation whose data source declares `clipboard.read`.
Call `await readText()` for the first plain-text item or `await read()` for the
list of items. Each item has `types` and `getType(type)`. On Android, a focused
window can read up to 1 MiB of UTF-8 text. An empty clipboard or an image alone
gives `""` or `[]`. A read without input focus rejects with `NotAllowedError`.
If a text provider misses the read's 1.5-second deadline, its item is skipped.
An agent drive reads the text copied in its own session by default.

See the [clipboard reference](../../docs/reference.md#clipboard-images) for
writes, platform formats and the Apple paste permission (LLP 1133.006 D6–D7).
