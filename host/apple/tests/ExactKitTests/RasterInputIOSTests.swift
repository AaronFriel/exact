#if os(iOS)
import UIKit
import XCTest
@testable import ExactKit

final class RasterInputIOSTests: XCTestCase {
    func testTrimRemovesColdFilesOffMainAndKeepsLiveInputs() throws {
        XCTAssertTrue(Thread.isMainThread)
        let presenter = Presenter(), loader = RasterLoader()
        let resolver = AssetResolver(root: Bundle.main.bundleURL)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
        presenter.viewport.frame = window.bounds
        window.addSubview(presenter.viewport); window.makeKeyAndVisible()
        defer {
            RasterInput.testDidRemove = nil
            loader.shutdown(); window.isHidden = true
        }
        let data = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let name = "data:image/png;base64," + data.base64EncodedString()
        let live = try RasterInput.open(name, resolver: resolver)
        var nodes: [NodeView] = []
        for id in 1...3 {
            let node = NodeView(id: UInt32(id), kind: "image", presenter: presenter)
            presenter.views[node.id] = node; presenter.viewport.addSubview(node)
            node.frame = CGRect(x: 0, y: id * 20, width: 8, height: 8)
            node.loadGeneration = 1
            loader.load(node, source: name + String(repeating: " ", count: id), resolver: resolver)
            nodes.append(node)
        }
        waitFor("all three images decoded") { nodes.allSatisfy { $0.raster != nil } }
        let removed = expectation(description: "all cold spool files removed")
        removed.expectedFulfillmentCount = nodes.count
        RasterInput.testDidRemove = { url in
            XCTAssertFalse(Thread.isMainThread, "trim must not unlink files on the UI thread")
            XCTAssertNotEqual(url, live.url)
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            removed.fulfill()
        }
        for node in nodes { loader.cancel(node.id); node.raster = nil }
        loader.trimCold()
        wait(for: [removed], timeout: 10)
        RasterInput.testDidRemove = nil
        XCTAssertEqual(try live.bytes(), data)
        let replacement = try RasterInput.open(name, resolver: resolver)
        XCTAssertNotEqual(replacement.url, live.url, "each spool owns a unique path")
        XCTAssertEqual(try replacement.bytes(), data)
        withExtendedLifetime((live, replacement)) {}
    }
}
#endif
