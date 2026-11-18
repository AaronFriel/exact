// @ref LLP 1047.001 D10 — the C exports a family owns that ExactCore calls.
// ExactCore reaches each through a slot here, never by name, so an app
// without the family links no call to an export its archive does not emit
// (D3). A slot's default is the export while its family is in ExactKit; a
// family with its own target sets it from its installer (SVG's does). A nil
// slot answers what the family's absence means, written at each call site.
import CExact

package enum CoreExports {
    /// Which SVG modules a plan can need (bit 1: islands, bit 2: filters);
    /// absent, none.
    package static var svgIslands: ((ExactRuntime) -> UInt8)?
    /// A windowed list's feedback (its fills and reports); absent, the
    /// session sends none, and a call answers `Runtime.noFeedback`.
    package static var collectionFeedback: ((ExactRuntime, Int, Double) -> UInt32)? = exact_collection_feedback
    /// What UIKit covers of a list's port; absent, not told.
    package static var listCovered: ((ExactRuntime, UInt32, Double, Double) -> Void)? = exact_list_covered
    /// A row's index by key; absent, none.
    package static var listIndex: ((ExactRuntime, UInt32, UInt32) -> UInt32)? = exact_list_index
    /// A list's text between two positions; absent, none.
    package static var listText: ((ExactRuntime, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32) -> UInt32)? = exact_list_text
    /// A list's fixed lead or trail size, its snap position and its snap
    /// stop; absent, none (not finite).
    package static var collectionFixedSize: ((ExactRuntime, UInt32, UInt32, UInt32, UInt32) -> Double)? = exact_collection_fixed_size
    package static var collectionSnap: ((ExactRuntime, UInt32, Double, Double, Double, Double, Double) -> Double)? = exact_collection_snap
    package static var collectionSnapStop: ((ExactRuntime, UInt32, Double, Double, Double, Double, Double) -> Double)? = exact_collection_snap_stop
}

extension Runtime {
    /// What a list's feedback answers when no list family is linked. Applied,
    /// it would clear running motion and timers, so the session does not ask.
    static let noFeedback = Batch(ops: [], timers: false, motion: false, clock: nil, error: nil)
}
