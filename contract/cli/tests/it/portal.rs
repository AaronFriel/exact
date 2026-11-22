//! LLP 1013.002 D1, D3: `portal` is a string prop on the element it moves, and
//! the compiler refuses what it can prove no placement could do.

use exact_kernel::PropId;
use exact_plan::BindingKind;
use std::path::Path;

fn corpus(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn refusal(view: &str) -> Option<String> {
    let source = format!("component App\n  state on = true\n  view\n    column\n{view}");
    contract::compile(&source).err().map(|e| e.id.to_string())
}

#[test]
fn both_fixtures_compile_with_one_portal_binding() {
    for name in ["portal.contract", "portal-flight.contract"] {
        let plan = contract::compile(&corpus(name)).unwrap();
        let portals = (plan.bindings.iter())
            .filter(|b| b.kind == BindingKind::Prop && b.id == PropId::Portal as u16)
            .count();
        assert_eq!(portals, 1, "{name}");
    }
}

#[test]
fn what_no_placement_could_move_is_refused() {
    for (view, id) in [
        // A list's row, a button's face, a paragraph's run, an svg's child.
        ("      list\n        for x in [1] key=x\n          box portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      button\n        text \"Go\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      p\n        strong \"Go\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      svg width=10 height=10\n        circle r=5 portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        // A dialog and a popover are presented, a route projected.
        ("      dialog portal=\"a\"\n        text \"Hi\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      box popover=\"auto\" id=\"m\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        // A destination that is a control, has a role, or is the mover itself or inside it.
        ("      button id=\"a\"\n        text \"Go\"\n      box portal=\"a\"\n", "lower-portal-target"),
        ("      box id=\"a\" role=\"group\"\n      box portal=\"a\"\n", "lower-portal-target"),
        ("      box portal=\"a\"\n        box id=\"a\"\n", "lower-portal-target"),
        ("      box id=\"a\" portal=\"a\"\n", "lower-portal-target"),
        // A route and a keyed destination.
        ("      column navigationKey=\"r\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      column id=\"a\" navigationKey=\"r\"\n      box portal=\"a\"\n", "lower-portal-target"),
        // An empty popover is a popover; a table's and a grouped list's parts are slots.
        ("      box popover=\"\" id=\"m\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      table\n        tr portal=\"a\"\n          td\n            text \"1\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      list\n        section\n          row portal=\"a\"\n            text \"1\"\n      box id=\"a\"\n", "lower-portal-mover"),
        ("      box role=\"tab\" portal=\"a\"\n      box id=\"a\"\n", "lower-portal-mover"),
        // A computed id inside the mover names only its own descendant.
        ("      button id=\"a\"\n        text \"Go\"\n      box portal=\"a\"\n        box id=(on ? \"x\" : \"a\")\n", "lower-portal-target"),
    ] {
        assert_eq!(refusal(view).as_deref(), Some(id), "{view}");
    }
}

#[test]
fn an_app_root_cannot_move() {
    let source = "component App\n  view\n    column portal=\"a\"\n      box id=\"a\"\n";
    assert_eq!(
        contract::compile(source).unwrap_err().id,
        "lower-portal-mover"
    );
}

#[test]
fn what_placement_decides_compiles() {
    for view in [
        // A whole svg moves as one element; a video and a button may move.
        "      svg width=10 height=10 portal=\"a\"\n        circle r=5\n      box id=\"a\"\n",
        "      video \"m.mp4\" portal=\"a\"\n      box id=\"a\"\n",
        // A computed role or destination, a missing one, an empty one.
        "      box id=\"a\" role=(on ? \"group\" : \"\")\n      box portal=\"a\"\n",
        "      box id=\"a\"\n      box portal=(on ? \"a\" : \"\")\n",
        "      box portal=\"nowhere\"\n",
        "      box portal=\"\"\n",
        // A destination inside a route is an ordinary layout child.
        "      column navigationKey=\"r\"\n        box id=\"a\"\n      box portal=\"a\"\n        text \"Playing\"\n",
        // One carrier of the id can receive it; the runner hides the mover
        // when the first in declaration order cannot.
        "      button id=\"a\"\n        text \"Go\"\n      box id=\"a\"\n      box portal=\"a\"\n",
        // Each row's mover may name another row's box; an id in the other arm of
        // the mover's `if` is never beside it, so the mover hides.
        "      for x in [1, 2] key=x\n        box portal=\"p\"\n          if x == 1\n            box id=\"p\"\n",
        "      if on\n        box portal=\"a\"\n      else\n        button id=\"a\"\n          text \"Go\"\n",
        // HTML inside an svg's foreignObject is boxes again.
        "      svg width=10 height=10\n        foreignObject width=10 height=10\n          column\n            box portal=\"a\"\n      box id=\"a\"\n",
    ] {
        assert_eq!(refusal(view), None, "{view}");
    }
}
