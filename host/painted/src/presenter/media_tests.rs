use super::super::*;

fn video(p: &Presenter<()>) -> ViewId {
    p.host
        .kernel()
        .node_by_key(p.host.kernel().find_by_test_id("video")[0])
        .unwrap()
        .id
}

#[test]
fn a_players_reports_reach_the_node_only_for_its_session_and_allocation() {
    let source = r#"component App
  state paused = false
  action stopped
    paused = true
  view
    column width=400 height=400
      text (paused ? "paused" : "playing") testId="label" height=24
      video src="a.mp4" paused=paused pause=stopped testId="video"
"#;
    let (mut p, error) = Presenter::boot_with(
        &crate::test_plan(source),
        (),
        (400., 400.),
        1.,
        PathBuf::new(),
        PainterChoice::Cpu,
    )
    .unwrap();
    assert!(error.is_none(), "{error:?}");
    let id = video(&p);
    let key = p.host.kernel().node(id).unwrap().key;
    let session = p.brush.native_session;
    let label = |p: &Presenter<()>| {
        let label = p.host.kernel().find_by_test_id("label")[0];
        let node = p.host.kernel().node_by_key(label).unwrap();
        node.props.str(PropId::Text).unwrap().to_string()
    };
    // Before any report the row says why it never plays.
    assert!(p.media_json()[0]["state"]["unavailable"].is_string());

    // Another painter's session, an event the node does not handle, and a name
    // that is no media event are dropped.
    assert!(!p.reader_media(id, key, session + 1, "pause", "", "", 1.));
    assert!(!p.reader_media(id, key, session, "playing", "", "", 1.));
    assert_eq!(label(&p), "playing");

    assert!(p.reader_media(id, key, session, "pause", "", "", 2.));
    assert_eq!(label(&p), "paused");

    // A state report is the row the agent reads, and its size the node's natural size.
    let state = r#"{"currentTime":3,"duration":10,"paused":true,"playing":false,"playbackRate":1,"videoWidth":640,"videoHeight":360}"#;
    assert!(p.reader_media(id, key, session, "", "", state, 3.));
    let row = &p.media_json()[0]["state"];
    assert_eq!(row["currentTime"], 3.0);
    assert!(row["unavailable"].is_null());
    // The same size again lays nothing out.
    assert!(!p.reader_media(id, key, session, "", "", state, 4.));
}
