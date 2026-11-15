//! LLP 1175: a data module hears its global's error events natively, as a
//! page does. The shared fixture (`tests/fixtures/error-events.ts`) runs here
//! against what `error-events.json` expects of every host, and of this one's
//! journal; host/web-js/error-events.test.mjs runs it on the web JS target.
#![cfg(exact_js_engine)]

use exact_js::Module;
use exact_kernel::Kernel;
use exact_plan::Value;
use exact_runner::{DataSource, Runner};

const HBC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/error-events.hbc"));
const EXPECTED: &str = include_str!("../fixtures/error-events.json");

const SRC: &str = r#"
component App
  mutation result as shape string
  action go(kind: string)
    send result = run(kind)
  view
    text "errors"
"#;

fn runner() -> Runner<Module> {
    let plan = contract::compile(SRC).expect("the fixture's plan compiles");
    let mut module =
        Module::loaded(HBC.to_vec(), "test.error-events", "").expect("the fixture loads");
    module.set_budget_ms(f64::INFINITY);
    module.bind(&plan);
    Runner::boot(
        plan,
        module,
        Kernel::with_monospace(),
        Default::default(),
        "/",
    )
    .unwrap()
}

/// Run the source on `kind`, its timers included: its answer, or `None` for one that failed.
fn go<D: DataSource>(r: &mut Runner<D>, kind: &str) -> Option<String> {
    r.act("go", vec![Value::str(kind)]).unwrap();
    pump(r);
    let to = r.now_ms() + 1.;
    r.advance_until_request(to);
    pump(r);
    match r.slot("result") {
        Some(Value::Option(Some(v))) => v.as_str().map(str::to_owned),
        _ => None,
    }
}

fn pump<D: DataSource>(r: &mut Runner<D>) {
    for request in r.take_requests() {
        let token = request
            .request
            .continuation
            .expect("the fixture makes no request");
        if let exact_runner::Dispatch::Run(exact_runner::Work::Now(run)) =
            crate::runnable(r.dispatch_work(token))
        {
            r.fulfill(request.ticket, run()).unwrap();
        }
    }
}

/// The journal's lines since `from`, without their time.
fn journal_since<D: DataSource>(r: &Runner<D>, from: usize) -> Vec<String> {
    r.journal()
        .skip(from)
        .filter_map(|l| l.split_once(' ').map(|(_, l)| l.to_string()))
        .collect()
}

#[test]
fn the_shared_fixture_hears_what_a_page_hears() {
    let expected: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
    let mut r = runner();
    for scenario in expected["scenarios"].as_array().unwrap() {
        let kind = scenario["run"].as_str().unwrap();
        let from = r.journal().count();
        let answered = go(&mut r, kind);
        if scenario["fails"].as_bool() == Some(true) {
            assert_ne!(answered.as_deref(), Some(kind), "{kind} fails");
        } else {
            assert_eq!(answered.as_deref(), Some(kind), "{kind} answers");
        }
        let journal = journal_since(&r, from);
        let heard: serde_json::Value =
            serde_json::from_str(&go(&mut r, "log").expect("the log answers")).unwrap();
        let expected = &scenario["heard"];
        let expected = expected.get("native").unwrap_or(expected);
        assert_eq!(&heard, expected, "what the listeners heard of {kind}");
        for line in scenario["journal"]["native"].as_array().unwrap() {
            let line = line.as_str().unwrap();
            assert!(
                journal.iter().any(|l| l == line),
                "{kind}: {line:?} in {journal:#?}"
            );
        }
        let reports = |l: &&String| l.contains("Uncaught") || l.contains("unhandled rejection");
        assert_eq!(
            journal.iter().filter(reports).count(),
            scenario["journal"]["native"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|l| {
                    let l = l.as_str().unwrap();
                    l.contains("Uncaught") || l.contains("unhandled rejection")
                })
                .count(),
            "{kind}: one journal line per report: {journal:#?}"
        );
    }
}

/// D1: what else the events binding gives a data module, and what it does
/// not: no `self` or `navigator`, no clock in `timeStamp`, an `AbortSignal`
/// that is an `EventTarget`, `onerror` assignable after hardening, and
/// Exact's rejection tracker the only one.
#[test]
fn the_events_binding_adds_the_web_s_names_and_no_clock() {
    let mut r = runner();
    assert_eq!(
        go(&mut r, "probe").as_deref(),
        Some("object,function,function,object"),
        "the reporter's probe (#519) answers as on the web"
    );
    let names: serde_json::Value =
        serde_json::from_str(&go(&mut r, "names").expect("names answers")).unwrap();
    assert_eq!(
        names.as_array().unwrap()[..5],
        serde_json::json!(["undefined", "undefined", 0, true, true])
            .as_array()
            .unwrap()[..]
    );
    assert!(
        names[5].as_str().unwrap().starts_with("TypeError: "),
        "the tracker cannot be replaced: {names}"
    );
    assert_eq!(go(&mut r, "rejection").as_deref(), Some("rejection"));
    assert_eq!(
        go(&mut r, "log").as_deref(),
        Some(
            r#"[["unhandledrejection","Error: lost",0,true],["onunhandledrejection","Error: lost"]]"#
        ),
        "Exact's tracker still dispatches"
    );
}

/// D2: what the module's evaluation throws is reported, an `error` event its
/// listeners hear, before the load fails as it did.
#[test]
fn an_evaluation_s_throw_is_heard_before_the_load_fails() {
    let mut module = Module::new(
        include_bytes!(concat!(env!("OUT_DIR"), "/error-events-load.hbc")).to_vec(),
        "test.error-events-load",
        "",
    );
    let error = module.load().expect_err("the evaluation throws");
    assert!(error.contains("at load"), "{error}");
    let logs = module.take_logs();
    let heard = logs.iter().position(|l| l == "heard at load");
    let reported = logs.iter().position(|l| l == "Uncaught Error: at load");
    assert!(heard.is_some() && heard < reported, "{logs:#?}");
}
