// A native screen's controller in the controller its node shows in (LLP
// 1075.003 §3.6): contained, moved and released with its node.
#if os(iOS) || os(tvOS)
import ExactKit
import UIKit

extension NativeViews {
    /// A native screen (LLP 1075.003 §3.6): its controller becomes a child
    /// of the controller its node shows in (a route's), so UIKit gives it
    /// appearance calls, the safe area and traits, in UIKit's order: added
    /// as a child, its view `insert`ed, then moved in. A node created in the
    /// batch that mounts its route is in no controller yet: it is contained
    /// once that batch is applied. A contained screen whose node comes to
    /// show in another controller moves to it (`moved`).
    func contain(_ entry: NativeEntry, table: NativeTable, retry: Bool = true, insert: () -> Void = {}) {
        guard let handle = entry.handle, let made = table.platformController?(handle), let owner = entry.owner else { return insert() }
        let screen = Unmanaged<UIViewController>.fromOpaque(made).takeUnretainedValue()
        // A node in a route is its route controller's, which the route may
        // not have yet: one built with its tab or pushed with this node
        // (LLP 1075.003 §9.14). Until it has, no controller above holds it.
        var responder: UIResponder? = owner, route: NodeView?
        while let next = responder, !(next is UIViewController) {
            if route == nil, let node = next as? NodeView, node.props["navigationKey"] != nil, node.props["navigationBack"] == nil { route = node }
            responder = next.next
        }
        let found = responder as? UIViewController
        guard let parent = route.map({ $0.routeController(in: found) }) ?? found else {
            if screen.parent != nil { detach(entry, screen) }
            insert()
            guard retry, let presenter = owner.presenter else { return log("\(entry.name) #\(entry.id): a screen with no controller to hold it") }
            presenter.afterBatch { [weak self, weak entry] in
                guard let self, let entry, self.entries[entry.id] === entry, entry.screen == nil,
                      case .success(let table)? = NativeProcess.table else { return }
                self.contain(entry, table: table, retry: false)
            }
            return
        }
        if screen.parent != nil, screen.parent !== parent {
            screen.willMove(toParent: nil)
            screen.removeFromParent()
        }
        let adds = screen.parent !== parent
        if adds { parent.addChild(screen) }
        insert()
        if adds { screen.didMove(toParent: parent) }
        entry.screen = screen
        if adds { log("\(entry.name) #\(entry.id): a screen in \(type(of: parent))") }
    }

    /// `subtree` shows in another controller: a route's controller has
    /// loaded its view, or a dialog has gone into its sheet or come back.
    /// Each screen under it, contained or still waiting, goes to the
    /// controller it shows in now.
    func moved(_ subtree: NodeView) {
        guard case .success(let table)? = NativeProcess.table else { return }
        for entry in entries.values where entry.owner?.isDescendant(of: subtree) == true {
            contain(entry, table: table, retry: false)
        }
    }

    /// `subtree` is about to show in another controller: each screen under
    /// it leaves its parent first, so that UIKit never finds its view in a
    /// window under a controller that is not its parent. `moved` contains
    /// it again.
    func leaving(_ subtree: NodeView) {
        for entry in entries.values where entry.owner?.isDescendant(of: subtree) == true {
            if let screen = entry.screen { detach(entry, screen) }
        }
    }

    private func detach(_ entry: NativeEntry, _ screen: UIViewController) {
        screen.willMove(toParent: nil)
        screen.removeFromParent()
        entry.screen = nil
    }

    /// A screen's view leaves with its controller, in UIKit's order; a plain
    /// module view just leaves.
    func release(_ entry: NativeEntry) {
        guard let screen = entry.screen else { return }
        screen.willMove(toParent: nil)
        entry.view?.removeFromSuperview()
        screen.removeFromParent()
        entry.screen = nil
    }
}
#endif
