//! What the emitted program says about a child's resources (LLP 1035.005.004).
use exact_runner::{Answer, DataError, DataSource, Store, Value};

/// Answers `subjectWorks(s)` at once with `s` baked, as a build's data does.
struct Built;

impl DataSource for Built {
    fn query(&mut self, name: &str, _: &[Value]) -> Result<Value, DataError> {
        Err(DataError::UnknownSource(name.into()))
    }
    fn answer(&mut self, _: &mut Store, name: &str, args: &[Value]) -> Result<Answer, DataError> {
        let arg = args.first().and_then(Value::as_str).unwrap_or("");
        match name {
            "subjectWorks" => Ok(Answer::Now(Value::record(vec![
                Value::Bool(true),
                Value::list(vec![Value::str(&format!("baked {arg}"))]),
            ]))),
            _ => Err(DataError::UnknownSource(name.into())),
        }
    }
}

const SCREENS: &str = "routes nav
  home \"/\"
  discover \"/discover\"

shape Subject
  ok: bool
  works: string[]

component App
  view
    main
      for e in stack(nav) key=e.id
        if e.name == \"discover\"
          Discover()
        else
          text \"Home\"

component Discover
  state subject = \"sf\"
  resource works = subjectWorks(subject) as shape Subject else empty(ok=true)
  action reload
    refresh works
  view
    column
      text works.works.join(\",\") testId=\"works\"
      button press=reload testId=\"reload\"
        text \"Reload\"
";

/// The row is an aggregate at the root; each instance makes its own request,
/// which its action refreshes, and its path follows the runner's.
#[test]
fn each_instance_makes_and_refreshes_its_own_request() {
    let js = crate::emit::emit(&contract::compile(SCREENS).unwrap(), false, false)
        .unwrap()
        .js;
    assert!(js.contains("const r_0=owned(\"works#1\")"), "{js}");
    assert!(
        js.contains(".r0=own(r_0,()=>res(\"works#1\",\"subjectWorks\""),
        "{js}"
    );
    assert!(js.contains("R($r.r0)"), "{js}");
    assert!(js.contains("\"/0=\"+rowPath($k)"), "{js}");
    assert!(js.contains("+\"/1:0\""), "{js}");
}

/// A launch instance takes the bake's answer only while the boot builds it
/// (the runner's settlement.rs `launch`): an instance made later asks with
/// nothing compiled.
#[test]
fn a_launch_instance_takes_the_bakes_answer() {
    // At `/` the boot render makes no Discover, so the bake has nothing for it.
    let plan = contract::bake(contract::compile(SCREENS).unwrap(), Built).unwrap();
    let js = crate::emit::emit(&plan, false, false).unwrap().js;
    assert!(!js.contains("baked sf"), "{js}");
    // Where it does, the instance takes the answer while the boot builds it.
    let first = SCREENS.replace(
        "home \"/\"\n  discover \"/discover\"",
        "discover \"/\"\n  home \"/home\"",
    );
    let plan = contract::bake(contract::compile(&first).unwrap(), Built).unwrap();
    let js = crate::emit::emit(&plan, false, false).unwrap().js;
    assert!(
        js.contains("(booting()?[!0,[\"baked sf\"]]:void 0)"),
        "{js}"
    );
    assert!(js.contains("(booting()?[\"sf\"]:void 0)"), "{js}");
}

/// A plan with no child's resource emits no instance paths.
#[test]
fn a_plan_without_owners_names_no_instances() {
    let source = SCREENS.replace(
        "  resource works = subjectWorks(subject) as shape Subject else empty(ok=true)\n  action reload\n    refresh works\n",
        "",
    )
    .replace("works.works.join(\",\")", "subject")
    .replace("press=reload ", "");
    let js = crate::emit::emit(&contract::compile(&source).unwrap(), false, false)
        .unwrap()
        .js;
    assert!(!js.contains("$q"), "{js}");
    assert!(!js.contains("rowPath"), "{js}");
}
