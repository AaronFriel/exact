//! LLP 1133.023 D7a: what the host observes of the page and a drag handle's
//! release are the app's, and a world's message under a tool's mark keeps
//! D4a's command rules.

use crate::request::Request;
use crate::{Answer, CallOrigin, DataError, DataSource, Event, Outcome, Runner, Store, Value};
use exact_kernel::Kernel;

/// Every send answers later.
struct Later;

impl DataSource for Later {
    fn query(&mut self, _: &str, _: &[Value]) -> Result<Value, DataError> {
        unreachable!("answers through answer")
    }

    fn answer(&mut self, _: &mut Store, _: &str, _: &[Value]) -> Result<Answer, DataError> {
        Ok(Answer::Later(Request::native(b"{}".to_vec())))
    }

    fn parse(
        &mut self,
        _: &mut Store,
        _: &str,
        _: &[Value],
        _: Outcome,
    ) -> Result<Answer, DataError> {
        Ok(Answer::Now(Value::Number(0.0)))
    }
}

const FRAME: &str = "component App\n  mutation m as shape number\n  tool ping writes \"Ping.\" = loaded\n  action loaded\n    send m = save(1)\n  action heard(text: string)\n    focus(\"x\")\n  view\n    iframe \"/deck/index.html\" load=loaded message=heard testId=\"deck\"\n";

fn boot() -> (Runner<Later>, exact_kernel::ViewId) {
    boot_with(FRAME, "deck")
}

fn boot_with(source: &str, test_id: &str) -> (Runner<Later>, exact_kernel::ViewId) {
    let plan = contract::compile(source).unwrap();
    let r = Runner::boot(
        plan,
        Later,
        Kernel::with_monospace(),
        Default::default(),
        "/",
    )
    .unwrap();
    let key = r.kernel().find_by_test_id(test_id)[0];
    let id = r.kernel().node_by_key(key).unwrap().id;
    (r, id)
}

/// A camera preview's `load` may start the camera.
#[test]
fn a_load_the_host_observes_is_the_apps() {
    let (mut r, frame) = boot();
    r.take_requests();
    r.dispatch(frame, Event::Load).unwrap();
    let sent = r.take_requests();
    assert_eq!(sent[0].request.reach.origin, CallOrigin::App);
}

/// A sheet's or a photo's drag handle reports the geometry it reads and the
/// release of the person's drag.
#[test]
fn a_drag_handles_release_is_the_persons() {
    const HANDLES: &str = "component App\n  mutation m as shape number\n  action geometry(bw: number, bh: number, pw: number, ph: number)\n    send m = save(1)\n  action release(x: number, y: number, scale: number, vx: number, vy: number, vs: number)\n    send m = save(2)\n  action snap(height: number, velocity: number)\n    send m = save(3)\n  view\n    column\n      column id=\"sheet\" height=360 box-sizing=\"border-box\"\n        column testId=\"sheet-handle\" heightDragFor=\"sheet\" heightrelease=snap\n      column overflow=\"hidden\"\n        column id=\"photo\" width=\"100%\" height=\"100%\" box-sizing=\"border-box\"\n          column testId=\"photo-handle\" transformDragFor=\"photo\" transformgeometry=geometry transformrelease=release\n";
    let origin = |id: &str, event: Event| {
        let (mut r, handle) = boot_with(HANDLES, id);
        r.take_requests();
        r.dispatch(handle, event).unwrap();
        r.take_requests()[0].request.reach.origin
    };
    let snap = Event::HeightRelease {
        height: 180.0,
        velocity: 0.0,
    };
    assert_eq!(origin("sheet-handle", snap), CallOrigin::App);
    let release = Event::TransformRelease {
        x: 0.,
        y: 0.,
        scale: 1.,
        vx: 0.,
        vy: 0.,
        vscale: 0.,
    };
    assert_eq!(origin("photo-handle", release), CallOrigin::App);
    let geometry = Event::TransformGeometry {
        box_width: 100.,
        box_height: 100.,
        port_width: 100.,
        port_height: 100.,
    };
    assert_eq!(origin("photo-handle", geometry), CallOrigin::App);
}

#[test]
fn a_worlds_message_under_a_tools_mark_keeps_the_calls_command_rules() {
    let (mut r, frame) = boot();
    r.dispatch(frame, Event::Message("\u{1}origin:tool\u{1}hi".into()))
        .unwrap();
    let lines: Vec<String> = r.journal().map(str::to_owned).collect();
    assert!(
        lines
            .iter()
            .any(|l| l.contains("focus: skipped in a tool call")),
        "{lines:?}"
    );
    // The app's own message runs it.
    r.dispatch(frame, Event::Message("hi".into())).unwrap();
    let skipped = r.journal().filter(|l| l.contains("focus: skipped")).count();
    assert_eq!(skipped, 1);
}

/// expo/exact#1424: a `keepRunning` window the person shows again by
/// launching the app reaches the app only as its page becoming visible, and
/// what that starts is the person's, as at a cold launch.
#[test]
fn a_page_shown_again_starts_work_as_the_apps() {
    const SHOWN: &str = "shape Page\n  visibilityState: string\n  persisted: bool\n\ncomponent App\n  resource page = exactPage() as shape Page\n  mutation frozen as shape number\n  task arrive when page.visibilityState == \"visible\" and not page.persisted\n    after(1, begin)\n  action begin\n    send frozen = save(1)\n  view\n    text \"x\" testId=\"x\"\n";
    let (mut r, _) = boot_with(SHOWN, "x");
    r.advance(1.0).unwrap();
    assert_eq!(r.take_requests().len(), 1, "the cold launch's capture");
    let away = crate::Page {
        hidden: true,
        persisted: true,
        ..r.page()
    };
    r.set_page(away).unwrap();
    let shown = crate::Page {
        hidden: false,
        persisted: false,
        restores: 1,
        ..r.page()
    };
    r.set_page(shown).unwrap();
    r.advance(10.0).unwrap();
    let sent = r.take_requests();
    assert_eq!(sent.len(), 1, "the warm launch's capture");
    assert_eq!(sent[0].request.reach.origin, CallOrigin::App);
}

/// A page the host hides (a wake's headless boot, a closed window) is not the
/// person's act, and a load it renders hidden is not either.
#[test]
fn what_a_hidden_page_arms_or_loads_is_no_ones() {
    const AWAY: &str = "shape Page\n  visibilityState: string\n\ncomponent App\n  resource page = exactPage() as shape Page\n  mutation m as shape number\n  task away when page.visibilityState == \"hidden\"\n    after(1, gone)\n  action gone\n    send m = save(1)\n  action loaded\n    send m = save(2)\n  view\n    iframe \"/deck/index.html\" load=loaded testId=\"deck\"\n";
    let (mut r, deck) = boot_with(AWAY, "deck");
    r.take_requests();
    let hidden = crate::Page {
        hidden: true,
        ..r.page()
    };
    r.set_page(hidden).unwrap();
    r.advance(1.0).unwrap();
    r.dispatch(deck, Event::Load).unwrap();
    let sent = r.take_requests();
    assert_eq!(sent.len(), 2);
    for s in sent {
        assert_eq!(s.request.reach.origin, CallOrigin::Device);
    }
}
