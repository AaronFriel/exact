//! Bound package calls made by a poll during an agent clock operation.
use super::*;
use crate::package::{json, Context, Entry, Json, Package, Reply};
use crate::presenter::Handed;

struct Counter {
    context: Context,
    calls: usize,
}

impl Package for Counter {
    fn new(context: Context) -> Self {
        Self { context, calls: 0 }
    }

    fn later(&mut self, name: &str, _: &Json, _: Option<&Json>, reply: Reply) {
        assert_eq!(name, "polled");
        self.calls += 1;
        self.context
            .log(format!("call {} at {}", self.calls, self.context.now()));
        reply.send(json!(self.calls));
    }
}

#[test]
fn a_clock_jump_services_each_polled_package_call_before_replying() {
    let plan = contract::compile(
        "component App\n  resource value = polled() as shape number\n  view\n    text value.toString()\n",
    )
    .unwrap();
    let source = exact_plan::SourcesId(
        plan.sources
            .iter()
            .position(|s| plan.str(s.name) == "polled")
            .unwrap() as u32,
    );
    let mut builder = exact_plan::builder::PlanBuilder::from_plan(plan);
    builder.module(
        source,
        ("counter", "@fixture/counter"),
        "polled",
        false,
        true,
        "never",
        "",
        r#"{"default":0,"poll":{"option":"interval","default":100}}"#,
    );
    let (mut p, error) = Presenter::boot_with(
        &builder.finish().unwrap().encode(),
        (),
        (100., 40.),
        1.,
        std::path::PathBuf::new(),
        PainterChoice::Cpu,
    )
    .unwrap();
    assert!(error.is_none(), "{error:?}");
    p.serve_packages(vec![Entry::of::<Counter>("counter")]);
    let bound = std::time::Duration::from_secs(2);
    let initial = handle(&mut p, r#"{"op":"clock","data":true}"#);
    assert!(initial.contains("\"settled\":true"), "{initial}");
    assert_eq!(
        p.host().runner().resource("value"),
        Some(&Value::Number(1.))
    );

    // A poll is outside the timer wheel: crossing several periods still asks once,
    // at the landing time, and seeking to that same time asks nothing more.
    for (to, calls) in [(100, 2), (200, 3), (1000, 4), (1000, 4)] {
        let reply = clock_within(&mut p, &format!(r#"{{"op":"clock","to":{to}}}"#), bound);
        assert_eq!(p.host().now(), f64::from(to), "{reply}");
        assert_eq!(
            p.host().runner().resource("value"),
            Some(&Value::Number(f64::from(calls))),
            "the poll's reply must commit before the clock answers: {reply}"
        );
        assert!(!p.host().runner().polls_asking(), "{reply}");
    }
    let calls: Vec<_> = p
        .host()
        .runner()
        .journal()
        .filter(|line| line.contains("counter: call "))
        .collect();
    assert_eq!(
        calls,
        [
            "t=0 counter: call 1 at 0",
            "t=100 counter: call 2 at 100",
            "t=200 counter: call 3 at 200",
            "t=1000 counter: call 4 at 1000"
        ]
    );
}

#[test]
fn a_clock_wait_services_the_readers_requests_and_answers_on_its_owner() {
    let plan = contract::compile(
        "component App\n  resource value = polled() as shape number\n  view\n    text value.toString()\n",
    ).unwrap();
    let source = exact_plan::SourcesId(
        plan.sources
            .iter()
            .position(|s| plan.str(s.name) == "polled")
            .unwrap() as u32,
    );
    let mut builder = exact_plan::builder::PlanBuilder::from_plan(plan);
    builder.module(
        source,
        ("counter", "@fixture/counter"),
        "polled",
        false,
        true,
        "never",
        "",
        r#"{"default":0,"poll":{"option":"interval","default":100}}"#,
    );
    let (mut p, error) = Presenter::boot_with(
        &builder.finish().unwrap().encode(),
        (),
        (100., 40.),
        1.,
        std::path::PathBuf::new(),
        PainterChoice::Cpu,
    )
    .unwrap();
    assert!(error.is_none(), "{error:?}");
    p.serve_requests();
    p.bind_modules(vec!["counter".into()], vec![]);
    let owner = std::thread::current().id();
    let mut calls = 0;
    let mut replies = Vec::new();
    p.set_agent_turn(Some(Box::new(move |_now, words| {
        assert_eq!(std::thread::current().id(), owner);
        let ready = std::mem::take(&mut replies);
        if let Some(words) = words {
            let mut at = 0;
            while at < words.len() {
                let end = at + 3 + words[at + 2] as usize;
                if words[at] == 11 {
                    calls += 1;
                    replies.push(Handed::Answer(words[at + 1], Some(calls.to_string())));
                }
                at = end;
            }
        }
        ready
    })));
    let bound = std::time::Duration::from_secs(1);
    p.pump(0.);
    p.package_turn();
    assert!(p.pending(), "the bound module has an unanswered request");
    let initial = clock_within(&mut p, r#"{"op":"clock","settle":true}"#, bound);
    assert!(
        initial.contains("\"settled\":true"),
        "the reader's answer waited behind the clock op: {initial}"
    );
    assert_eq!(
        p.host().runner().resource("value"),
        Some(&Value::Number(1.))
    );
    for (to, calls) in [(100, 2), (200, 3), (1000, 4), (1000, 4)] {
        let reply = clock_within(&mut p, &format!(r#"{{"op":"clock","to":{to}}}"#), bound);
        assert_eq!(
            p.host().runner().resource("value"),
            Some(&Value::Number(f64::from(calls))),
            "{reply}"
        );
        assert!(!p.host().runner().polls_asking(), "{reply}");
    }
}

/// `prefer extension` tells the reader's extension, which acts on it on its
/// own thread: a `clock settle` waits for the tell's answer, and a topic the
/// extension announced before answering asks its reader again within the
/// same settle (the photos selection drive, `packages/photos/test/android.mjs`).
#[test]
fn a_settle_waits_for_a_tell_and_what_it_announced() {
    let plan = contract::compile(
        "component App\n  resource value = counted() as shape number\n  view\n    text value.toString()\n",
    )
    .unwrap();
    let source = exact_plan::SourcesId(
        plan.sources
            .iter()
            .position(|s| plan.str(s.name) == "counted")
            .unwrap() as u32,
    );
    let mut builder = exact_plan::builder::PlanBuilder::from_plan(plan);
    builder.module(
        source,
        ("counter", "@fixture/counter"),
        "counted",
        false,
        true,
        "never",
        "",
        r#"{"default":0,"implementation":true,"agent":{"word":"string"}}"#,
    );
    let (mut p, error) = Presenter::boot_with(
        &builder.finish().unwrap().encode(),
        (),
        (100., 40.),
        1.,
        std::path::PathBuf::new(),
        PainterChoice::Cpu,
    )
    .unwrap();
    assert!(error.is_none(), "{error:?}");
    p.serve_requests();
    p.bind_modules(vec![], vec!["counter".into()]);
    // The reader: what a turn hands it is answered 100 ms later, as its UI
    // thread answers when it gets to it.
    let (mut calls, mut later) = (0, Vec::new());
    let mut due = std::time::Instant::now();
    p.set_agent_turn(Some(Box::new(move |_now, words| {
        let now = std::time::Instant::now();
        let ready = if now >= due {
            std::mem::take(&mut later)
        } else {
            Vec::new()
        };
        let words = words.unwrap_or_default();
        if !words.is_empty() && later.is_empty() {
            due = now + std::time::Duration::from_millis(100);
        }
        let mut at = 0;
        while at < words.len() {
            let end = at + 3 + words[at + 2] as usize;
            if words[at] == 11 {
                let bytes: Vec<u8> = (0..words[at + 3] as usize)
                    .map(|k| (words[at + 4 + k / 4] >> (8 * (k % 4))) as u8)
                    .collect();
                let body = String::from_utf8(bytes).unwrap();
                if body.contains("\"source\"") {
                    calls += 1;
                    later.push(Handed::Answer(words[at + 1], Some(calls.to_string())));
                } else {
                    if body.contains("\"preferred\"") {
                        later.push(Handed::Changed("counter.counted".into()));
                    }
                    later.push(Handed::Answer(words[at + 1], Some("{}".into())));
                }
            }
            at = end;
        }
        ready
    })));
    let settle = r#"{"op":"clock","settle":true}"#;
    let first = handle(&mut p, settle);
    assert!(first.contains("\"settled\":true"), "{first}");
    // Binding tells the extension too, which announces: asked twice.
    assert_eq!(
        p.host().runner().resource("value"),
        Some(&Value::Number(2.))
    );
    let told = handle(
        &mut p,
        r#"{"op":"prefer","extension":{"counter.word":"x"}}"#,
    );
    assert!(!told.contains("error"), "{told}");
    let reply = handle(&mut p, settle);
    assert!(reply.contains("\"settled\":true"), "{reply}");
    assert_eq!(
        p.host().runner().resource("value"),
        Some(&Value::Number(3.)),
        "the settle answered before the tell's announced change asked again: {reply}"
    );
}
