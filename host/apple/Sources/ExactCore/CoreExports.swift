// @ref LLP 1047.001 D10 — the C exports a family owns that ExactCore calls.
// ExactCore reaches each through a slot here, never by name, so an app
// without the family links no call to an export its archive does not emit
// (D3). Each slot's default is the export, so every app still links it; the
// family's own target will install it instead. A nil slot answers what the
// family's absence means, written at each call site.
import CExact

package enum CoreExports {
    /// Which SVG modules a plan can need (bit 1: islands, bit 2: filters);
    /// absent, none.
    package static var svgIslands: ((ExactRuntime) -> UInt8)? = exact_svg_islands
}
