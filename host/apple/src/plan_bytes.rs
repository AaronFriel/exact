//! A plan's bytes at boot, and how they decode.

use exact_plan::Plan;

/// A plan's bytes at boot: copied from while decoding, linked into the
/// program (whose data pool the decoded plan then keeps in place), or a
/// snapshot entry's by its kind (LLP 1126 D2): the headless session's boot,
/// which the running hosts never take, with its props and configuration.
#[derive(Clone, Copy)]
pub(crate) enum PlanBytes<'a> {
    Copied(&'a [u8]),
    Static(&'static [u8]),
    Entry(&'a [u8], &'a str, Option<&'a [u8]>, Option<&'a [u8]>),
}

impl<'a> PlanBytes<'a> {
    /// Bytes from the input buffer: an entry's when a kind names one.
    pub(crate) fn input(bytes: &'a [u8], entry: Option<&'a str>) -> Self {
        match entry {
            Some(kind) => PlanBytes::Entry(bytes, kind, None, None),
            None => PlanBytes::Copied(bytes),
        }
    }

    pub(crate) fn decode(self) -> Result<Plan, exact_plan::PlanError> {
        match self {
            PlanBytes::Copied(bytes) => Plan::decode(bytes),
            PlanBytes::Static(bytes) => Plan::decode_static(bytes),
            PlanBytes::Entry(bytes, kind, _, _) => Plan::decode_snapshot(bytes, kind),
        }
    }
}

/// Apple collection presenters have not implemented the fixed-item geometry
/// yet. Reject the plan before boot, including shapes in inactive branches.
pub(crate) fn has_fixed_collection(plan: &Plan) -> bool {
    use exact_plan::{BindingKind, NodesId, Opcode};
    plan.nodes.iter().enumerate().any(|(i, node)| {
        let virtualized = node.bindings.iter().map(|b| plan.binding(b)).any(|b| {
            b.kind == BindingKind::Prop
                && b.id == exact_kernel::PropId::Virtualized as u16
                && plan.code(b.expr) == [Opcode::Bool as u8, 1, Opcode::Return as u8]
        });
        let parent = Some(NodesId(i as u32));
        virtualized
            && (plan.nodes.iter().filter(|n| n.parent == parent).count()
                + plan.regions.iter().filter(|r| r.parent == parent).count()
                > 1)
    })
}
