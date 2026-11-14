// The platforms an app outside this repository ships, and the native workspaces it builds them in (LLP 1153 D1,
// LLP 1153.003 D1).
//
// The manifest is the declaration: `host.<platform>` names a platform, with `deploy.store.<platform>` for the three
// that hold an update store. A native verb names its platform the first time it runs (`bringPlatform`), and the crates
// a build needs are generated under the app's `.exact/shells/`, as a game's bake writes `.shells/` (game/app/shells.mjs).
// The app's own crates (a data crate, a GPU module) sit beside app.json and join the generated workspaces as members
// (`appMembers`); exact2 writes every host crate. An app with its own `Cargo.toml` is an authored workspace, which
// `resolveApp` takes instead (scripts/cargo-check.mjs `authoredWorkspace`; LLP 1153.003 D3).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoEnvironment, lockedMetadata, pathFrom, patchLines } from './app.mjs';
import { nativePackages } from './package-libraries.mjs';
import { MEMBER_OF, appCrates, authoredWorkspace, notAMember, shellsDir } from './cargo-check.mjs';
import { APPLE_BUILD_SCRIPT, appleBuildScript } from './linked-plan.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The platforms a manifest can name, each with the crate that serves it. An Apple TV build has no key of its own: it
 * takes `host.ios` (scripts/app.schema.json). */
export const PLATFORMS = { ios: 'apple', macos: 'apple', linux: 'linux', android: 'android', windows: 'windows' };
/** SDK dependencies whose names app and game crates may not take. */
export const SDK_CRATES = new Set(['ibex2-sqlite', 'exact-logic', 'exact-apple', 'exact-apple-update', 'exact-js', 'exact-js-bake', 'exact-linux', 'exact-painted', 'exact-web', 'exact-web-capabilities', 'exact-js-web', 'exact-game-bake', 'exact-game-render']);

/** Authored host crates own their identity. Otherwise package.json keeps the scaffold's prefix across directory
 * and display-name changes; a caller's name or the folder supplies it for an app without a package manifest. */
export function appCrateName(dir, fallback = basename(dir), title = null) {
  const kinds = ['web', ...new Set(Object.values(PLATFORMS)), 'ios', 'macos', 'tvos'];
  for (const kind of kinds) {
    const file = resolve(dir, kind, 'Cargo.toml');
    if (!existsSync(file)) continue;
    try {
      const name = Bun.TOML.parse(readFileSync(file, 'utf8')).package?.name;
      if (name?.endsWith(`-${kind}`)) return name.slice(0, -kind.length - 1);
    } catch { /* Cargo reports an invalid authored manifest. */ }
  }
  let name = fallback;
  const pkg = resolve(dir, 'package.json');
  if (existsSync(pkg)) {
    const declared = JSON.parse(readFileSync(pkg, 'utf8')).name;
    if (typeof declared === 'string' && declared.trim()) { name = declared; title = null; }
  }
  const normalize = value => {
    const slug = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
    return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  };
  const collides = prefix => kinds.some(kind => SDK_CRATES.has(`${prefix}-${kind}`));
  name = normalize(name);
  if (collides(name) && title !== null) name = normalize(title);
  return collides(name) ? `${name}-app` : name;
}
/** The platforms that hold an update store, so a stream (scripts/deploy.mjs), and Windows, whose host refuses every
 * store level but "0" (it has no update store yet, LLP 1115.004 D15) while an absent key reads as "A". */
const STORED = ['ios', 'macos', 'linux', 'windows'];

/** A verb's platform (`ios`, `mac`, `linux`, `android`, `windows`), or a drive's host (`test ios`); null for the web and
 * every other verb. */
export function platformOf(verb, host = 'web') {
  const word = ['test', 'agent', 'verify'].includes(verb) ? host : verb;
  return { ios: 'ios', share: 'ios', mac: 'macos', macos: 'macos', linux: 'linux', android: 'android', windows: 'windows' }[word] ?? null;
}

/** What `host.<platform>` holds when a verb names the platform: the scaffold's defaults for the two Apple platforms,
 * a desktop window's size for Windows (the host chooses its painter, LLP 1149 D12), nothing
 * for the others (each key may be empty, scripts/app.schema.json). */
const hostDefaults = (platform) => ({
  ios: { minimumOS: '17.0', deviceFamily: ['iphone', 'ipad'] },
  macos: { minimumOS: '14.0', window: { width: 900, height: 700 } },
  windows: { window: { width: 1024, height: 720, minWidth: 360, minHeight: 500 } },
}[platform] ?? {});

const readManifest = (dir) => JSON.parse(readFileSync(resolve(dir, 'app.json'), 'utf8'));
const writeManifest = (dir, manifest) => writeFileSync(resolve(dir, 'app.json'), JSON.stringify(manifest, null, 2) + '\n');

/** Whether the manifest names the platform. */
export const namesPlatform = (manifest, platform) => platform in (manifest.host ?? {});

