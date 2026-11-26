// WebKit's viewport insets (@ref LLP 1123 D15) and Mac pinch scale (@ref LLP 1020.002 §9).
import WebKit

#if os(macOS)
import AppKit

extension ExactWebView {
    func pinInsets() {
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView {
                if s.automaticallyAdjustsContentInsets { s.automaticallyAdjustsContentInsets = false }
                if s.contentInsets.top != 0 || s.contentInsets.left != 0 || s.contentInsets.bottom != 0 || s.contentInsets.right != 0 {
                    s.contentInsets = NSEdgeInsetsZero
                }
            }
            v.subviews.forEach(walk)
        }
        walk(self)
    }

    func configureMagnification(_ word: String?, id: UInt32) {
        guard word != magnificationWord else { return }
        magnificationWord = word
        if let word {
            guard let factor = Double(word), (0.001...256).contains(factor) else {
                FileHandle.standardError.write(Data("exact: iframe \(id): apple.magnification needs a finite number from 0.001 through 256, got \(word)\n".utf8))
                return
            }
            authoredMagnification = CGFloat(factor)
            restoreMagnification()
        } else if authoredMagnification != nil {
            authoredMagnification = nil
            setMagnification(1, centeredAt: .zero)
        }
    }

    func restoreMagnification() {
        if let authoredMagnification { setMagnification(authoredMagnification, centeredAt: .zero) }
    }
}
#elseif os(iOS)
import UIKit

extension WebArm {
    /// The obscured insets and their viewport range, where the frame's options say them: a word said
    /// and then dropped gives WebKit back its default.
    func applyInsets(to web: WKWebView, said: (String) -> Bool) {
        // How much of the guest lies under its owner's bars and band, top left bottom right (LLP 1123
        // D15): WebKit lays the page's fixed and sticky content and its visible rect out clear of it, as
        // in a web view pinned under a navigation bar
        if #available(iOS 26.0, *), said("obscured") {
            let o = (options["obscured"] as? [NSNumber])?.map(\.doubleValue) ?? [0, 0, 0, 0]
            let insets = o.count == 4 ? UIEdgeInsets(top: o[0], left: o[1], bottom: o[2], right: o[3]) : .zero
            if web.obscuredContentInsets != insets { web.obscuredContentInsets = insets }
        }
        // The range those insets move through, least then most: WebKit's large viewport clears the
        // least and its small viewport the most, as under bars that collapse (`lvh`, `svh`)
        if said("viewportRange") {
            let r = (options["viewportRange"] as? [NSNumber])?.map(\.doubleValue) ?? []
            let edges = { (i: Int) in r.count == 8 ? UIEdgeInsets(top: r[i], left: r[i + 1], bottom: r[i + 2], right: r[i + 3]) : .zero }
            let (least, most) = (edges(0), edges(4))
            if web.minimumViewportInset != least || web.maximumViewportInset != most {
                web.setMinimumViewportInset(least, maximumViewportInset: most)
            }
        }
    }
}
#endif
