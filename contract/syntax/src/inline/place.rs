//! The static steps leading to a component use (LLP 1029.000.002 D1).

use super::{subst_expr, Attr, Expr, Node, Subst};
use std::collections::BTreeMap;
use std::fmt::Write;

pub(super) fn root(component: &str) -> String {
    let mut path = String::new();
    step(&mut path, 'c', component, 0);
    path
}

fn step(path: &mut String, kind: char, name: &str, ordinal: usize) {
    // The length keeps author-supplied ids distinct even when they contain
    // the same delimiters as the surrounding steps.
    write!(path, "{kind}{}:{name}:{ordinal}/", name.len()).unwrap();
}

fn literal_id(attrs: &[Attr], subst: &mut Subst<'_, Expr>) -> Option<String> {
    let attr = attrs.iter().find(|attr| attr.name == "id")?;
    let mut value = subst_expr(&attr.value, subst);
    while let Expr::Typed(inner, _, _) = value {
        value = *inner;
    }
    match value {
        Expr::Str(id, _) => Some(id),
        _ => None,
    }
}

#[derive(Default)]
pub(super) struct Siblings {
    ordinals: BTreeMap<(char, String), usize>,
    ids: BTreeMap<String, usize>,
}

impl Siblings {
    pub(super) fn for_nodes(nodes: &[Node], subst: &mut Subst<'_, Expr>) -> Self {
        let mut siblings = Self::default();
        let branches = Node::walk_with(nodes, (), |node, _| {
            let transparent = matches!(node, Node::When { .. } | Node::Match { .. });
            [transparent.then_some(()); 2]
        });
        for (node, _) in branches {
            if let Node::Element { attrs, .. } = node {
                if let Some(id) = literal_id(attrs, subst) {
                    *siblings.ids.entry(id).or_default() += 1;
                }
            }
        }
        siblings
    }

    pub(super) fn append_step(
        &mut self,
        path: &mut String,
        node: &Node,
        subst: &mut Subst<'_, Expr>,
    ) {
        let (kind, name) = match node {
            Node::Element { tag, .. } => ('e', tag.as_str()),
            Node::Use { name, .. } => ('c', name.as_str()),
            Node::Each { .. } => ('f', ""),
            Node::Children { .. } => ('s', ""),
            Node::When { .. } | Node::Match { .. } => return,
        };
        let next = self.ordinals.entry((kind, name.to_owned())).or_default();
        let ordinal = *next;
        *next += 1;
        if let Node::Element { attrs, .. } = node {
            if let Some(id) = literal_id(attrs, subst).filter(|id| self.ids.get(id) == Some(&1)) {
                step(path, 'i', &id, 0);
                return;
            }
        }
        step(path, kind, name, ordinal);
    }
}
