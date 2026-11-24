#if os(macOS)
import AppKit
import XCTest
@testable import ExactKit
import ExactCore

/// A window's frame changed in steps: an animation a module's call asks for
/// (expo/exact#1412).
final class WindowFrameMacTests: XCTestCase {
    /// A session on a page whose root fills and clips the window, in Exact's window.
    private func page(_ size: NSSize) throws -> (ExactSession, ExactView, ExactSessionWindow) {
        _ = NSApplication.shared
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = """
        component App
          view
            main width="100%" height="100%" overflow="hidden"
              text "corner"

        """
        let contract = dir.appendingPathComponent("app.contract"), plan = dir.appendingPathComponent("app.plan")
        try source.write(to: contract, atomically: true, encoding: .utf8)
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: try XCTUnwrap(ProcessInfo.processInfo.environment["EXACT_CONTRACT"]))
        compiler.arguments = ["build", contract.path, "-o", plan.path]
        try compiler.run(); compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0)
        let session = ExactApp.shared.makeSession(label: "window-frame")
        XCTAssertNil(session.boot(plan: try Data(contentsOf: plan), size: size).error)
        let view = ExactView(session: session)
        let window = ExactSessionWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFrontRegardless() // AppKit animates only a window on screen
        view.layoutSubtreeIfNeeded()
        return (session, view, window)
    }

    func testAnAnimatedResizeAskedInsideACallLaysOutEachStep() throws {
        let (session, _, window) = try page(NSSize(width: 600, height: 400))
        defer { window.close(); session.destroy() }
        let p = session.presenter
        // The viewport and the root's laid-out size at each step.
        var steps: [(viewport: NSSize, root: NSSize)] = []
        let observer = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: nil) { _ in
            steps.append((p.viewport.contentView.bounds.size, p.root.subviews.first?.frame.size ?? .zero))
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        for change: CGFloat in [200, -200] {
            steps = []
            var target = window.frame
            target.size.width += change
            target.size.height += change
            let before = window.frame
            Owner.shared.sync({ Owner.shared.callMain { window.setFrame(target, display: true, animate: true) } }, busy: ())
            XCTAssertEqual(window.frame, before, "the animation runs after the call")
            drain(5) { window.frame == target }
            XCTAssertEqual(window.frame, target)
            XCTAssertFalse(steps.isEmpty, "the frame changed")
            for (viewport, root) in steps { XCTAssertEqual(root, viewport, "each step is laid out at its size") }
        }
    }

    /// A frame change made after the animation was asked for, in the call or
    /// before its turn, is the window's frame: the animation does not undo it.
    func testAFrameChangeAfterADeferredAnimationWins() throws {
        let (session, _, window) = try page(NSSize(width: 600, height: 400))
        defer { window.close(); session.destroy() }
        let start = window.frame
        var animated = start, set = start
        animated.size.width -= 100
        set.size.width += 100
        Owner.shared.sync({ Owner.shared.callMain {
            window.setFrame(animated, display: true, animate: true)
            window.setFrame(set, display: true)
        } }, busy: ())
        drain(0.5)
        XCTAssertEqual(window.frame, set)
        for change in [{ window.setContentSize(NSSize(width: 500, height: 300)) }, { window.setFrameOrigin(NSPoint(x: 40, y: 60)) }] {
            Owner.shared.sync({ Owner.shared.callMain { window.setFrame(start, display: true, animate: true) } }, busy: ())
            change()
            let changed = window.frame
            drain(0.5)
            XCTAssertEqual(window.frame, changed)
        }
    }

    /// A window not on screen takes its frame inside the call.
    func testAHiddenWindowTakesItsFrameAtOnce() throws {
        let (session, _, window) = try page(NSSize(width: 600, height: 400))
        defer { window.close(); session.destroy() }
        window.orderOut(nil)
        var target = window.frame
        target.size.width += 100
        Owner.shared.sync({ Owner.shared.callMain { window.setFrame(target, display: true, animate: true) } }, busy: ())
        XCTAssertEqual(window.frame, target)
    }

    /// Runs the main run loop for `seconds`, or until `done`.
    private func drain(_ seconds: TimeInterval, until done: () -> Bool = { false }) {
        let end = Date().addingTimeInterval(seconds)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
}
#endif
