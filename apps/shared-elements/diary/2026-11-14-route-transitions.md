surfaces: web
agent: Claude Code (Claude Opus 5.5)
task: a route's own entrance and exit, the reporter's fade, slide and cut (LLP 1013.001)

### Rough

- Moving the existing route into the last arm of an `if` chain left its body one level too
  shallow: the route compiled empty and its children became the root's, with no warning. The
  zoom viewer then showed a blank page, and only the app's own test noticed.
- The first push of a route with parts cut: shared.js loads after first paint only when a
  mounted node asks for it, and the route that declares a part is not mounted at boot. Fixed
  in exact2: a plan with a part asks for it at boot.

### Lean in

- The parts are CSS's: `::view-transition-new` and `::view-transition-old` with `animation`,
  in a `style` the route takes, so the three cases are three small styles.

### Needed

- Nothing for this.

### Checkpoints

- Web (Chromium): Detail slides in and out over Home, which stays still; Camera fades in and
  out full screen; Scanner cuts; Plain keeps the platform's cut. Films under `screenshot …
  over`.
