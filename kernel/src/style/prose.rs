//! The HTML user agent margins and list indentation for native layout
//! (HTML §15.3.3 and §15.3.7). Web hosts use the browser's sheet.

use crate::arena::NodeArena;
use crate::{Direction, NodeType, PropId, StyleId};
use taffy::prelude::length;

fn list(tag: &str) -> bool {
    matches!(tag, "ul" | "ol")
}

pub(crate) fn styled(arena: &NodeArena, slot: u32) -> bool {
    matches!(
        (
            arena.node_type(slot),
            arena.props(slot).str(PropId::SemanticTag)
        ),
        (
            NodeType::View,
            Some("ul" | "ol" | "dl" | "dd" | "blockquote")
        ) | (NodeType::Text, Some("p"))
    )
}

pub(crate) fn apply(arena: &NodeArena, slot: u32, s: &mut taffy::style::Style) {
    if !styled(arena, slot) {
        return;
    }
    let tag = arena.props(slot).str(PropId::SemanticTag).unwrap();
    let mask = arena.style(slot).mask;
    let rtl = arena.computed_source(slot, StyleId::Direction).direction == Direction::Rtl;
    if tag == "dd" {
        if rtl && !mask.has(StyleId::MarginRight) {
            s.margin.right = length(40.);
        } else if !rtl && !mask.has(StyleId::MarginLeft) {
            s.margin.left = length(40.);
        }
        return;
    }
    if tag == "blockquote" {
        if !mask.has(StyleId::MarginLeft) {
            s.margin.left = length(40.);
        }
        if !mask.has(StyleId::MarginRight) {
            s.margin.right = length(40.);
        }
    }
    if list(tag) {
        if rtl && !mask.has(StyleId::PaddingRight) {
            s.padding.right = length(40.);
        } else if !rtl && !mask.has(StyleId::PaddingLeft) {
            s.padding.left = length(40.);
        }
        let mut ancestor = arena.parent(slot);
        while let Some(parent) = ancestor {
            if arena
                .props(parent)
                .str(PropId::SemanticTag)
                .is_some_and(list)
            {
                return;
            }
            ancestor = arena.parent(parent);
        }
    }
    let em = arena.computed_source(slot, StyleId::FontSize).font_size;
    if !mask.has(StyleId::MarginTop) {
        s.margin.top = length(em);
    }
    if !mask.has(StyleId::MarginBottom) {
        s.margin.bottom = length(em);
    }
}
