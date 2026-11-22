//! Controls (LLP 1126.004): each `controls` row of `app.json` checked
//! against the plan and stored on it with what its tool can do.
//!
//! A tool's effects are walked from its action through the calls the plan
//! holds inline, every branch, and the `then` of every mutation it sends,
//! transitively (D3). A send is classified by what it resolves to: the
//! reserved ActivityKit sends by operation, and a package name by its
//! package and declared name, so an aliased `use` is still seen: every
//! name a package grants the microphone, camera or screen to, except those
//! that only use a track already open (`applyConstraints`, a recognition
//! of a `track`). A media
//! argument the walk cannot read as a literal counts as possibly set.
//! `faces::tool_signature`'s `sends` bit says only whether there is a send.

use crate::manifest::{Control, ControlAction};
use contract_syntax::{Component, Expr, Stmt};
use exact_plan::{Plan, ToolsId};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};

/// How surely a capture kind is in a tool's reach. Ordered: a reach is
/// the strongest of its sends'.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
enum Level {
    #[default]
    None,
    /// An argument the walk cannot read may ask for it.
    Possible,
    /// A literal asks for it.
    Known,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::Possible => "possible",
            Level::Known => "known",
        }
    }
}

#[derive(Default)]
struct Reach {
    /// `start`, `update`, `end`.
    activity: BTreeSet<&'static str>,
    /// The literal kinds a `startActivity` names.
    kinds: BTreeSet<String>,
    /// A `startActivity` whose kind is not a literal.
    dynamic_kind: bool,
    audio: Level,
    camera: Level,
    display: Level,
    /// `startMediaRecorder`: records a stream whose tracks only the run
    /// knows.
    recorder: bool,
    /// `resumeMediaRecorder` or `setTrackEnabled`: may restart capture.
    restart: bool,
}

/// The effects of the action named `action` in the expanded root, as the
/// plan stores them on a control and the bake derives conformances from:
/// `{activity, activityKinds, dynamicKind, audio, camera, display,
/// recorder, restart}`, each capture kind `none`, `possible` or `known`.
pub fn effects(root: &Component, plan: &Plan, action: &str) -> Value {
    let mut reach = Reach::default();
    let mut seen = HashSet::new();
    let mut next = vec![action.to_owned()];
    while let Some(name) = next.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(a) = root.actions.iter().find(|a| a.name == name) {
            walk(&a.body, root, plan, &mut reach, &mut next);
        }
    }
    json!({
        "activity": reach.activity,
        "activityKinds": reach.kinds,
        "dynamicKind": reach.dynamic_kind,
        "audio": reach.audio.word(),
        "camera": reach.camera.word(),
        "display": reach.display.word(),
        "recorder": reach.recorder,
        "restart": reach.restart,
    })
}

/// Whether `effects` can start or restart a capture: a discoverable face's
/// call is refused it (LLP 1133.009 D9), and only a control's press may
/// start audio (D3).
pub fn captures(effects: &Value) -> bool {
    ["audio", "camera", "display"]
        .iter()
        .any(|k| effects[k] != "none")
        || effects["recorder"] == true
        || effects["restart"] == true
}

fn walk(stmts: &[Stmt], root: &Component, plan: &Plan, reach: &mut Reach, next: &mut Vec<String>) {
    for stmt in stmts {
        match stmt {
            Stmt::Send {
                target,
                source,
                args,
                ..
            } => {
                let then = root.mutations.iter().find(|m| &m.name == target);
                if let Some((action, _)) = then.and_then(|m| m.then.as_ref()) {
                    next.push(action.clone());
                }
                classify(source, args, plan, reach);
            }
            Stmt::Command { name, args, .. } => classify(name, args, plan, reach),
            Stmt::If {
                then, otherwise, ..
            } => {
                walk(then, root, plan, reach, next);
                walk(otherwise, root, plan, reach, next);
            }
            Stmt::Match { some, none, .. } => {
                walk(&some.1, root, plan, reach, next);
                walk(none, root, plan, reach, next);
            }
            Stmt::Call { body, .. } => walk(body, root, plan, reach, next),
            Stmt::Assign { .. } | Stmt::Refresh { .. } | Stmt::Let { .. } => {}
        }
    }
}

