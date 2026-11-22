//! `controls` rows (LLP 1126.004 D1, D3): checked against the plan, stored
//! on it with their tool's walked effects, and refused where a press could
//! not run them.

use serde_json::{json, Value as Json};
#[cfg(unix)]
use std::os::unix::fs::symlink as symlink_dir;
#[cfg(windows)]
use std::os::windows::fs::symlink_dir;
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"use getUserMedia, setTrackEnabled, MediaStream, MediaStreamTrack from "@exact/media-capture"
use startMediaRecorder as record, MediaRecorderInfo from "@exact/recording"

routes nav
  home "/"
  take "/take/:id"

shape Started
  id: string
shape Rec
  startedAt: number

component App
  derive current = top(nav)
  state on = false
  state cam = false
  mutation activity as shape Started
  mutation opened as shape MediaStream then arm
  mutation started as shape MediaRecorderInfo
  mutation enabled as shape MediaStreamTrack
  tool capture writes "Record an idea." = capture
  tool glance writes "Start the activity." = glance
  tool film writes "Film." = film
  tool maybe writes "Maybe film." = maybe
  tool resume writes "Resume." = resume
  tool mute writes "Mute." = mute
  tool plain writes "Toggle." = plain
  tool wipe destroys "Wipe." = wipe
  tool named writes "Named." = named
  tool optional writes "Optional." = optional
  action capture
    send activity = startActivity("recording", Rec(startedAt=0))
    send opened = getUserMedia(audio=true)
  action arm
    match opened
      case some(s)
        send started = record(stream=s.id, path="app:/data/takes/a")
      case none
        on = false
  action glance
    if on
      send activity = startActivity(`r${on}`, Rec(startedAt=1))
    else
      relay()
  action relay
    send activity = updateActivity("a", Rec(startedAt=2))
  action film
    send opened = getUserMedia(video=true, audio=false)
  action maybe
    send opened = getUserMedia(video=cam)
  action resume
    send enabled = setTrackEnabled(track="t", enabled=true)
  action mute
    send enabled = setTrackEnabled(track="t", enabled=false)
  action plain
    on = not on
  action wipe
    on = false
  action named(n: number)
    on = n > 0
  action optional(n: option<number>)
    on = n != none
  action follow(url: string)
    nav = go(nav, url)
  view
    main navigationKey=`${current.id}` navigate=follow
      text "App"
"#;

struct App(PathBuf);
impl App {
    fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("exact-controls-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let packages = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages");
        std::fs::create_dir_all(path.join("node_modules/@exact")).unwrap();
        for package in ["media-capture", "recording"] {
            let to = packages.join(package).canonicalize().unwrap();
            symlink_dir(to, path.join("node_modules/@exact").join(package)).unwrap();
        }
        std::fs::write(path.join("app.contract"), SOURCE).unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn compile(&self, manifest: Json) -> Result<exact_plan::Plan, String> {
        let mut app = json!({ "app": { "id": "com.exact.controls", "name": "Controls" } });
        app.as_object_mut()
            .unwrap()
            .extend(manifest.as_object().unwrap().clone());
        std::fs::write(self.0.join("app.json"), app.to_string()).unwrap();
        contract::compile_path_all(&self.0.join("app.contract"), false)
            .map(|(plan, _)| plan)
            .map_err(|e| format!("{e:?}"))
    }
}
impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn control(kind: &str, tool: &str) -> Json {
    json!({ "kind": kind, "title": "Go", "symbol": "mic.fill", "tool": tool })
}

/// Each control's stored effects, by kind.
fn effects(plan: &exact_plan::Plan) -> Vec<(String, Json)> {
    (plan.controls.iter())
        .map(|c| {
            let effects = serde_json::from_str(plan.str(c.effects)).unwrap();
            (plan.str(c.kind).to_owned(), effects)
        })
        .collect()
}