/** Name `platform` in the app's manifest: `host.<platform>`, and its store for one that has a stream. Returns the
 * keys written, none when it was named already. */
export function namePlatform(dir, platform) {
  if (!(platform in PLATFORMS)) throw new Error(`${platform} is not a platform; the platforms are ${Object.keys(PLATFORMS).join(', ')}`);
  const manifest = readManifest(dir), wrote = [];
  manifest.host ??= {};
  if (!(platform in manifest.host)) { manifest.host[platform] = hostDefaults(platform); wrote.push(`host.${platform}`); }
  if (STORED.includes(platform)) {
    manifest.deploy ??= {};
    manifest.deploy.store ??= {};
    if (!(platform in manifest.deploy.store)) { manifest.deploy.store[platform] = '0'; wrote.push(`deploy.store.${platform}`); }
  }
  if (wrote.length) writeManifest(dir, manifest);
  return wrote;
}

/** Stop naming `platform`: its `host`, `deploy.store` and `deploy.binaries` keys go. Returns the keys removed. */
export function withoutPlatformKeys(dir, platform) {
  if (platform === 'web') throw new Error('update --without web: the web host is the dev loop\'s and the agent\'s (`web`, `test web`, `agent web`), so it stays');
  if (!(platform in PLATFORMS)) throw new Error(`update --without ${platform}: the platforms are ${Object.keys(PLATFORMS).join(', ')}`);
  const manifest = readManifest(dir), removed = [];
  for (const [key, table] of [['host', manifest.host], ['deploy.store', manifest.deploy?.store], ['deploy.binaries', manifest.deploy?.binaries]]) {
    if (table && platform in table) { delete table[platform]; removed.push(`${key}.${platform}`); }
  }
  if (removed.length) writeManifest(dir, manifest);
  return removed;
}

/** The crates the shells hold for a manifest: `web/` always (delivery's bake and the resident loop a native window
 * live-reloads from), and one per crate the named platforms share. Android has two: `android/`, the library the
 * Canvas reader's APK loads, and `linux/`, the Linux host built for Android, which `--headless` drives under adb. */
export function shellCrates(manifest) {
  return ['web', ...new Set(Object.keys(manifest.host ?? {}).filter(p => p in PLATFORMS).flatMap(p => p === 'android' ? ['linux', 'android'] : [PLATFORMS[p]]))];
}

/** A host crate's files, keyed by path under the crate's directory. `dep(path)` is a dependency's path from there and
 * `app` the app directory's, as Rust strings' content; `native` attaches the factory the bake writes for a package
 * that fills the native slot. */
