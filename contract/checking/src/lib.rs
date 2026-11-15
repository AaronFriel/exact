//! Checking views retain the exact typed expansion and authored provenance.
//! No view or visit exposes an AST node or its children to a checking pass.
//! @ref LLP 1172.019 §2 item 4; LLP 1172.013 E1, §4 step 4.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use contract_syntax::{Attr, Expr, Node, Span};
use contract_types::{Checked, Scope};
use std::collections::BTreeMap;
use std::sync::Arc;

mod values;
pub use values::value_leaves;
#[cfg(test)]
mod census;
#[cfg(test)]
mod tests;

/// A borrowed checking representation: type obligations and expansion stay
/// owned by `Checked`, rather than reconstructed from a lowered syntax tree.
pub struct Checking<'a> {
    checked: &'a Checked<'a>,
    declarations: BTreeMap<&'a str, usize>,
}

impl<'a> Checking<'a> {
    /// Retain the type checker's output without cloning or re-expanding it.
    pub fn new(checked: &'a Checked<'a>) -> Self {
        Self {
            checked,
            declarations: checked
                .file
                .components
                .iter()
                .enumerate()
                .map(|(i, c)| (c.name.as_str(), i))
                .collect(),
        }
    }

    /// Declaration facts in source order, without a component's view tree.
    pub fn declarations(&self) -> impl ExactSizeIterator<Item = Declaration<'a>> {
        self.checked
            .file
            .components
            .iter()
            .zip(&self.checked.types.components)
            .map(|(component, types)| Declaration { component, types })
    }

    /// A declaration identified by a component invocation.
    pub fn declaration(&self, index: usize) -> Declaration<'a> {
        Declaration {
            component: &self.checked.file.components[index],
            types: &self.checked.types.components[index],
        }
    }

    /// Function and record types shared with expression inference.
    pub fn shapes(&self) -> &'a contract_types::Shapes {
        &self.checked.types.shapes
    }

    /// Root actions include the lifted declarations checked by inference.
    pub fn actions(&self, component: usize) -> &'a [contract_syntax::Action] {
        if component == 0 {
            &self.checked.expanded.root.actions
        } else {
            &self.checked.file.components[component].actions
        }
    }

    /// An unknown invocation's diagnostic still uses the authored vocabulary.
    pub fn unknown_component_message(&self, name: &str) -> String {
        self.checked.file.unknown_component_message(name)
    }

    /// The authored view with its checked declaration scope. The root uses
    /// lifted declarations, as analysis did before this representation.
    pub fn authored(&'a self, component: usize) -> View<'a> {
        let c = &self.checked.file.components[component];
        let scoped = if component == 0 {
            &self.checked.expanded.root
        } else {
            c
        };
        View {
            nodes: &c.view,
            declarations: &self.declarations,
            scope: self
                .checked
                .types
                .component_scope(scoped, &self.checked.types.components[component]),
            shapes: &self.checked.types.shapes,
        }
    }

    /// The expanded root, keeping the row ownership used during inference.
    pub fn expanded(&'a self) -> View<'a> {
        let c = &self.checked.expanded.root;
        View {
            nodes: &c.view,
            declarations: &self.declarations,
            scope: self
                .checked
                .types
                .component_scope(c, &self.checked.types.components[0]),
            shapes: &self.checked.types.shapes,
        }
    }
}

/// A checked view; its tree can only be read through traversal.
pub struct View<'a> {
    nodes: &'a [Node],
    declarations: &'a BTreeMap<&'a str, usize>,
    scope: Scope,
    shapes: &'a contract_types::Shapes,
}

impl<'a> View<'a> {
    /// Declaration scope for expressions outside the view's regions.
    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// Every node, in source order, without inferring region subjects.
    /// Structural checks must also see arms whose subject could not be typed.
    pub fn walk(&self) -> impl Iterator<Item = Visit<'a>> {
        self.walk_with((), |_, _| ()).map(|(visit, ())| visit)
    }

    /// One inherited fact per subtree, with sibling and arm isolation.
    /// O(nodes) descent, O(depth) heap frames, no recursive Rust calls.
    /// `descend` runs before yielding the parent and selects its children's fact.
    pub fn walk_with<C: Clone>(
        &self,
        context: C,
        mut descend: impl FnMut(Visit<'a>, &C) -> C,
    ) -> impl Iterator<Item = (Visit<'a>, C)> {
        let declarations = self.declarations;
        Node::walk_with(self.nodes, context, move |node, context| {
            let child = descend(Visit { node, declarations }, context);
            [Some(child.clone()), Some(child)]
        })
        .map(|(node, context)| (Visit { node, declarations }, context))
    }

    /// Names resolved under the plan's region frames. Subjects are inferred
    /// once per region; siblings share immutable scope frames. Work includes
    /// subject inference, and storage is O(view depth × scope depth).
    pub fn scoped(&self) -> impl Iterator<Item = (Visit<'a>, Arc<Scope>)> {
        let shapes = self.shapes;
        let declarations = self.declarations;
        Node::walk_with(
            self.nodes,
            Arc::new(self.scope.clone()),
            move |node, scope| contract_types::view_frames(node, scope, shapes),
        )
        .map(|(node, scope)| (Visit { node, declarations }, scope))
    }
}

/// A single node's facts, never the tree beneath it.
#[derive(Clone, Copy)]
pub struct Visit<'a> {
    node: &'a Node,
    declarations: &'a BTreeMap<&'a str, usize>,
}

impl<'a> Visit<'a> {
    /// Authored source identity and token range.
    pub fn span(self) -> Span {
        self.node.span()
    }

    /// An element's tag, positional values and attributes. Child lists are private.
    pub fn element(self) -> Option<(&'a str, &'a [Expr], &'a [Attr])> {
        match self.node {
            Node::Element {
                tag,
                positional,
                attrs,
                ..
            } => Some((tag, positional, attrs)),
            _ => None,
        }
    }

    /// A component invocation's declaration identity, authored name and arguments.
    /// Unknown declarations retain their name for admission diagnostics.
    pub fn component_use(self) -> Option<(Option<usize>, &'a str, &'a [Attr])> {
        match self.node {
            Node::Use { name, args, .. } => {
                Some((self.declarations.get(name.as_str()).copied(), name, args))
            }
            _ => None,
        }
    }
}

/// Component declaration facts, with the view kept private.
#[derive(Clone, Copy)]
pub struct Declaration<'a> {
    component: &'a contract_syntax::Component,
    types: &'a contract_types::ComponentTypes,
}

impl<'a> Declaration<'a> {
    /// Authored component name.
    pub fn name(self) -> &'a str {
        &self.component.name
    }
    /// Explicit parameters in declaration order.
    pub fn props(self) -> &'a [contract_syntax::Param] {
        &self.component.props
    }
    /// Injected parameters, after explicit parameters in the typed scope.
    pub fn injects(self) -> &'a [contract_syntax::Param] {
        &self.component.injects
    }
    /// Provider expressions evaluated in this declaration's scope.
    pub fn provides(self) -> &'a [contract_syntax::Binding] {
        &self.component.provides
    }
    /// Inferred explicit and injected parameter types, in scope order.
    pub fn prop_types(self) -> &'a [contract_types::Ty] {
        &self.types.props
    }
}
