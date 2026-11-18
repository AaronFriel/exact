@testable import ExactKit

extension ExactSession {
    /// The session's image loader as the built-in implementation, for tests
    /// that read its internals (`ImageLink.makeLoader`'s default).
    var loader: RasterLoader { rasters as! RasterLoader }
}