function crateFiles(kind, { name, title, dep, app, native = false, preload = false }) {
  const header = (target) => `[package]
name = "${name}-${kind}"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false
build = "build.rs"

${target}

[dependencies]
`;
  const bake = (platform) => `fn main() {
    exact_js_bake::build(std::path::Path::new(${JSON.stringify(app)}), ${JSON.stringify(platform)}).unwrap_or_else(|error| {
        // What the bake found (tsc's and the compiler's diagnostics), as it is: no panic around it.
        eprintln!("{error}");
        std::process::exit(1);
    });
}
`;
  const module = (web) => web
    ? `type ExactEmbeddedData = exact_js_web::Module;
fn embedded_data() -> ExactEmbeddedData {
    exact_js_web::Module::new(APP, GRANTS, REVISION)
        .with_canvas_surfaces(CANVAS_SURFACES)
        .placed(TYPESCRIPT_PLACEMENT)
}
`
    : `type ExactEmbeddedData = exact_js::Placed<exact_js::Module>;
fn embedded_data() -> ExactEmbeddedData {
    exact_js::Module::new(APP_BYTECODE, APP, GRANTS)
${preload ? '        .with_preloads(PRELOAD)\n' : ''}        .with_canvas_surfaces(CANVAS_SURFACES)
${native ? '        .with_native(exact_native)\n' : ''}        .placed(TYPESCRIPT_PLACEMENT)
}
`;
  const includes = (plan) => `include!(concat!(env!("OUT_DIR"), "/module.rs"));
${plan ? `const PLAN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.plan"));
const COMPAT: &str = include_str!(concat!(env!("OUT_DIR"), "/compat.json"));
` : ''}`;
  const build = `[build-dependencies]
exact-js-bake = ${dep('js/bake')}
`;
  if (kind === 'web') return {
    'Cargo.toml': `${header('[lib]\ncrate-type = ["cdylib", "rlib"]')}exact-logic = ${dep('logic')}
exact-web = ${dep('host/web')}
exact-web-capabilities = ${dep('host/web-capabilities')}
exact-js-web = ${dep('js/web')}

${build}`,
    'build.rs': bake('web'),
    'src/lib.rs': `//! ${title} on the web: the Contract UI and the TypeScript data module.

${includes(true)}
${module(true)}include!(concat!(env!("OUT_DIR"), "/logic.rs"));
exact_web::host!(
    AppData,
    PLAN,
    COMPAT,
    app_data,
    [
        include_bytes!(concat!(env!("OUT_DIR"), "/app.module.json")) as &[u8],
        include_bytes!(concat!(env!("OUT_DIR"), "/app.js")) as &[u8]
    ]
);
`,
  };
  if (kind === 'apple') return {
    'Cargo.toml': `${header('[lib]\ncrate-type = ["rlib"]')}ibex2-sqlite = ${dep('vendor/ibex/crates/ibex2-sqlite')}
exact-logic = ${dep('logic')}
exact-apple = ${dep('host/apple')}
exact-apple-update = ${dep('host/apple-update')}
exact-js = ${dep('js')}

${build}`,
    'build.rs': appleBuildScript(app),
    // Names no app: a change to only its identity leaves the compiled archive fresh (linked-plan.mjs compiledBakeDir).
    'src/lib.rs': `//! The app on Apple: the Contract UI and the TypeScript data module.

${includes(false)}
${module(false)}include!(concat!(env!("OUT_DIR"), "/logic.rs"));
include!(concat!(env!("OUT_DIR"), "/linked.rs"));
// The host app.json's deploy.store names (with an update store, signed updates), and the plan it boots.
include!(concat!(env!("OUT_DIR"), "/host.rs"));
`,
  };
  if (kind === 'linux') return {
    'Cargo.toml': `${header(`[[bin]]\nname = "${name}-linux"\npath = "src/main.rs"`)}ibex2-sqlite = ${dep('vendor/ibex/crates/ibex2-sqlite')}
exact-logic = ${dep('logic')}
exact-linux = ${dep('host/linux')}
exact-painted = ${dep('host/painted')}
exact-js = ${dep('js')}

${build}`,
    'build.rs': bake('linux'),
    'src/main.rs': `//! ${title} on Linux (and Android): the Contract UI and the TypeScript data module.

${includes(true)}
${module(false)}include!(concat!(env!("OUT_DIR"), "/logic.rs"));
// The packages' Linux implementations the build composes (exact_packages()), and the app's Rust hatches
// (exact_hatches(), from modules/linux).
include!(concat!(env!("OUT_DIR"), "/packages.rs"));
include!(concat!(env!("OUT_DIR"), "/hatches.rs"));
fn main() {
    let composed = exact_painted::Composed { hatches: exact_hatches(), packages: exact_packages() };
    std::process::exit(exact_linux::run_composed::<AppData>(PLAN, COMPAT, composed));
}
`,
  };
  // The library the Canvas reader loads (LLP 1107, host/android/README.md), in Shelf's shape: empty off Android.
  if (kind === 'android') return {
    'Cargo.toml': `${header('[lib]\ncrate-type = ["cdylib"]\ntest = false\nbench = false').replace(/\n\[dependencies\]\n$/, '')}
[target.'cfg(target_os = "android")'.dependencies]
ibex2-sqlite = ${dep('vendor/ibex/crates/ibex2-sqlite')}
exact-logic = ${dep('logic')}
exact-painted = ${dep('host/painted')}
exact-js = ${dep('js')}

${build}`,
    'build.rs': `fn main() {
    exact_js_bake::build_android(std::path::Path::new(${JSON.stringify(app)})).unwrap_or_else(|error| {
        // What the bake found (tsc's and the compiler's diagnostics), as it is: no panic around it.
        eprintln!("{error}");
        std::process::exit(1);
    });
}
`,
    'src/lib.rs': `//! ${title} on Android: the Contract UI and the TypeScript data module, in the library
//! exact2's Canvas reader loads (\`bun exact.mjs android\` builds the APK).

#[cfg(target_os = "android")]
mod android {
    #[allow(dead_code)]
    mod baked {
        include!(concat!(env!("OUT_DIR"), "/module.rs"));
    }
    use baked::*;

    ${module(false).replace(/\n(?=.)/g, '\n    ')}    include!(concat!(env!("OUT_DIR"), "/logic.rs"));
    include!(concat!(env!("OUT_DIR"), "/hatches.rs"));

    exact_painted::canvas_jni!(super::AppData, hatches = crate::android::exact_hatches());
}
`,
  };
  if (kind === 'windows') return {
    'Cargo.toml': `${header(`[[bin]]\nname = "${name}-windows"\npath = "src/main.rs"\ntest = false\nbench = false`)}ibex2-sqlite = ${dep('vendor/ibex/crates/ibex2-sqlite')}
exact-logic = ${dep('logic')}
exact-windows = ${dep('host/windows')}
# The packages' Windows implementations name \`exact_painted::package\` (LLP 1133.022 D10 item 5).
exact-painted = ${dep('host/painted')}
exact-js = ${dep('js')}

${build}`,
    'build.rs': bake('windows'),
    // A GUI executable in every profile, as Excord's: opened from Explorer or the desktop, a development build shows
    // no console window beside its own; a parent's handles still carry its stderr.
    'src/main.rs': `//! ${title} on Windows: the host's window over the app's TypeScript data module and its baked plan.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

${includes(true)}
${module(false)}include!(concat!(env!("OUT_DIR"), "/logic.rs"));
// The packages' Windows implementations the build composes (exact_packages()), and the app's Rust hatches
// (exact_hatches(), from modules/windows or else modules/linux).
include!(concat!(env!("OUT_DIR"), "/packages.rs"));
include!(concat!(env!("OUT_DIR"), "/hatches.rs"));
fn main() {
    let composed = exact_painted::Composed { hatches: exact_hatches(), packages: exact_packages() };
    std::process::exit(exact_windows::run_composed::<AppData>(${JSON.stringify(title)}, window(), PLAN, COMPAT, composed));
}
`,
  };
  throw new Error(`no host crate of kind ${kind}`);
}

