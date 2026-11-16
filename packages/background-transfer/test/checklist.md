# @exact/background-transfer: drives by hand

What the agent cannot drive: iOS relaunching a terminated app for its
transfers' events, a person's force-quit, and a phone before its first
unlock (LLP 1133.017 D10). Record the date, the OS version and what
happened beside each step when you run it.

Build the fixture as `test/apple.mjs` makes it, for the phone
(`bun host/apple/build.mjs --ios --device --run bgtfixture-apple` with
`EXACT_APP_DIR` set to the made app), against a copy of that suite's server
the phone can reach. The host's lines are in the system's log, subsystem
`dev.exact`, category `wakes`.

1. **In front.** Tap Upload u1. The server receives `hello u1` with the
   `Authorization` header; the app shows `u1 success success  201 kept u1`
   and the ids line empties.
2. **Terminated by the system.** Make the server hold `/upload`'s answer
   for 60 s. Tap Upload u2, go Home, and kill the process from Xcode's
   debugger before the answer. See the server's `/heard` for u2 within
   seconds of the answer, with no launch by hand: iOS relaunched the app,
   the host booted the session with no view, and the handler ran.
3. **A person's force-quit.** As 2, but swipe the app away in the app
   switcher. Nothing is heard while it stays closed. Open it: the app
   shows `u2 abort failure aborted`.
4. **Before the first unlock.** As 2, then restart the phone before the
   answer and leave it locked. Record whether anything is heard before the
   first unlock (D10's staging is not built, so it should not be), and what
   the app shows when opened after it.
5. **A large download.** Serve a file of several hundred megabytes at
   `/file`, tap Download d1 and lock the phone. Record how long it took and
   whether `saveTo` holds the whole file.

## Android

These checks need a phone or an emulator that boots. The JVM tests run the
lifecycle against the adapter and Robolectric's schedulers; they do not show
what Android's scheduler, WorkManager or the Keystore do. Build the fixture
above with `bun scripts/agent-android.mjs build <app> --apk` and
`EXACT_APP_DIR` set to its directory, against a server the phone can reach.
Record the Android version beside each step.

Every start is a program's until the runtime tells the package that a call
is a person's act, so each transfer here runs as WorkManager work. A person's
transfer (a user-initiated job, its notification and the tap that raises
`backgroundfetchclick`) gets its steps when a start can be one.

1. **In front.** Upload, download, a refused origin, a directory as `saveTo`
   and an abort. The upload sent is the file as it was at the start, though
   the source is edited afterwards. A second start of an id that is not
   retired is a `TypeError`. A kept body is at
   `app:/data/transfers/<id>/<index>`. Retiring removes the kept bodies and
   leaves `saveTo` files; the id starts again once the retirement has
   answered.
2. **A large upload's copy.** Start an upload of several hundred megabytes
   and go Home during the copy: the app stays responsive, and an abort during
   the copy answers at once. A start whose `bodyFrom` is missing rejects, and
   its id is free again.
3. **Stops and failures.** Hold the server's answer past WorkManager's ten
   minutes three times in a row: the transfer ends `fetch-error`, not
   `aborted`. Drop the network during a transfer: it runs again when the
   network returns, and ends `fetch-error` at the fifth failure with no
   response kept between them.
4. **Deaths.** Kill the process during a large upload, restart the phone
   during a download and install an update, each time leaving the app closed:
   the transfer finishes. A request cut short starts again from byte zero,
   and the requests already answered are not sent again. Kill during the
   upload's copy and during a response's placement: the copy is made again
   and the response is placed, with no body reported lost.
5. **Force-stop.** Force-stop from Settings during a transfer, then open the
   app: it shows the abort. Swiping the app away, an update and a restart
   are not taken for a force-stop. Run this on API 35 or later, where the
   package reads `ApplicationStartInfo.wasForceStopped`, and on an earlier
   one, where it reads a cancelled `PendingIntent`.
6. **Endings.** Finish a transfer with the app closed: nothing is heard
   until the app is opened (the host has no session without a view on
   Android yet), then the event comes, and comes again at each launch until
   it is retired. Finish one with the app running behind another: the event
   is heard there. Retire, start the same id again, and see that nothing of
   the first transfer reaches the second.
7. **Locked.** A transfer under a locked screen, a restart before the first
   unlock, missing Keystore keys and a corrupt secret file. No credential is
   ever read from plaintext. Staging before the first unlock is not built.
