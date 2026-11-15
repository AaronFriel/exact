use super::*;
use contract_types::{Ref, Ty};

#[test]
fn view_names_have_the_plan_regions_depth_and_do_not_escape_an_arm() {
    let file = contract_syntax::parse("component App\n  state xs: number[] = [1]\n  state o: option<string> = none\n  view\n    for x, i in xs key=x\n      if true\n        match o\n          case some(x)\n            text x\n          case none\n            text `${x}`\n      text `${x}`\n    text \"outside\"\n").unwrap();
    let checked = contract_types::check(&file, |_| false).unwrap();
    let checking = Checking::new(&checked);
    let view = checking.authored(0);
    let found: Vec<_> = view
        .scoped()
        .filter(|(node, _)| node.element().is_some())
        .map(|(_, scope)| {
            (
                scope.lookup("x").map(|(r, t)| (r, t.clone())),
                scope.lookup("i").map(|(r, _)| r),
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            (Some((Ref::Bound(0), Ty::String)), Some(Ref::Index(2))),
            (Some((Ref::Item(2), Ty::Number)), Some(Ref::Index(2))),
            (Some((Ref::Item(0), Ty::Number)), Some(Ref::Index(0))),
            (None, None),
        ]
    );
}

#[test]
fn inherited_facts_and_declaration_identities_stay_in_their_subtree() {
    let file = contract_syntax::parse("component App\n  view\n    column\n      if true\n        Child()\n      else\n        text \"other\"\n    text \"sibling\"\ncomponent Child\n  view\n    text \"child\"\n").unwrap();
    let checked = contract_types::check(&file, |_| false).unwrap();
    let checking = Checking::new(&checked);
    let view = checking.authored(0);
    let found: Vec<_> = view
        .walk_with(0, |_, depth| depth + 1)
        .map(|(node, depth)| {
            (
                node.span().line,
                depth,
                node.component_use().map(|(id, name, _)| (id, name)),
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            (3, 0, None),
            (4, 1, None),
            (5, 2, Some((Some(1), "Child"))),
            (7, 2, None),
            (8, 0, None)
        ]
    );
    assert_eq!(view.walk().count(), found.len());
    assert!(checking
        .expanded()
        .walk()
        .all(|node| node.component_use().is_none()));
}