/** A host crate's files for an authored workspace: the crate at `<dir>/<kind>`, the app one level up. `update` writes
 * `linux/` into an older authored app with it (game/new.mjs). */
export const authoredCrate = (dir, kind, name, title) =>
  Object.fromEntries(Object.entries(crateFiles(kind, { name, title, app: '..', dep: path => `{ path = ${JSON.stringify(pathFrom(resolve(dir, kind), resolve(ROOT, path)))} }` })).map(([file, text]) => [`${kind}/${file}`, text]));

/** For each host crate, its build script as `.exact/shells/` writes it and as it reads beside app.json: a crate copied up
 * (LLP 1153 D1.4) whose script is still the first gets the second from `update` (game/new.mjs). */
export const copiedBuildScripts = () => Object.fromEntries(Object.values(PLATFORMS).concat('web').filter((kind, i, all) => all.indexOf(kind) === i)
  .map(kind => [kind, ['../../..', '..'].map(app => crateFiles(kind, { name: 'app', title: 'App', app, dep: () => '' })['build.rs'])]));

/** How a generated workspace at `from` names a path in this checkout: always relative, with `/`. Unlike an authored
 * workspace's (`pathFrom`), it is rewritten when the app or the checkout moves (its stamp names both), and a deploy's
 * capture keeps the two trees' relative places, where a path into the live checkout would leave the capture. */
const pathWithin = (from, to) =>
  (relative(realpathSync(from), existsSync(to) ? realpathSync(to) : resolve(to)) || '.').split(sep).join('/');

const titleOf = name => name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const stampOf = (shells) => { try { return JSON.parse(readFileSync(resolve(shells, '.stamp.json'), 'utf8')); } catch { return null; } };

