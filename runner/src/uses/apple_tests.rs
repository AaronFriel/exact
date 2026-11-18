use super::{apple_uses, Capability};
use crate::uses;
use exact_plan::{asm::Asm, builder::PlanBuilder, TypeKind};

fn plan(view: &str) -> exact_plan::Plan {
    let source = format!(
        "component A\n  state wide = true\n  action go\n    wide = false\n  view\n    {view}\n"
    );
    contract::compile(&source).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

/// A plan with one text node, and what `add` puts in its tables.
fn built(add: impl FnOnce(&mut PlanBuilder)) -> exact_plan::Plan {
    let mut b = PlanBuilder::new(exact_kernel::SCHEMA_DIGEST, 1);
    add(&mut b);
    b.node(
        exact_kernel::NodeType::Text as u8,
        None,
        None,
        0,
        &[],
        &[],
        None,
    );
    b.finish().unwrap()
}

/// D10: Apple's `grid` covers every plan whose layout reaches the grid
/// algorithm; elsewhere it stays the grammars a grid row needs.
#[test]
fn apple_links_grid_layout_for_every_plan_that_lays_out_a_grid() {
    let column = |attrs: &str| format!("column {attrs}\n      text \"a\"");
    let table = |attrs: &str| format!("table{attrs}\n      tr\n        td\n          text \"a\"");
    let grid_rows = column("display=\"grid\" grid-template-columns=\"1fr 1fr\"");
    let flex_rows = column("display=\"flex\" justify-items=\"center\"");
    for (view, apple, everywhere) in [
        ("text \"a\"".to_string(), false, false),
        (column("display=\"flex\""), false, false),
        (column("display=\"none\""), false, false),
        // A computed value counts as a use of whatever it might select.
        (column("display=(wide ? \"block\" : \"flex\")"), true, false),
        (column("display=\"grid\""), true, false),
        ("text \"a\" display=\"grid\"".to_string(), true, false),
        (grid_rows, true, true),
        // A grid row on a box that is no grid reaches no grid layout.
        (flex_rows, false, true),
        (table(""), true, false),
        // A table that is a block holds an anonymous table, a grid too.
        (table(" display=\"block\""), true, false),
    ] {
        let plan = plan(&view);
        assert_eq!(apple_uses(&plan).has(Capability::Grid), apple, "{view}");
        assert_eq!(uses(&plan).has(Capability::Grid), everywhere, "{view}");
    }
}

/// D11: the module seam serves a package's modules, its views and its
/// events; each table alone selects it, and no other host's set moves.
#[test]
fn modules_are_a_package_module_view_or_event() {
    let plain = plan("text \"a\"");
    assert!(!apple_uses(&plain).has(Capability::Modules));
    let module = built(|b| {
        let ty = b.primitive(TypeKind::Number);
        let source = b.source("battery", &[], ty);
        b.module(
            source,
            ("battery", "@fixture/battery"),
            "{}",
            false,
            false,
            "",
            "",
            "",
        );
    });
    let event = built(|b| {
        let body = b.code(Asm::new());
        let action = b.action("hear", &[], &[], body);
        b.module_event(("bell", "@fixture/bell"), "chime", action, "emit", 4, 0);
    });
    let mut view = plan("text \"a\"");
    view.add_view("swatch-box", ("swatch", "@fixture/swatch"), true, &[], "");
    for plan in [&module, &event, &view] {
        assert!(apple_uses(plan).has(Capability::Modules));
        assert!(!uses(plan).has(Capability::Modules));
    }
}

/// D11: the tool seam serves a plan with a `tool` line.
#[test]
fn tools_are_a_plan_with_a_tool() {
    assert!(!apple_uses(&plan("text \"a\"")).has(Capability::Tools));
    let source = "component A\n  state n = 0\n  tool bump writes \"Add one.\" = bump\n  action bump\n    n = n + 1\n  view\n    text \"a\"\n";
    let tooled = contract::compile(source).unwrap();
    assert!(apple_uses(&tooled).has(Capability::Tools));
    assert!(!uses(&tooled).has(Capability::Tools));
}
