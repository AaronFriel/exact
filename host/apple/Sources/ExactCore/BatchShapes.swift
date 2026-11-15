// Inline values and compound envelope values on the Apple JSON wire. Record
// readers come from kernel/tables/schema.json (LLP 1172.001 E4, §4 step 4).
import Foundation

extension BatchReader {
    /// A `canvas2d` op's lists, `[address, length]` pairs in the runtime's
    /// memory (LLP 1056 D4), copied out now: the runtime keeps them alive
    /// only until its next batch with lists.
    package static func canvasLists(_ value: Any?) -> [Data] {
        (value as? [Any] ?? []).compactMap { pair in
            guard let n = pair as? [Any], n.count == 2, let at = (n[0] as? NSNumber)?.uintValue,
                  let count = (n[1] as? NSNumber)?.intValue, count >= 0,
                  let from = UnsafeRawPointer(bitPattern: at) else { return nil }
            return Data(bytes: from, count: count)
        }
    }

    package mutating func batchModes() throws -> [String: String]? {
        if case .object(let object) = try value() { return object.compactMapValues { $0.string } }
        return nil
    }

    package mutating func batchOrientation() throws -> OrientationRequest? {
        if case .object(let object) = try value() { return OrientationRequest(object) }
        return nil
    }

    package mutating func batchSequence() throws -> (UInt64, UInt64)? {
        let range = try array { try $0.number() }
        if range.count == 2, range.allSatisfy({ $0 >= 0 && $0 == $0.rounded() }) { return (UInt64(range[0]), UInt64(range[1])) }
        return nil
    }

    package mutating func batchOp() throws -> BatchOp {
        try enter(123)
        // Rust writes the discriminator first. JSON object order is not part of
        // the contract: other writers take the typed-value path below, also in
        // one pass. Only the rare adapters finally bridge their payload to Any.
        let first = try string(); try expect(58)
        if first != "op" {
            var fields = [first: try value()]
            while !take(125) {
                try expect(44)
                let key = try string(); try expect(58)
                let value = try value()
                if fields[key] == nil { fields[key] = value }
            }
            depth -= 1
            return try BatchFields(fields).op(colorChannels: colorChannels)
        }
        let name = try string()
        var op = BatchOp(op: BatchOp.Kind(rawValue: name) ?? .unknown)
        if op.isAdapter {
            var payload: NodeStyle = ["op": .string(name)]
            while !take(125) {
                try expect(44)
                let key = try string(); try expect(58)
                payload[key] = try value()
            }
            depth -= 1
            op.nodeID = try BatchFields(payload).id("id")
            op.payload = payload.mapValues(\.any)
            if op.op == .canvas2d { op.payload["lists"] = BatchReader.canvasLists(op.payload["lists"]) }
            return op
        }
        while !take(125) {
            try expect(44)
            let key = try string(); try expect(58)
            if try null() { continue }
            try recordField(&op, key: key)
        }
        depth -= 1
        return op
    }

    package mutating func inline() throws -> InlineText {
        var id: UInt32?, parent: UInt32?, props: [String: String] = [:]
        var style = InlineStyle(), handlers: Set<String> = [], paints = false, opacity = 1.0
        try object { r, key in
            switch key {
            case "id": id = try r.id()
            case "parent": parent = try r.id()
            default:
                if try r.null() { return }
                switch key {
                case "props": props = try r.strings()
                case "style": style = try r.inlineStyle()
                case "handlers": handlers = Set(try r.array { try $0.string() })
                case "paint": paints = try r.bool()
                case "opacity": opacity = try r.number()
                default: try r.skip()
                }
            }
        }
        guard let id, let parent else { throw Invalid.wire }
        return InlineText(id: id, parent: parent, props: props, style: style, handlers: handlers, paints: paints, opacity: opacity)
    }
    package mutating func inlineStyle() throws -> InlineStyle {
        var style = InlineStyle(), height: BatchValue?
        try object { r, key in
            switch key {
            case "line_height": height = try r.value()
            default: try style.set(key, r.value(), colorChannels: r.colorChannels)
            }
        }
        try style.height(height)
        return style
    }
}

// Type checks for the uncommon out-of-order op and heterogeneous inline rows.
// Unlike a Decoder, these select a known enum case; none probes by throwing.
package struct BatchFields {
    package let fields: NodeStyle
    package init(_ fields: NodeStyle) { self.fields = fields }
    package func value(_ key: String) -> BatchValue? {
        guard let value = fields[key], value != .null else { return nil }
        return value
    }
    package static func string(_ value: BatchValue) throws -> String {
        guard case .string(let s) = value else { throw BatchReader.Invalid.wire }; return s
    }
    package static func number(_ value: BatchValue) throws -> Double {
        guard case .number(let n) = value else { throw BatchReader.Invalid.wire }; return n
    }
    package static func bool(_ value: BatchValue) throws -> Bool {
        guard case .bool(let b) = value else { throw BatchReader.Invalid.wire }; return b
    }
    package static func id(_ value: BatchValue) throws -> UInt32 {
        guard let id = UInt32(exactly: try number(value)) else { throw BatchReader.Invalid.wire }; return id
    }
    package static func object(_ value: BatchValue) throws -> NodeStyle {
        guard case .object(let o) = value else { throw BatchReader.Invalid.wire }; return o
    }
    package static func array<T>(_ value: BatchValue, _ element: (BatchValue) throws -> T) throws -> [T] {
        guard case .array(let a) = value else { throw BatchReader.Invalid.wire }; return try a.map(element)
    }
    package func string(_ key: String) throws -> String? { try value(key).map(Self.string) }
    package func number(_ key: String) throws -> Double? { try value(key).map(Self.number) }
    package func id(_ key: String) throws -> UInt32? { try value(key).map(Self.id) }
    package func bool(_ key: String) throws -> Bool? { try value(key).map(Self.bool) }
    package func object(_ key: String) throws -> NodeStyle { try value(key).map(Self.object) ?? [:] }
    package func strings(_ key: String) throws -> [String: String] { try object(key).mapValues(Self.string) }
    package func array<T>(_ key: String, _ element: (BatchValue) throws -> T) throws -> [T] {
        try value(key).map { try Self.array($0, element) } ?? []
    }
    package func inline(colorChannels: ((BatchValue, Bool) -> [Double]?)? = nil) throws -> InlineText {
        guard let id = try id("id"), let parent = try self.id("parent") else { throw BatchReader.Invalid.wire }
        var style = InlineStyle()
        let rows = try object("style")
        for (key, value) in rows where key != "line_height" { try style.set(key, value, colorChannels: colorChannels) }
        try style.height(rows["line_height"])
        return InlineText(id: id, parent: parent, props: try strings("props"), style: style,
                          handlers: Set(try array("handlers", Self.string)), paints: try bool("paint") ?? false,
                          opacity: try number("opacity") ?? 1)
    }
}

