use super::*;
use crate::{
    Answer, DataError, FailureKind, InFlight, Request, Response, Store, SurfaceOutcome, Value,
};
use exact_kernel::{Kernel, NodeType};
use exact_plan::{asm::Asm, builder::PlanBuilder, Plan, TypeKind};

#[derive(Default)]
struct Source {
    parses: usize,
    stream: bool,
    race: bool,
    landed: Vec<(u64, Outcome)>,
}

impl DataSource for Source {
    fn query(&mut self, _: &str, _: &[Value]) -> Result<Value, DataError> {
        unreachable!()
    }

    fn answer(&mut self, _: &mut Store, _: &str, args: &[Value]) -> Result<Answer, DataError> {
        if args == [Value::Number(0.)] {
            return Ok(Answer::Now(Value::Number(0.)));
        }
        let mut request = Request::get("https://example.test/answer");
        request.wake_ms = self.race.then_some(10);
        Ok(if self.stream {
            Answer::stream(request)
        } else {
            Answer::Later(request)
        })
    }

    fn parse(
        &mut self,
        _: &mut Store,
        _: &str,
        _: &[Value],
        outcome: Outcome,
    ) -> Result<Answer, DataError> {
        self.parses += 1;
        Ok(match outcome {
            Outcome::Response(r) if r.body == b"more" => {
                Answer::Later(Request::get("https://example.test/next"))
            }
            _ => Answer::Now(Value::Number(self.parses as f64)),
        })
    }

    fn timer_before_reply(
        &mut self,
        _: &Store,
        _: InFlight<'_>,
        _: Option<u64>,
    ) -> Option<(u64, Request)> {
        self.race.then(|| (7, Request::continuation(8)))
    }

    fn module_landed(
        &mut self,
        _: &mut Store,
        token: u64,
        outcome: Outcome,
    ) -> Result<(), DataError> {
        self.landed.push((token, outcome));
        Ok(())
    }
}

fn plan() -> Plan {
    let mut b = PlanBuilder::new(exact_kernel::SCHEMA_DIGEST, 1);
    let number = b.primitive(TypeKind::Number);
    let one = b.constant(&Value::Number(1.));
    let wave = b.slot("wave", number, one);
    let mut arg = Asm::new();
    arg.load_slot(wave);
    let arg = b.code(arg);
    b.resource("answer", "read", &[arg], number, None);
    let mut body = Asm::new();
    body.load_param(0).store_slot(wave);
    let body = b.code(body);
    b.action("wave", &[("value", number)], &[wave], body);
    b.node(NodeType::View as u8, None, None, 0, &[], &[], None);
    b.finish().unwrap()
}

fn boot() -> Runner<Source> {
    Runner::boot(
        plan(),
        Source::default(),
        Kernel::with_monospace(),
        Default::default(),
        "/",
    )
    .unwrap()
}

fn request(r: &mut Runner<Source>) -> RequestOut {
    let mut requests = r.take_requests();
    assert_eq!(requests.len(), 1);
    requests.pop().unwrap()
}

fn capability(request: &RequestOut) -> CompletionCapability {
    request.completion.as_ref().unwrap().take().unwrap()
}

fn completion(outcome: Outcome) -> Completion {
    Completion::Reply {
        outcome,
        timing: None,
    }
}

fn response(body: &str) -> Outcome {
    Outcome::Response(Response {
        status: 200,
        headers: vec![],
        body: body.as_bytes().to_vec(),
    })
}

#[test]
fn authority_is_minted_only_when_work_is_handed_out_and_can_be_taken_once() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<CompletionCapability>();
    let mut r = boot();
    assert!(r.completion_identity.get().is_none());
    assert!(r.pending[0].completion.is_none());
    let request = request(&mut r);
    let copied = request.clone();
    let cap = capability(&request);
    assert_eq!(cap.ticket, request.ticket);
    assert_eq!(cap.owner, Target::Resource(0));
    assert!(matches!(cap.class, Class::UiOwned));
    let identity = r.completion_identity.get().unwrap();
    assert!(Arc::ptr_eq(&cap.identity.session, &identity.session));
    assert!(Arc::ptr_eq(&cap.identity.generation, &identity.generation));
    assert!(copied.completion.unwrap().take().is_none());
    assert!(r.pending[0].completion.as_ref().unwrap().take().is_none());
    r.deliver(cap, completion(response("answer")))
        .unwrap()
        .unwrap();
    assert_eq!(r.resource("answer"), Some(&Value::Number(1.)));
}

#[test]
fn typed_outcomes_preserve_the_existing_reply_handler() {
    for outcome in [
        response("answer"),
        Outcome::Storage(vec![1, 2]),
        Outcome::Surface(SurfaceOutcome::Captured(vec![3])),
        Outcome::Surface(SurfaceOutcome::Restored),
        Outcome::Failed {
            kind: FailureKind::Refused,
            message: "admission refused".into(),
        },
    ] {
        let (mut typed, mut integer) = (boot(), boot());
        let (a, b) = (request(&mut typed), request(&mut integer));
        let receipt = typed
            .deliver(capability(&a), completion(outcome.clone()))
            .unwrap();
        assert_eq!(receipt, integer.fulfill(b.ticket, outcome).unwrap());
        assert_eq!(typed.resource("answer"), integer.resource("answer"));
        assert_eq!(typed.data().parses, integer.data().parses);
        assert_eq!(
            typed.journal().collect::<Vec<_>>(),
            integer.journal().collect::<Vec<_>>()
        );
        assert!(
            b.completion.unwrap().take().is_none(),
            "integer entry consumed the issued authority"
        );
    }
}

