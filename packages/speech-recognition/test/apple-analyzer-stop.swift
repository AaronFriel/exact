import ExactPackage
import Foundation

private final class FakeTrackOwner: ExactTrackOwner {
    var activeLeases = 0
    func subscribe(_ id: String, _ consumer: ExactTrackConsumer, start: Bool, cause: ExactTrackCause) throws -> ExactSubscription {
        activeLeases += 1
        return ExactSubscription { [weak self] in
            self?.activeLeases -= 1
        }
    }
}

@main
private struct AnalyzerStopTest {
    static func pump(until condition: () -> Bool, timeout: TimeInterval = 5.0) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return condition()
    }

    static func main() {
        let tracks = ExactTracks()
        let owner = FakeTrackOwner()
        tracks.add(ExactTrackEntry(id: "audio-1", kind: "audio", owner: owner))

        let context = ExactPackageContext(
            agent: false, session: "analyzer-stop-test",
            changed: { _ in }, log: { _ in }, now: { 0 },
            tracks: tracks
        )
        let module = SpeechRecognitionModule(context: context)

        func startTrack() -> String {
            var started: [String: Any]?
            module.later("startSpeechRecognition", ["track": "audio-1"], preferred: nil) { started = $0 }
            guard let id = started?["id"] as? String, !id.isEmpty else {
                fail("startSpeechRecognition did not return id: \(String(describing: started))")
            }
            return id
        }

        // 1. Mid-flight stop (and a concurrent second stop) during AnalyzerEngine setup settles and releases the track lease.
        let r1 = startTrack()
        guard owner.activeLeases == 1 else { fail("expected active lease 1, got \(owner.activeLeases)") }
        var stopA: [String: Any]?
        var stopB: [String: Any]?
        module.later("stopSpeechRecognition", ["recognition": r1], preferred: nil) { stopA = $0 }
        module.later("stopSpeechRecognition", ["recognition": r1], preferred: nil) { stopB = $0 }
        guard pump(until: { stopA != nil && stopB != nil && owner.activeLeases == 0 }) else {
            fail("mid-flight stop hung or leaked lease: stopA=\(String(describing: stopA)) stopB=\(String(describing: stopB)) leases=\(owner.activeLeases)")
        }
        var state1: [String: Any]?
        module.later("speechRecognitionState", ["recognition": r1], preferred: nil) { state1 = $0 }
        guard state1?["state"] as? String == "ended" else {
            fail("expected ended state after stop, got \(String(describing: state1))")
        }

        // 2. Mid-flight abort during AnalyzerEngine setup settles with "aborted" and releases the track lease.
        let r2 = startTrack()
        guard owner.activeLeases == 1 else { fail("expected active lease 1 for r2, got \(owner.activeLeases)") }
        var aborted: [String: Any]?
        module.later("abortSpeechRecognition", ["recognition": r2], preferred: nil) { aborted = $0 }
        guard pump(until: { aborted != nil && owner.activeLeases == 0 }) else {
            fail("mid-flight abort hung or leaked lease: aborted=\(String(describing: aborted)) leases=\(owner.activeLeases)")
        }
        guard aborted?["error"] as? String == "aborted" else {
            fail("expected aborted error, got \(String(describing: aborted))")
        }

        // 3. destroy() during AnalyzerEngine setup settles and releases the track lease.
        _ = startTrack()
        guard owner.activeLeases == 1 else { fail("expected active lease 1 for r3, got \(owner.activeLeases)") }
        var destroyed = false
        module.destroy { destroyed = true }
        guard pump(until: { destroyed && owner.activeLeases == 0 }) else {
            fail("destroy hung or leaked lease: destroyed=\(destroyed) leases=\(owner.activeLeases)")
        }

        // Let any cancelled setup tasks drain cleanly without crashing.
        let settle = Date(timeIntervalSinceNow: 0.1)
        while Date() < settle { RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01)) }
        guard owner.activeLeases == 0 else { fail("late task re-acquired lease: \(owner.activeLeases)") }
        print("analyzer stop+abort ok")
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        exit(1)
    }
}