/** Write a file only when its bytes differ, so Cargo's times stay. */
function writeChanged(path, text) {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/** The refusal of a crate whose `package` (`declared`) does not name `workspace`, so the app owns `owns`, or null.
 * Cargo requires a member outside the workspace root to name the root
 * (https://doc.rust-lang.org/cargo/reference/manifest.html#the-workspace-field); a game's crates name `.shells/`, an
 * app's the generated workspaces (LLP 1153.003 D1.1). */
export function memberRefusal(manifest, declared, workspace, owns) {
  return declared?.workspace?.replace(/\/+$/, '') === workspace ? null : `${manifest}: set package.workspace = "${workspace}" so the app owns ${owns}`;
}

/** The app's own crates (LLP 1153.003 D1.1), as `appCrates` lists them, by the generated workspace each joins:
 * `{ host, gpu }`. A crate that joins neither is refused with the line to add, and one that takes the name of a
 * crate exact2 generates for the app with the escape for an app that writes its host crates (D3). */
export function appMembers(dir, name) {
  const crates = appCrates(dir), loose = crates.find(crate => !crate.joins);
  if (loose) throw new Error(notAMember(loose));
  const generated = new Set(['web', ...Object.values(PLATFORMS)].map(kind => `${name}-${kind}`));
  const taken = crates.find(crate => generated.has(crate.name));
  if (taken) throw new Error(`${taken.manifest}: ${taken.name} is a host crate's name, and exact2 writes the app's host crates under .exact/shells/. Rename the crate, or, for an app that writes its own host crates, write their workspace (docs/reference.md, "An authored workspace").`);
  return { host: crates.filter(crate => crate.joins === 'host'), gpu: crates.filter(crate => crate.joins === 'gpu') };
}

/** Generated beside app.json for an app with crates of its own (LLP 1153.003 D1.5): rustup and Cargo find these by
 * searching up from the working directory, so `cargo test` in `data/` uses exact2's compiler and the app's `target/`.
 * Each is rewritten only while it is still the generated one (its first line), and listed in the app's .gitignore. */
const BESIDE = '# Generated by exact2 for the app\'s own crates (LLP 1153.003 D1.5); rewritten with .exact/shells/, never edited.\n';
function besideApp(dir, wanted) {
  const files = { 'rust-toolchain.toml': () => BESIDE + readFileSync(resolve(ROOT, 'rust-toolchain.toml'), 'utf8'),
    '.cargo/config.toml': () => `${BESIDE}${readFileSync(resolve(ROOT, '.cargo/config.toml'), 'utf8').trimEnd()}\n\n[build]\ntarget-dir = "target"\n` };
  for (const [file, text] of Object.entries(files)) {
    const path = resolve(dir, file), generated = !existsSync(path) || readFileSync(path, 'utf8').startsWith(BESIDE);
    if (!generated) {
      if (wanted) throw new Error(`${path}: the app's crates build with exact2's ${file === 'rust-toolchain.toml' ? 'toolchain' : 'Cargo configuration'}, which exact2 writes there; move this one aside (LLP 1153.003 D1.5)`);
      continue;
    }
    if (wanted) writeChanged(path, text());
    else rmSync(path, { force: true });
  }
  if (!wanted) return;
  const ignore = resolve(dir, '.gitignore'), had = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = Object.keys(files).map(file => `/${file}`).filter(line => !had.split('\n').includes(line));
  if (missing.length) writeFileSync(ignore, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/** The generated workspace for the app at `dir`, current with its inputs: the manifest's platforms and name, the app's
 * own crates, the checkout's path and the files the workspace copies from it, and this module. Returns the workspace
 * directory and whether anything was written. The crates are `<name>-<kind>`, with the prefix `appCrateName` reads.
 * Its lock is the app's captured `Cargo.lock` when it has one (LLP 1153.003 D1.4), copied in; otherwise exact2's,
 * re-resolved offline for these members, and one this machine's cache cannot resolve is left as the copy for the
 * build, which `settleLock` resolves. */
export function ensureShells(dir, manifest = readManifest(dir), name = null) {
  dir = realpathSync(dir);
  name = appCrateName(dir, name ?? basename(dir));
  const shells = shellsDir(dir), title = manifest.app?.name ?? manifest.name ?? titleOf(name);
  // The package that fills the native slot (LLP 1154 D3); the bake refuses two.
  const crates = shellCrates(manifest), native = nativePackages(dir).map(p => p.name), members = appMembers(dir, name);
  // The paths written are relative (`pathWithin`), which reads real directories.
  for (const kind of crates) mkdirSync(resolve(shells, kind), { recursive: true });
  const copied = ['rust-toolchain.toml', '.cargo/config.toml'].map(file => [file, readFileSync(resolve(ROOT, file), 'utf8')]);
  const patches = patchLines(shells, pathWithin);
  const own = members.host.map(member => pathWithin(shells, member.dir));
  // The inputs whose change rewrites the workspace: the app's path, the checkout's and its commit, the templates (this
  // module), the files copied from the checkout, its patch table and its lock (a dependency the SDK moved), the
  // manifest's platforms, the app's name, its own crates and the package that fills the native slot.
  const commit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const stamp = {
    exact2: ROOT, app: dir, commit, name, title, crates, native, members: own,
    ...(Object.keys(manifest.preload ?? {}).length ? { preload: true } : {}),
    inputs: createHash('sha256').update([readFileSync(fileURLToPath(import.meta.url), 'utf8'), APPLE_BUILD_SCRIPT, ...copied.map(([, text]) => text), ...patches, readFileSync(resolve(ROOT, 'Cargo.lock'), 'utf8')].join('\0')).digest('hex'),
  };
  besideApp(dir, members.host.length + members.gpu.length > 0);
  const captured = resolve(dir, 'Cargo.lock'), before = stampOf(shells);
  const expected = ['Cargo.toml', 'Cargo.lock', ...copied.map(([file]) => file), ...crates.flatMap(kind => Object.keys(crateFiles(kind, { name, title, dep: () => '', app: '' })).map(file => `${kind}/${file}`))];
  const complete = expected.every(file => existsSync(resolve(shells, file)));
  if (before && JSON.stringify(before) === JSON.stringify(stamp) && complete) {
    // The captured lock is the workspace's whenever it changed (`bun exact.mjs lock`, a pull).
    if (existsSync(captured)) writeChanged(resolve(shells, 'Cargo.lock'), readFileSync(captured, 'utf8'));
    return { workspace: shells, wrote: false, crates };
  }
  const dependency = path => `{ path = ${JSON.stringify(pathWithin(shells, resolve(ROOT, path)))} }`;
  let wrote = writeChanged(resolve(shells, 'Cargo.toml'), `# ${title}'s native workspace, generated by exact2 from app.json and the app's own crates (LLP 1153 D1,
# LLP 1153.003 D1): never edited, rewritten when the manifest's platforms, the app's crates or the checkout change. A
# crate beside app.json joins it with package.workspace = "${MEMBER_OF.host}".
[workspace]
members = [${[...crates, ...own].map(c => JSON.stringify(c)).join(', ')}]
resolver = "2"

[workspace.package]
edition = "2021"
version = "0.1.0"
license = "MIT"

# What the app's own crates may take from exact2 (\`exact-runner.workspace = true\`).
[workspace.dependencies]
exact-runner = ${dependency('runner')}
contract = ${dependency('contract/cli')}

[patch.crates-io]
${patches.join('\n')}
`);
  for (const [file, text] of copied) wrote = writeChanged(resolve(shells, file), text) || wrote;
  for (const kind of crates) {
    const files = crateFiles(kind, { name, title, native: native.length > 0, preload: Object.keys(manifest.preload ?? {}).length > 0, app: '../../..', dep: path => `{ path = ${JSON.stringify(pathWithin(resolve(shells, kind), resolve(ROOT, path)))} }` });
    for (const [file, text] of Object.entries(files)) wrote = writeChanged(resolve(shells, kind, file), text) || wrote;
  }
  // A crate for a platform no longer named goes with its platform.
  for (const entry of readdirSync(shells, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.values(PLATFORMS).concat('web').includes(entry.name) && !crates.includes(entry.name)) { rmSync(resolve(shells, entry.name), { recursive: true, force: true }); wrote = true; }
  }
  // The lock follows every change. A captured one is the workspace's and is never replaced by exact2's (D1.4).
  if (existsSync(captured)) writeChanged(resolve(shells, 'Cargo.lock'), readFileSync(captured, 'utf8'));
  else {
    writeFileSync(resolve(shells, 'Cargo.lock'), readFileSync(resolve(ROOT, 'Cargo.lock')));
    const lock = spawnSync('cargo', ['metadata', '--offline', '--format-version', '1'], { cwd: shells, env: cargoEnvironment(), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (lock.error?.code === 'ENOENT') throw new Error('cargo was not found on PATH or in ~/.cargo/bin; install Rust with rustup (https://rustup.rs)');
    // Cargo may have rewritten the lock before failing to download; `settleLock` recognises exact2's bytes.
    if (lock.status !== 0) writeFileSync(resolve(shells, 'Cargo.lock'), readFileSync(resolve(ROOT, 'Cargo.lock')));
  }
  writeFileSync(resolve(shells, '.stamp.json'), JSON.stringify(stamp) + '\n');
  return { workspace: shells, wrote: true, crates };
}

/** Each package a lock holds from a registry or git that `sdk` (exact2's lock) does not hold at that version and
 * checksum: what an app's own crates added (LLP 1153.003 D1.4). Path packages are exact2's or the app's own. */
export function outsideExact2(lock, sdk) {
  const paths = new Set((Bun.TOML.parse(lock).package ?? []).filter(pkg => !pkg.source).map(pkg => pkg.name));
  return outsideSdkLock(lock, sdk, paths);
}
const listed = (items, most = 6) => items.length > most ? `${items.slice(0, most).join(', ')}, … (${items.length} in all)` : items.join(', ');

/** The generated workspace's lock settled for a build (LLP 1153.003 D1.4), and its locked metadata. The app's captured
 * lock (`captured`, beside app.json) must match its crates: a build never changes it. Without one, the lock derived
 * from exact2's stands while it is current and holds nothing exact2's lacks; otherwise it is derived again, fetching
 * only what this machine's cache lacks, and a derivation that needs a version exact2's lock does not hold is refused,
 * since only `bun exact.mjs lock` captures a lock. */
export function settleLock(dir, workspace, captured = resolve(dir, 'Cargo.lock')) {
  const shell = resolve(workspace, 'Cargo.lock'), sdk = readFileSync(resolve(ROOT, 'Cargo.lock'), 'utf8');
  const relock = `\`bun exact.mjs lock\` in ${dir}`;
  if (existsSync(captured)) {
    writeChanged(shell, readFileSync(captured, 'utf8'));
    const result = lockedMetadata(workspace);
    if (result.status === 0) return JSON.parse(result.stdout);
    throw new Error(staleLock(result.stderr)
      ? `${captured} does not match the app's crates (a dependency or member changed since it was captured), and a build never changes it: ${relock} resolves it again.\n${result.stderr.trim()}`
      : `cargo metadata --locked --offline in ${workspace}:\n${result.stderr || result.error?.message}`);
  }
  const derived = existsSync(shell) ? readFileSync(shell, 'utf8') : sdk;
  if (!outsideExact2(derived, sdk).length) {
    const result = lockedMetadata(workspace);
    if (result.status === 0) return JSON.parse(result.stdout);
  }
  writeFileSync(shell, sdk);
  const options = { cwd: workspace, env: cargoEnvironment(), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' };
  let resolved = spawnSync('cargo', ['metadata', '--offline', '--format-version', '1'], options);
  if (resolved.status !== 0) {
    console.error(`${workspace}: resolving its lock from exact2's, fetching what Cargo's cache lacks (cargo metadata)`);
    resolved = spawnSync('cargo', ['metadata', '--format-version', '1'], options);
  }
  const outside = resolved.status === 0 ? outsideExact2(readFileSync(shell, 'utf8'), sdk) : [];
  if (resolved.status !== 0 || outside.length) writeFileSync(shell, sdk);
  if (resolved.status !== 0) throw new Error(`cargo metadata in ${workspace}:\n${resolved.stderr || resolved.error?.message}`);
  if (outside.length) throw new Error(`${dir}: the app's crates need versions exact2's lock does not hold (${listed(outside)}). An app whose crates add dependencies commits a lock of its own: ${relock} captures it.`);
  const result = lockedMetadata(workspace);
  if (result.status !== 0) throw new Error(`cargo metadata --locked --offline in ${workspace}:\n${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

/** `bun exact.mjs lock` for a generated workspace (LLP 1153.003 D1.4): resolve it again with exact2's lock deciding
 * every crate it names and the captured lock (`captured`) the rest, fetching what the graph lacks, and capture the
 * result when it leaves exact2's lock or a lock was captured before. What it did, as a line. */
export function lockShells(dir, workspace, captured = resolve(dir, 'Cargo.lock')) {
  const shell = resolve(workspace, 'Cargo.lock'), sdk = readFileSync(resolve(ROOT, 'Cargo.lock'), 'utf8');
  const before = existsSync(captured) ? readFileSync(captured, 'utf8') : null;
  writeFileSync(shell, before === null ? sdk : lockSeed(sdk, before));
  const options = { cwd: workspace, env: cargoEnvironment(), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' };
  let result = spawnSync('cargo', ['metadata', '--offline', '--format-version', '1'], options);
  if (result.status !== 0) {
    console.error(`${workspace}: fetching what Cargo's cache lacks to resolve the app's lock`);
    result = spawnSync('cargo', ['metadata', '--format-version', '1'], options);
  }
  if (result.status !== 0) {
    if (before !== null) writeFileSync(shell, before);
    throw new Error(`could not resolve ${captured}: ${result.stderr || result.error?.message}`);
  }
  const after = readFileSync(shell, 'utf8');
  if (before === null && !outsideExact2(after, sdk).length) return `${dir} resolves against exact2's lock; its crates add nothing, so it commits no lock of its own`;
  writeChanged(captured, after);
  const changes = lockChanges(before, after);
  return before === null ? `${captured}: captured (${(Bun.TOML.parse(after).package ?? []).length} packages); commit it`
    : `${captured}: ${changes.length ? `resolved\n${changes.join('\n')}` : 'current; no changes'}`;
}

/** What a native verb does before its build (LLP 1153 D1.2): when the manifest does not name `platform`, check that
 * platform's setup rows (`report`: the rows, or `{ error }` when they could not be read) and stop on a missing one,
 * nothing written; then name it, writing an app.json the app lacked. Then keep the generated workspace current unless
 * the app authored one (`ensureShells`). Returns the lines to say, or `{ refused }`. */
export async function bringPlatform(dir, platform, { report = null, os = process.platform, name = null } = {}) {
  const lines = [], verb = `bun exact.mjs ${platform === 'macos' ? 'mac' : platform}`;
  const manifest = existsSync(resolve(dir, 'app.json')) ? readManifest(dir) : null;
  if (!namesPlatform(manifest ?? {}, platform)) {
    if (platform === 'ios' && !['darwin', 'linux'].includes(os)) return { refused: `${verb}: iOS builds need macOS or Linux (use WSL on Windows); nothing was written` };
    if (platform === 'macos' && os !== 'darwin') return { refused: `${verb}: an Apple build needs a Mac with Xcode; nothing was written` };
    if (platform === 'windows' && os !== 'win32') return { refused: `${verb}: a Windows build needs Windows with the MSVC Rust target; nothing was written` };
    if (report?.error) return { refused: `${verb}: the setup report could not be read, so nothing was written: ${report.error}` };
    const missing = (report ?? []).filter(row => !row.ok);
    if (missing.length) return { refused: `${verb}: this machine lacks what a ${platform} build needs; nothing was written:\n${missing.map(row => `  ${row.name}: ${row.have} (SDK ${row.want})\n    ${row.fix}`).join('\n')}` };
    if (!manifest) {
      // An app without app.json had the defaults scripts/app.mjs `readManifest` supplies; naming a platform writes them.
      const app = name ?? basename(dir), title = titleOf(app);
      writeManifest(dir, { name: title, app: { id: `com.exact.${app}`, name: title }, host: { web: {} }, deploy: { store: { web: '0' } } });
      lines.push('app.json: written with the defaults the app had without one');
    }
    const wrote = namePlatform(dir, platform);
    if (wrote.length) lines.push(`app.json: ${wrote.join(', ')} added: the app now ships ${platform} (bun exact.mjs update --without ${platform} stops it)`);
  }
  if (!authoredWorkspace(dir)) {
    const { workspace, wrote, crates } = ensureShells(dir, undefined, name);
    if (wrote) lines.push(`${workspace}: the native workspace (${crates.join(', ')}), generated from app.json`);
  }
  return { lines };
}

// By name and semver series (Cargo's compatibility: 1.x, 0.37.x, 0.0.3): one
// graph holds at most one version of a package per series.
export const series = version => { const [major, minor, patch] = String(version).split('.'); return major !== '0' ? major : minor !== '0' ? `0.${minor}` : `0.0.${patch}`; };
export const seriesId = block => `${/^name = "([^"]+)"/m.exec(block)?.[1]} ${series(/^version = "([^"]+)"/m.exec(block)?.[1])}`;
export const lockBlocks = text => text.split(/\n(?=\[\[package\]\]\n)/).slice(1).map(block => block.trimEnd());

/** `lock`'s starting point for a workspace with its own lock (LLP 1046.011 D2, LLP 1153.003 D1.4): the
 * SDK lock decides every name and series it holds, a same-series bump included,
 * and the captured lock keeps the rest (its own packages, git and path ones too),
 * so Cargo prefers exactly these versions and fetches only what they lack. */
export function lockSeed(sdk, own) {
  // The same crate from another source (a git fork, a path) is another package:
  // the SDK's supersedes only its own source's, whatever the git revision.
  const key = block => `${seriesId(block)} ${/^source = "([^"#]*)/m.exec(block)?.[1] ?? ''}`;
  const held = new Set(lockBlocks(sdk).map(key));
  const kept = lockBlocks(own).filter(block => !held.has(key(block)));
  return kept.length ? `${sdk.trimEnd()}\n\n${kept.join('\n\n')}\n` : sdk;
}

// A lock's packages by identity. Dependency edges follow from the versions
// and the activated features, so a workspace's subset keeps every version but may
// drop edges; the versions and checksums are what the SDK lock decides.
const lockIds = text => new Map((Bun.TOML.parse(text).package ?? []).map(pkg => [`${pkg.name} ${pkg.version} ${pkg.source ?? ''}`.trim(), pkg.checksum ?? null]));
/** Packages of `derived` (members excepted) whose version the SDK lock does not hold.
 * A root path crate new since the SDK lock is held through `withRootPins`. */
export function outsideSdkLock(derived, sdk, members) {
  const known = lockIds(sdk);
  return [...lockIds(derived)].filter(([id, checksum]) => !members.has(id.split(' ')[0]) && (!known.has(id) || known.get(id) !== checksum)).map(([id]) => id);
}

/** What a lock refresh changed, by package name, for `lock` to print: the
 * versions (or a git or path package's source) that moved, then what was
 * added, then what was removed; with none of those, the dependencies a package
 * gained or lost (Cargo rewrites them when a manifest gains or drops a package the lock already holds). */
export function lockChanges(before, after) {
  // As an author reads a package: its version, and where it comes from unless crates.io.
  const shown = pkg => `${pkg.version}${!pkg.source ? ' (path)' : pkg.source === CRATES_IO ? '' : ` (${pkg.source})`}`;
  const read = text => (text ? Bun.TOML.parse(text).package ?? [] : []).reduce((map, pkg) => map.set(pkg.name, [...(map.get(pkg.name) ?? []), shown(pkg)].sort()), new Map());
  const was = read(before), now = read(after), moved = [], added = [];
  for (const [name, versions] of now) {
    const old = was.get(name);
    if (!old) added.push(`added ${name} ${versions.join(', ')}`);
    else if (old.join() !== versions.join()) moved.push(`${name} ${old.join(', ')} → ${versions.join(', ')}`);
  }
  const changes = [...moved, ...added, ...[...was].filter(([name]) => !now.has(name)).map(([name, versions]) => `removed ${name} ${versions.join(', ')}`)];
  if (changes.length) return changes;
  const lists = text => new Map((text ? Bun.TOML.parse(text).package ?? [] : []).map(pkg => [`${pkg.name} ${shown(pkg)}`, pkg.dependencies ?? []]));
  const had = lists(before);
  return [...lists(after)].flatMap(([pkg, deps]) => [...deps.filter(dep => !had.get(pkg)?.includes(dep)).map(dep => `${pkg} now depends on ${dep}`),
    ...(had.get(pkg) ?? []).filter(dep => !deps.includes(dep)).map(dep => `${pkg} no longer depends on ${dep}`)]);
}
export const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

/** Whether Cargo refused a locked graph because the lock no longer matches the
 * manifests, a lock to refresh, rather than for a crate missing from its cache. */
export const staleLock = stderr => /cannot update the lock file|lock file \S+ needs to be updated/.test(stderr ?? '');
