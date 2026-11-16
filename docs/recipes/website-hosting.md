# Recipe: serving and hosting

## Serving

`bun exact.mjs web-build --out dist` writes the site to `dist/`, and `bun exact.mjs serve
dist` serves it on 127.0.0.1:8765 (`--port`, else `PORT`), rebuilding it when you edit.
A page it renders asks the API: start the stand-in (`bun server.ts`) first, or set
`API_BASE_URL` to one that answers.
`npm run build` and `npm start` do the same, as hosts run them. A static host serves
`dist/` by the rule `serve --help` states.

## Hosting below a path

Set `"host": { "web": { "base": "/app/" } }` in `app.json`, then rebuild.
The base defaults to `/` and starts and ends with `/`.
`bun exact.mjs serve dist` reads the base from the build and serves it at `/app/`.
On a static host, mount the contents of `dist/` there and apply the file and fallback
rules within that mount. Serve the generated `robots.txt` and `.well-known/`
association files at the origin root as well: crawlers, Apple and Android discover
them there. Merge them with existing policies on a shared origin. Exact's server
exposes these discovery files at the root; other requests outside
the mount return 404. Verified-link claims use the mounted scope.
The server redirects `/app` to `/app/`, keeping its query; the client also normalizes
that root if a static host serves its shell directly.

Keep route patterns and locations app-relative: `book "/book/:id"`,
`path("book", id)`, `push(nav, "/add")` and a location passed through an action
parameter use the same paths as a root build. Entries and `navigate` events also
carry app-relative locations. The runtime removes the mount from incoming browser
locations and adds it to link hrefs and browser history. Literal and computed links,
including `path()` links, therefore stay under `/app/`. A route named `/app/item`
opens at `/app/app/item`.
Destinations are canonicalized before mounting: `"item"` and `"/../item"`
both open `/app/item`. A data source's grant-free `fetch("/assets/file.txt")` reads
the bundled asset within the mount and the page's build generation. Images, video
posters and Markdown links follow the same boundaries. Canonical and social-image
paths receive the mount before they are made absolute against `app.origin`; explicit
absolute URLs are kept. `host.web.head` remains literal HTML: use `./assets/…` for
bundled files there, and absolute URLs for destinations outside the site.

The JS renderer supports build, request and cached pages under the base, including
install pages and the web manifest. An explicit manifest `scope` is mounted too;
without one, its scope is the directory of the mounted `start_url`. Use `--render js`
if the app has a Rust renderer. A one-off `render.mjs dist /item` and a driver's
`--url /item` also take app-relative locations.
The wasm target, Rust renderer, signed update store (`deploy` and baked plans),
auth callbacks and web/native development loop currently require `/`; their commands
refuse a non-root base. For site development, use `web-build --out dist`, then
`serve dist`, which rebuilds on edits.
