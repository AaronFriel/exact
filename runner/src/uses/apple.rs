//! What a plan uses on Apple, which links its Swift families and the
//! runner's seams by use (LLP 1047.001 D10, D11).
//!
//! @ref LLP 1047.001 D10 (a family's use rule covers every plan that reaches its code)
//!
//! [`uses`] is what the web, Android and Linux link and admit, and their
//! compatibility ids name it. The native roster's entries and Apple's own
//! reading of a shared one are added here, so those hosts do not move.

use super::{constant_str, uses, Capability, Uses};
use exact_kernel::{PropId, StyleId};
use exact_plan::{BindingKind, Plan};

/// What `plan` uses on Apple: [`uses`], with [`Capability::Grid`] the grid
/// algorithm, which Apple links by use, for a plan whose layout can reach it
/// ([`lays_out_grid`]), and the native roster's entries. A native host
/// parses the grid rows whatever it links, so a grid row alone does not need
/// the algorithm. The browser lays out a grid itself, and the other native
/// hosts link the algorithm whole, so for them the capability is the rows'
/// grammars.
pub fn apple_uses(plan: &Plan) -> Uses {
    let mut uses = uses(plan).beyond(Uses::NONE.with(Capability::Grid));
    if lays_out_grid(plan) {
        uses = uses.with(Capability::Grid);
    }
    // An event-only or a view-only package reaches the module seam too.
    if !plan.modules.is_empty() || !plan.views.is_empty() || !plan.module_events.is_empty() {
        uses = uses.with(Capability::Modules);
    }
    if !plan.tools.is_empty() {
        uses = uses.with(Capability::Tools);
    }
    uses
}

/// Whether laying out `plan` can reach the grid algorithm: a `display` that
/// can be `grid`, or a node that can be a table's part (`table`, `caption`,
/// a row group, `tr`, `th`, `td`), which the kernel lays out as a grid,
/// with an anonymous table around a part outside one (LLP 1153 D7.3). A
/// computed value counts as either.
pub fn lays_out_grid(plan: &Plan) -> bool {
    plan.bindings.iter().any(|binding| {
        let can_be = |used: &dyn Fn(&str) -> bool| {
            constant_str(plan, plan.code(binding.expr)).is_none_or(used)
        };
        match binding.kind {
            BindingKind::Style => {
                StyleId::from_bit(u32::from(binding.id)) == Some(StyleId::Display)
                    && can_be(&|v| v.trim().eq_ignore_ascii_case("grid"))
            }
            BindingKind::Prop => {
                PropId::from_wire(binding.id) == Some(PropId::SemanticTag)
                    && can_be(&|v| {
                        matches!(
                            v,
                            "table" | "caption" | "thead" | "tbody" | "tfoot" | "tr" | "th" | "td"
                        )
                    })
            }
        }
    })
}

#[cfg(test)]
#[path = "apple_tests.rs"]
mod tests;