#[test]
fn the_walk_follows_branches_calls_and_thens_through_resolved_names() {
    let app = App::new("walk");
    let tools = [
        "capture", "glance", "film", "maybe", "resume", "mute", "plain", "optional",
    ];
    let rows: Vec<Json> = tools.iter().map(|t| control(t, t)).collect();
    let plan = app
        .compile(json!({ "controls": rows }))
        .unwrap_or_else(|e| panic!("{e}"));
    let all = effects(&plan);
    let of = |kind: &str| &all.iter().find(|(k, _)| k == kind).unwrap().1;
    let capture = of("capture");
    assert_eq!(capture["activity"], json!(["start"]));
    assert_eq!(capture["activityKinds"], json!(["recording"]));
    assert_eq!(capture["audio"], "known");
    assert_eq!(
        capture["camera"], "none",
        "video left out asks for no camera"
    );
    assert_eq!(
        capture["recorder"], true,
        "the recorder starts in `opened`'s then, under its alias"
    );
    let glance = of("glance");
    assert_eq!(
        glance["activity"],
        json!(["start", "update"]),
        "both branches, and the call's body"
    );
    assert_eq!(glance["dynamicKind"], true);
    assert_eq!(glance["recorder"], false);
    assert_eq!(of("film")["camera"], "known");
    assert_eq!(of("film")["audio"], "none");
    assert_eq!(of("maybe")["camera"], "possible", "an unread argument may");
    assert_eq!(of("resume")["restart"], true);
    assert_eq!(
        of("mute")["restart"],
        false,
        "disabling a track restarts nothing"
    );
    let plain = of("plain");
    assert!(!contract::controls::captures(plain));
    assert_eq!(plain["activity"], json!([]));

    let row = |kind: &str| {
        plan.controls
            .iter()
            .find(|c| plan.str(c.kind) == kind)
            .unwrap()
    };
    let tool = row("optional").tool.unwrap();
    assert_eq!(plan.str(plan.tools[tool.0 as usize].name), "optional");
    assert_eq!(plan.str(row("plain").digest).len(), 64);
    assert_ne!(
        plan.str(row("plain").digest),
        plan.str(row("optional").digest)
    );
}

#[test]
fn the_digest_covers_the_row_the_signature_and_the_effects() {
    let app = App::new("digest");
    let digest = |row: Json| {
        let plan = app.compile(json!({ "controls": [row] })).unwrap();
        plan.str(plan.controls[0].digest).to_owned()
    };
    let first = digest(control("go", "plain"));
    assert_eq!(first, digest(control("go", "plain")), "stable");
    let titled = json!({ "kind": "go", "title": "Toggle", "symbol": "mic.fill", "tool": "plain" });
    assert_ne!(first, digest(titled), "the title is compiled in");
    let unlocked = json!({ "kind": "go", "title": "Go", "symbol": "mic.fill", "tool": "plain", "authentication": "always" });
    assert_ne!(first, digest(unlocked), "so is the lock policy");
    assert_ne!(first, digest(control("go", "glance")), "and the tool");
}

#[test]
fn a_url_control_opens_a_declared_route() {
    let app = App::new("url");
    let url = |url: &str| {
        app.compile(json!({ "controls": [{ "kind": "open", "title": "Open", "symbol": "house", "url": url }] }))
    };
    let plan = url("/take/7").unwrap_or_else(|e| panic!("{e}"));
    let row = &plan.controls[0];
    assert!(row.tool.is_none());
    assert_eq!(plan.str(row.url), "/take/7");
    assert_eq!(plan.str(row.effects), "{}");
    let refused = url("/nowhere").unwrap_err();
    assert!(refused.contains("control-url"), "{refused}");
}

#[test]
fn a_control_is_refused_where_a_press_could_not_run_it() {
    let app = App::new("refused");
    let refused = |rows: Json, id: &str| {
        let errors = app.compile(json!({ "controls": rows })).unwrap_err();
        assert!(errors.contains(id), "{id}: {errors}");
    };
    refused(json!([control("x", "nothing")]), "control-tool");
    refused(json!([control("x", "wipe")]), "control-destroys");
    refused(json!([control("x", "named")]), "control-arguments");
    refused(
        json!([control("x", "plain"), control("X", "glance")]),
        "repeats X",
    );
    let both = json!([{ "kind": "x", "title": "X", "symbol": "s", "tool": "plain", "url": "/" }]);
    refused(both, "exactly one of");
    let untitled = json!([{ "kind": "x", "symbol": "s", "tool": "plain" }]);
    refused(untitled, "title is required");
    let url_lock = json!([{ "kind": "x", "title": "X", "symbol": "s", "url": "/", "authentication": "always" }]);
    refused(url_lock, "applies to a tool control");
    let bad_kind = json!([{ "kind": "a b", "title": "X", "symbol": "s", "tool": "plain" }]);
    refused(bad_kind, "must be an identifier");
    // Two controls may bind one tool and keep their identities.
    let plan = app
        .compile(json!({ "controls": [control("a", "plain"), control("b", "plain")] }))
        .unwrap();
    assert_eq!(plan.controls.len(), 2);
}

#[test]
fn a_face_whose_tool_captures_is_pointed_at_controls() {
    let app = App::new("face");
    let face = |tool: &str| {
        let tools = json!({ tool: { "title": "Go", "doors": ["apple"] } });
        app.compile(json!({ "intents": { "tools": tools } }))
    };
    for tool in ["capture", "film", "maybe", "resume"] {
        let errors = face(tool).unwrap_err();
        assert!(errors.contains("intents-capture-face"), "{tool}: {errors}");
    }
    face("glance").unwrap_or_else(|e| panic!("an activity alone is no capture: {e}"));
}