extension InlineStyle {
    package mutating func set(_ key: String, _ value: BatchValue, colorChannels: ((BatchValue, Bool) -> [Double]?)? = nil) throws {
        if value == .null { return }
        let channels = colorChannels ?? { $0.fallbackChannels(dark: $1) }
        if key == "text_color" { fixedInk = value.fixesInk }
        switch key {
        case "font_size": run.size = CGFloat(Float(try BatchFields.number(value)))
        case "font_weight", "font_family":
            let n = try BatchFields.number(value)
            guard n >= Double(Int.min), n < Double(Int.max) else { throw BatchReader.Invalid.wire }
            if key == "font_weight" { run.weight = Int(n) } else { run.family = Int(n) }
        case "font_style": run.italic = try BatchFields.string(value) == "italic"
        case "font_stretch": run.stretch = CGFloat(Float(try BatchFields.number(value)))
        case "font_variation_settings": run.variations = FontAxis.settings(value, keeping: run.variations)
        case "font_optical_sizing": run.variations = FontAxis.opticalSizing(try BatchFields.string(value), run.variations)
        case "letter_spacing": run.letterSpacing = CGFloat(Float(try BatchFields.number(value)))
        case "font_variant_numeric": run.numeric = Int(try BatchFields.number(value)) & 0xff
        case "font_variant_ligatures": run.ligatures = Int(try BatchFields.number(value)) & 0xff
        case "font_feature_settings": run.features = FontFeature.of(value)
        case "visibility": run.hidden = try BatchFields.string(value) != "visible"
        case "user_select": selectsAll = try BatchFields.string(value) == "all"
        case "outline_style": outlineNone = try BatchFields.string(value) == "none"
        case "text_decoration_line": run.decoration = try BatchFields.string(value)
        case "text_color" where value.isWideColor, "background_color" where value.isWideColor:
            // @ref LLP 1100 D2
            guard let light = channels(value, false), let dark = channels(value, true) else { throw BatchReader.Invalid.wire }
            paired = value.isSchemeColor
            if key == "text_color" { run.color = light; darkColor = dark } else { run.background = light; darkBackground = dark }
        case "text_color" where value.isSystemColor, "background_color" where value.isSystemColor:
            // @ref LLP 1095 D5 — a platform colour, kept by name and resolved
            // as the run is read, in its paragraph owner's traits (an inline
            // run has no view), so a contrast or level change reaches it.
            guard channels(value, false) != nil, channels(value, true) != nil else { throw BatchReader.Invalid.wire }
            paired = true
            if key == "text_color" { colorRef = value } else { backgroundRef = value }
        case "text_color":
            guard case .array(let a) = value else { throw BatchReader.Invalid.wire }
            if a.count == 2 {
                paired = true
                run.color = try BatchFields.array(a[0], BatchFields.number)
                darkColor = try BatchFields.array(a[1], BatchFields.number)
            } else {
                run.color = try a.map(BatchFields.number); darkColor = run.color
            }
            guard run.color?.count == 4, darkColor?.count == 4 else { throw BatchReader.Invalid.wire }
        case "background_color":
            guard case .array(let a) = value else { throw BatchReader.Invalid.wire }
            if a.count == 2 {
                paired = true
                run.background = try BatchFields.array(a[0], BatchFields.number)
                darkBackground = try BatchFields.array(a[1], BatchFields.number)
            } else {
                run.background = try a.map(BatchFields.number); darkBackground = run.background
            }
            guard run.background?.count == 4, darkBackground?.count == 4 else { throw BatchReader.Invalid.wire }
        case "border_radius_top_left", "border_radius_top_right", "border_radius_bottom_right", "border_radius_bottom_left":
            let corners = ["border_radius_top_left", "border_radius_top_right", "border_radius_bottom_right", "border_radius_bottom_left"]
            if run.backgroundRadii.isEmpty { run.backgroundRadii = Array(repeating: InlineRadius(), count: 4) }
            let i = corners.firstIndex(of: key)!
            run.backgroundRadii[i] = InlineRadius(value)
        default: paint.set(key, value)
        }
    }
    package mutating func height(_ value: BatchValue?) throws {
        guard let value, value != .null else { return }
        switch value {
        case .number(let ratio): run.lineHeight = CGFloat(Float(ratio) * Float(run.size))
        case .string(let s):
            if s.hasSuffix("px"), let px = Float(s.dropLast(2)) { run.lineHeight = CGFloat(px) }
        default: throw BatchReader.Invalid.wire
        }
    }
}