fn classify(source: &str, args: &[Expr], plan: &Plan, reach: &mut Reach) {
    match source {
        "startActivity" => {
            reach.activity.insert("start");
            match args.first() {
                Some(Expr::Str(kind, _)) => {
                    reach.kinds.insert(kind.clone());
                }
                _ => reach.dynamic_kind = true,
            }
            return;
        }
        "updateActivity" => {
            reach.activity.insert("update");
            return;
        }
        "endActivity" => {
            reach.activity.insert("end");
            return;
        }
        _ => {}
    }
    let Some(module) = plan.module_named(source) else {
        return;
    };
    // A package name's options reach the plan as one record of them
    // (`modules.rs`); one the walk cannot open may ask for anything.
    let (fields, opaque) = match args {
        [Expr::Call(_, fields, _)] => (fields.as_slice(), false),
        [] => (args, false),
        _ => (args, !args.iter().all(|a| matches!(a, Expr::NamedArg(..)))),
    };
    let unread = Expr::Ident(String::new(), contract_syntax::Span::default());
    let named = |key: &str| {
        let given = fields.iter().find_map(|a| match a {
            Expr::NamedArg(n, value, _) if n == key => Some(value.as_ref()),
            _ => None,
        });
        given.or(opaque.then_some(&unread))
    };
    match (plan.str(module.package), plan.str(module.declared)) {
        ("@exact/media-capture", "getUserMedia") => {
            let audio = flag(named("audio")).max(constraints(named("audioConstraints")));
            let camera = flag(named("video")).max(constraints(named("videoConstraints")));
            reach.audio = reach.audio.max(audio);
            reach.camera = reach.camera.max(camera);
        }
        ("@exact/media-capture", "setTrackEnabled") => {
            reach.restart |= flag(named("enabled")) != Level::None;
        }
        ("@exact/recording", "resumeMediaRecorder") => reach.restart = true,
        ("@exact/recording", "startMediaRecorder") => reach.recorder = true,
        ("@exact/speech-recognition", "startSpeechRecognition") => {
            reach.audio = reach.audio.max(flag(named("microphone")));
        }
        ("@exact/camera", "takePhoto") => reach.camera = Level::Known,
        ("@exact/screen-capture", "captureScreens" | "requestScreenRecording") => {
            reach.display = Level::Known;
        }
        _ => {}
    }
}

/// How surely a Boolean option asks for its kind: absent, `none` and
/// `false` do not, `true` does, and anything computed may.
fn flag(value: Option<&Expr>) -> Level {
    match value {
        None | Some(Expr::None(_) | Expr::Bool(false, _)) => Level::None,
        Some(Expr::Some(inner, _)) => flag(Some(inner)),
        Some(Expr::Bool(true, _)) => Level::Known,
        Some(_) => Level::Possible,
    }
}

/// How surely a constraints option asks for its kind: a shape's
/// constructor does, `none` does not, and anything computed may.
fn constraints(value: Option<&Expr>) -> Level {
    match value {
        None | Some(Expr::None(_)) => Level::None,
        Some(Expr::Some(inner, _)) => constraints(Some(inner)),
        Some(Expr::Call(name, ..)) if name.starts_with(char::is_uppercase) => Level::Known,
        Some(_) => Level::Possible,
    }
}

/// Check each control against the plan and add it there (D1): its tool is
/// declared, destroys nothing and needs no argument; its URL is a location
/// the navigation root's routes match.
pub(crate) fn add(
    controls: &[Control],
    root: &Component,
    navigates: bool,
    plan: &mut Plan,
) -> Result<(), (&'static str, String)> {
    for control in controls {
        let kind = &control.kind;
        let (tool, url, effects, signature) = match &control.action {
            ControlAction::Tool(name) => {
                let Some(i) = (plan.tools.iter()).position(|t| plan.str(t.name) == name) else {
                    return Err(("control-tool", format!("control `{kind}` names tool `{name}`, and the app has no `tool {name}` line (LLP 1126.004 D1)")));
                };
                let row = &plan.tools[i];
                if plan.str(row.consequence) == "destroys" {
                    return Err(("control-destroys", format!("control `{kind}`: tool `{name}` destroys, and a control has no confirmation for the person to answer; name a tool that reads or writes (LLP 1126.004 D1)")));
                }
                let action = plan.action(row.action);
                let required = (action.params.iter())
                    .map(|p| plan.param(p))
                    .find(|p| plan.types[p.ty.0 as usize].kind != exact_plan::TypeKind::Option);
                if let Some(p) = required {
                    return Err(("control-arguments", format!("control `{kind}`: tool `{name}`'s parameter `{}` is required, and a press passes no arguments; make it an option, which a press passes as none (LLP 1126.004 D1)", p.declared_name(plan))));
                }
                let action = plan.str(action.name).to_owned();
                let effects = self::effects(root, plan, &action);
                let signature = crate::faces::tool_signature(plan, i);
                (Some(ToolsId(i as u32)), "", effects, signature)
            }
            ControlAction::Url(url) => {
                if !navigates || !opens(plan, url) {
                    return Err(("control-url", format!("control `{kind}` opens {url}, which no route of the navigation root matches; a URL control needs the root component's outermost node to have `navigate=` and a route for its url (LLP 1126.004 D1; docs/recipes/navigation-stack.md)")));
                }
                (None, url.as_str(), json!({}), Value::Null)
            }
        };
        let digest = digest(&control.json(), &signature, &effects);
        plan.add_control(kind, tool, url, &effects.to_string(), &digest);
    }
    Ok(())
}

/// The dispatch digest of a control: hex SHA-256 of its row, its tool's
/// signature (null for a URL) and its effects, as canonical JSON (D1).
pub fn digest(row: &Value, signature: &Value, effects: &Value) -> String {
    let all = json!({ "row": row, "signature": signature, "effects": effects });
    let digest = Sha256::digest(crate::faces::canonical(&all).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether one of the plan's declared routes matches `url`: a `notfound`
/// fallback does not make a literal valid.
fn opens(plan: &Plan, url: &str) -> bool {
    if plan.router.is_none() {
        return false;
    }
    let table = exact_route::Table {
        routes: (plan.routes.iter())
            .map(|r| exact_route::Route {
                name: plan.str(r.name).into(),
                pattern: plan.str(r.pattern).into(),
                parent: r.parent.map(|p| p.0 as usize),
                tab: r.tab,
                notfound: r.notfound,
            })
            .collect(),
    };
    table.matches_pattern(url).is_some()
}
