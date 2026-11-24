// Compiled with BrowserAutomation.swift to exercise the private queue on its main thread.
private extension BrowserAutomationModule {
    static func checkOverflow() {
        var report: (() -> Void)?
        let context = ExactPackageContext(agent: false, session: "player", changed: { _ in }, log: { _ in }, now: { 0 },
                                          invoke: { _, _, args, _ in
                                              if args["overflow"] as? Bool == true { report?() }
                                          })
        let player = BrowserAutomationModule(context: context)
        var reports = 0
        report = {
            reports += 1
            player.post(["n": 33])
        }
        for n in 0...32 { player.post(["n": n]) }
        for n in 34...40 { player.post(["n": n]) }
        precondition(player.unsent.compactMap { $0["n"] as? Int } == Array(9...40))
        precondition(reports == 1)
    }
}

@main private enum Check {
    static func main() { BrowserAutomationModule.checkOverflow() }
}
