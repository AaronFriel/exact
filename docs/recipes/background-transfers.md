# Recipe: transfers the system finishes

`@exact/background-transfer` (iOS, macOS and Android; the web reads `available`
false and uses `fetch`) hands an upload or download to the system, which
finishes it after the app is suspended or terminated. Data code alone
starts one, since its headers may carry a credential; each `url`,
`bodyFrom` and `saveTo` must be granted (`net.fetch`, `fs.read`,
`fs.write`):

```ts
import { backgroundFetch, backgroundFetchRegistration, retireBackgroundFetch } from '@exact/background-transfer';
await backgroundFetch({ id: `photo:${key}`, requests: [{ url: uploadUrl, method: 'PUT', bodyFrom: 'app:/data/out/photo.jpg', headers: [{ name: 'Authorization', value: token }], saveTo: null }] });
```

The root hears `backgroundfetchsuccess`, `backgroundfetchfail` or
`backgroundfetchabort` with the registration, in a wake. Each response
body is a file: the request's `saveTo`, else the kept path
`app:/data/transfers/<id>/<index>` (grant `fs.read app:/data`), where the id
is one path segment, each byte outside ASCII letters, digits, `-` and `_`
percent-encoded: read `records[index].path`. Android places a response
again at the next launch when a placement failed. Retire it
(`retireBackgroundFetch`) once what it carried is kept: until then the
event comes again at later launches. Retiring removes the kept files, and
the id can be started again once it has answered.
`packages/background-transfer/test` is a whole example.

On Android a transfer runs as WorkManager work that waits for a network.
An id names one registration until it is retired. Three stops by the system
or five network failures in a row, with no response kept between them, end
the transfer as `fetch-error`. A person's transfer, which Android runs as a
user-initiated job with a notification (API 34; a tap raises
`backgroundfetchclick`), is built but not reachable: the runtime does not
yet tell the package that a call is a person's act, so every start is a
program's.

The transfer finishes without the app. Its event is raised in the running
app; with none it waits for the next launch that shows the app, and it comes
again at each launch until the registration is retired. A force-stop aborts
the transfers not yet finished, and the abort is delivered at the next
launch. After a restart of the phone or an update, transfers carry on
without the app being opened. None of this has run on a device:
`packages/background-transfer/test/checklist.md` has the drives.