#[test]
fn measured_integer_entry_consumes_authority_and_keeps_executor_timing() {
    let mut r = boot();
    let request = request(&mut r);
    r.fulfill_measured(
        request.ticket,
        response("answer"),
        Some(crate::CompletionTiming {
            cached: true,
            elapsed_ms: 7,
            delivery_wait_ms: 3,
        }),
    )
    .unwrap()
    .unwrap();
    assert!(request.completion.unwrap().take().is_none());
    assert!(r
        .journal()
        .any(|line| line.contains("HTTP cache; wall 7 ms; delivery wait 3 ms")));
}

#[test]
fn each_continuation_gets_authority_for_its_new_request() {
    let mut r = boot();
    let first = request(&mut r);
    let cap = capability(&first);
    let session = cap.identity.session.clone();
    let generation = cap.identity.generation.clone();
    r.deliver(cap, completion(response("more")))
        .unwrap()
        .unwrap();
    let next = request(&mut r);
    let cap = capability(&next);
    assert_ne!(first.ticket, next.ticket);
    assert!(Arc::ptr_eq(&session, &cap.identity.session));
    assert!(Arc::ptr_eq(&generation, &cap.identity.generation));
    r.deliver(cap, completion(response("done")))
        .unwrap()
        .unwrap();
    assert_eq!(r.data().parses, 2);
    assert!(!r.has_pending());
}

#[test]
fn timer_race_refusal_keeps_the_continuation_and_adopted_fetch_authorities_apart() {
    for hand_out in [false, true] {
        let mut r = Runner::boot(
            plan(),
            Source {
                race: true,
                ..Default::default()
            },
            Kernel::with_monospace(),
            Default::default(),
            "/",
        )
        .unwrap();
        let fetch = request(&mut r);
        assert_eq!(r.data_timer_due_ms(), Some(10.));
        r.advance(10.).unwrap();
        let next = r
            .pending()
            .into_iter()
            .find(|(name, _)| name == "answer")
            .unwrap()
            .1;
        assert_ne!(next, fetch.ticket);
        if hand_out {
            let continuation = request(&mut r);
            assert_eq!(continuation.ticket, next);
            assert_eq!(continuation.request.continuation, Some(8));
        }
        r.fulfill_measured(
            next,
            Outcome::Failed {
                kind: FailureKind::Refused,
                message: "continuation refused".into(),
            },
            None,
        )
        .unwrap()
        .unwrap();
        assert!(!r.holds(next), "the refusal settles the continuation");
        assert!(r.holds(fetch.ticket), "the fetch still runs as module work");
        assert!(r.data().landed.is_empty());
        assert_eq!(r.data().parses, 1);
        assert_eq!(r.resource("answer"), Some(&Value::Number(1.)));

        r.deliver(capability(&fetch), completion(response("late")))
            .unwrap();
        assert_eq!(r.data().landed, vec![(7, response("late"))]);
        assert!(!r.holds(fetch.ticket));
        assert!(!r.has_pending());
    }
}

#[test]
fn retired_and_duplicate_integer_replies_keep_their_existing_drop_behavior() {
    let mut r = boot();
    let first = request(&mut r);
    let cap = capability(&first);
    r.act("wave", vec![Value::Number(0.)]).unwrap();
    assert!(r
        .deliver(cap, completion(response("late")))
        .unwrap()
        .is_none());
    assert_eq!(r.data().parses, 0);
    assert_eq!(r.resource("answer"), Some(&Value::Number(0.)));
    assert!(r
        .fulfill(first.ticket, response("duplicate"))
        .unwrap()
        .is_none());
}

#[test]
fn carry_adds_no_cross_session_or_generation_refusal() {
    let (mut original, mut other) = (boot(), boot());
    let old = request(&mut original);
    let fresh = request(&mut other);
    let cap = capability(&old);
    let next = capability(&fresh);
    assert_eq!(cap.ticket, next.ticket);
    assert!(!Arc::ptr_eq(&cap.identity.session, &next.identity.session));
    assert!(!Arc::ptr_eq(
        &cap.identity.generation,
        &next.identity.generation
    ));
    // Shadow and refusal are later steps: carry still uses today's ticket semantics.
    other
        .deliver(cap, completion(response("answer")))
        .unwrap()
        .unwrap();
    assert_eq!(other.data().parses, 1);
}

#[test]
fn subscription_requests_keep_their_integer_protocol() {
    let mut r = Runner::boot(
        plan(),
        Source {
            stream: true,
            ..Default::default()
        },
        Kernel::with_monospace(),
        Default::default(),
        "/",
    )
    .unwrap();
    let request = request(&mut r);
    assert!(request.completion.is_none());
    assert!(r.completion_identity.get().is_none());
    for text in ["one", "two"] {
        r.fulfill(
            request.ticket,
            Outcome::Message(crate::Message {
                data: text.into(),
                ..Default::default()
            }),
        )
        .unwrap()
        .unwrap();
    }
    assert_eq!(r.data().parses, 2);
}
