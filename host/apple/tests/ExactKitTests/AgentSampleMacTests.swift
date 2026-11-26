#if os(macOS)
import AppKit
import XCTest
@testable import ExactKit

extension SplitMacTests {
    func testSampleRefusesAnUnreadableLayerOnlyWhereItContributes() throws {
        let session = try boot(tabs: false, size: CGSize(width: 900, height: 500))
        _ = compose(ExactView(session: session), width: 900, sidebar: false)
        session.presenter.press(try node("row-a").id)
        let agent = Agent(session: session), node = try node("half-a")
        let window = try XCTUnwrap(window)
        XCTAssertNil(agent.sample(["points": [[0, 0]]])["error"])
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.orderFrontRegardless()
        let parent = try XCTUnwrap(node.layer)
        let metal = CAMetalLayer(), cover = CALayer()
        metal.frame = parent.bounds
        cover.frame = parent.bounds.divided(atDistance: parent.bounds.width / 2, from: .minXEdge).slice
        cover.backgroundColor = CGColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)
        cover.zPosition = 2
        parent.addSublayer(cover)
        parent.addSublayer(metal)
        let box = agent.box(node)
        func sample(_ fraction: CGFloat) -> [String: Any] {
            agent.sample(["points": [[box.minX + fraction * box.width, box.midY]]])
        }
        let covered = sample(0.25)
        XCTAssertEqual((covered["values"] as? [[Double]])?.first, [0, 1, 0, 1], "\(covered)")
        XCTAssertTrue((sample(0.75)["error"] as? String)?.contains("half-a") == true)
        cover.opacity = 0.5
        XCTAssertTrue((sample(0.25)["error"] as? String)?.contains("Metal") == true)
        metal.isHidden = true
        XCTAssertNil(sample(0.25)["error"])
        XCTAssertTrue(parent.sublayers?.last === metal)
    }
}
#endif
