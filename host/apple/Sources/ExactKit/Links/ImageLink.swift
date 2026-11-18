// @ref LLP 1047.001 D10 — images are a family the composition selects (the
// roster's `Images`): reading and decoding an `image`'s or a box's
// `background-image` source, the session's loader and budget, animated
// GIF/WebP frames, and `image-rendering: pixelated`. The core reaches it only
// through what this file declares. Each slot's default is today's
// implementation, so every app still links images; the family's own target
// will install them instead. Placing a bitmap in its box (`RasterGeometry`)
// is the core's. Icons in text and native views' pictures use this family's
// loader and decoders, and Surfaces' Canvas 2D images read and fetch through
// them, so those products depend on this one.
import CoreGraphics
import QuartzCore

/// A decoded bitmap a view draws.
package protocol ImageBitmap: AnyObject {
    var image: CGImage { get }
    var naturalSize: CGSize { get }
    /// Its headroom over SDR white, else 0.
    var headroom: Float { get }
    var isHDR: Bool { get }
}

/// A view's hold on a decoded bitmap: while a view holds it, the loader
/// keeps its pixels.
package protocol ImageLease: AnyObject {
    /// The lease's identity: a new decode is a new lease.
    var id: UInt64 { get }
    var image: any ImageBitmap { get }
}

/// What the core asks of a session's image loader.
package protocol ImageLoader: AnyObject {
    /// Ask for `view`'s source; false when it was refused at once.
    @discardableResult func load(_ view: NodeView, source: String, resolver: AssetResolver) -> Bool
    /// `view` no longer wants its source.
    func cancel(_ view: UInt32)
    /// `view`'s size or rendering changed: its decode may need another size.
    func resized(_ view: NodeView)
    /// `view`'s dynamic range limit changed.
    func rangeChanged(_ view: NodeView)
    /// The display's scale or colour space changed.
    func displayChanged()
    /// The viewport's size and scale, which set the decode budget.
    func fit(size: CGSize, scale: CGFloat)
    func setPaused(_ paused: Bool)
    /// A source's bytes changed (a dev-loop asset edit).
    func invalidate(_ source: String)
    /// The plan restarted.
    func reset()
    /// The first batch was applied.
    func bootPass()
    /// A batch ended: pictures it held back may be asked again.
    func readmitPictures()
    /// The session ends.
    func shutdown()
    /// Frame health's sample of blank images on screen.
    func sampleBlank()
    /// Drop cold decodes down to `keeping` bytes, or the loader's own share.
    func trimCold(keeping bytes: UInt64?)
    /// Whether an image under `root` is still loading.
    func loading(inside root: NodeView) -> Bool
    /// How many images on screen are still loading (the agent's settle).
    var loadingOnScreen: Int { get }
    /// The loader's state, for the agent.
    var diagnostics: [String: Any] { get }
    /// The HTTP cache's use for encoded images, for the agent.
    var encodedHTTPCache: Any { get }
    /// A native view's picture source changed, or was revoked.
    func pictureChanged(_ source: String)
    func revokePicture(_ source: String)
}

/// What the core asks of animated images' players.
package protocol AnimatedImages: AnyObject {
    /// `view` took a new raster: an animated one gets a player.
    func attach(_ view: NodeView)
    /// The frame `view` shows now, or nil for its raster's own pixels.
    func frame(for view: NodeView) -> CGImage?
    /// Something moved: look again at the next turn.
    func poke()
    /// Show every player's frame at the session clock now (the agent's clock).
    func evaluate()
    /// The players' state, for the agent.
    var diagnostics: [String: Any] { get }
}

/// What the core asks of `image-rendering: pixelated`.
package protocol PixelatedImaging: AnyObject {
    /// Whether `view`'s two-pass sampling owns its image layer.
    func apply(_ view: NodeView) -> Bool
    /// Whether `layer` is a pixelated image's.
    func owns(_ layer: CALayer?) -> Bool
    /// `view`'s and its descendants' tiles, after its transform changed.
    func refresh(under view: NodeView)
    /// Every pixelated image's tiles of `presenter`, after a batch or a
    /// scroll moved or resized what clips it.
    func refresh(in presenter: Presenter)
}

/// The slots are set before any session is made, and read on the main thread.
package enum ImageLink {
    /// A session's loader.
    package static var makeLoader: (() -> any ImageLoader)? = { RasterLoader() }
    /// Animated images' players.
    package static var animated: (any AnimatedImages)? = AnimatedRasters.shared
    /// Pixelated sampling.
    package static var pixelated: (any PixelatedImaging)? = PixelatedSampling()
    /// A scroller moving fast (`true`) or no longer: decode workers yield to it.
    package static var travelling: ((AnyObject, Bool) -> Void)? = { RasterWorkers.shared.travelling($0, $1) }
}

/// `source` with no query or fragment, as a log names it.
package func sourceWithoutQuery(_ source: String) -> String {
    source.unicodeScalars.firstIndex(where: { $0 == "?" || $0 == "#" }).map { String(source.unicodeScalars[..<$0]) } ?? source
}
