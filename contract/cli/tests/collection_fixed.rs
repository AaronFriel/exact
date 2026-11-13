//! Fixed content around a virtualized list.

#[test]
fn vertical_collections_accept_fixed_content_and_name_unsupported_shapes() {
    let source = "component App\n  view\n    list virtualized=true appearance=\"none\" height=200\n      text \"Lead\"\n      for x in [1, 2] key=x\n        text `${x}`\n      text \"Trail\"\n";
    contract::compile(source).unwrap();
    for (source, id, fix) in [
        (source.replace("      text \"Trail\"", "      for y in [3] key=y\n        text `${y}`"), "lower-collection-template", "element"),
        (source.replace("height=200", "height=200 display=\"flex\""), "lower-collection-fixed", "vertical"),
        (source.replace("appearance=\"none\" ", ""), "lower-collection-fixed", "appearance=\"none\""),
        (source.replace("      text \"Trail\"", "      column\n        list virtualized=true height=40\n          for y in [3] key=y\n            text `${y}`"), "lower-collection-fixed", "row"),
    ] {
        let error = contract::compile(&source).unwrap_err();
        assert_eq!(error.id, id, "{error}");
        assert!(error.message.contains(fix), "{error}");
    }
}

#[test]
fn fixed_content_admission_reads_literal_class_rows() {
    let source = "style Plain\n  appearance=\"none\"\n\ncomponent App\n  view\n    list virtualized=true class=Plain height=200\n      text \"Lead\"\n      for x in [1, 2] key=x\n        text `${x}`\n      text \"Trail\"\n";
    contract::compile(source).unwrap();
}

#[test]
fn fixed_content_refuses_a_horizontal_class_before_boot() {
    let source = "style Horizontal\n  display=\"flex\"\n\ncomponent App\n  view\n    list virtualized=true appearance=\"none\" class=Horizontal height=200\n      text \"Lead\"\n      for x in [1, 2] key=x\n        text `${x}`\n      text \"Trail\"\n";
    let error = contract::compile(source).unwrap_err();
    assert_eq!(error.id, "lower-collection-fixed");
    assert!(error.message.contains("vertical"));
}

#[test]
fn fixed_roots_refuse_positions_and_overlapping_flow() {
    for margin in [
        "10",
        "\"10px\"",
        "\"1lh\"",
        "\"2ch\"",
        "\"1rem\"",
        "\"1em\"",
        "\"10%\"",
        "\"1px 2px\"",
    ] {
        let source = format!("component App\n  view\n    list virtualized=true appearance=\"none\" height=200\n      view margin={margin}\n      for n in [1] key=n\n        view height=40\n");
        contract::compile(&source).unwrap();
    }
    for offset in ["0", "\"0\"", "\"0px\"", "\"auto\""] {
        for side in ["top", "bottom"] {
            let source = format!("component App\n  view\n    list virtualized=true appearance=\"none\" height=200\n      view position=\"relative\" {side}={offset}\n      for n in [1] key=n\n        view height=40\n");
            contract::compile(&source).unwrap();
        }
    }
    for inset in [
        "0",
        "\"0px\"",
        "\"auto\"",
        "\"0px -10px\"",
        "\"auto 10px 0px\"",
    ] {
        let source = format!("component App\n  view\n    list virtualized=true appearance=\"none\" height=200\n      view position=\"relative\" inset={inset}\n      for n in [1] key=n\n        view height=40\n");
        contract::compile(&source).unwrap();
    }
    for attrs in [
        "position=\"sticky\"",
        "position=\"absolute\"",
        "margin-bottom=-400",
        "margin-top=-10",
        "margin=-10",
        "margin-bottom=\"-1lh\"",
        "margin=\"1px -2px\"",
        "position=\"relative\" top=-10",
        "position=\"relative\" inset=\"-100px 0px 0px\"",
        "position=\"relative\" inset=\"0px 0px -100px\"",
        "position=\"relative\" inset=offset",
        "position=\"relative\" inset=`0px 0px ${offset}px`",
    ] {
        for root in [
            format!("view {attrs}"),
            format!("view display=\"contents\"\n        view {attrs}"),
        ] {
            let source = format!("component App\n  state offset = -100\n  view\n    list virtualized=true appearance=\"none\" height=200\n      {root}\n      for n in range(100) key=n\n        view height=40\n");
            let error = contract::compile(&source).expect_err(&source);
            assert_eq!(error.id, "lower-collection-fixed-flow", "{error}");
            assert!(error.message.contains("fixed"), "{error}");
        }
        if attrs.contains("offset") {
            continue;
        }
        let source = format!("style Fixed\n  {attrs}\n\ncomponent App\n  state offset = -100\n  view\n    list virtualized=true appearance=\"none\" height=200\n      if true\n        view class=Fixed\n      for n in [1] key=n\n        view height=40\n");
        assert_eq!(
            contract::compile(&source).unwrap_err().id,
            "lower-collection-fixed-flow"
        );
    }
}

