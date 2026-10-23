//
//  JSONValue.swift — XRunwayCoreTests
//
//  The golden-vector envelope decoder + the §6.5 comparison rule, mirrored
//  byte-for-byte from test/golden-format.ts (decodeNums + goldenDiff). A
//  JSONValue enum models the polymorphic golden JSON, with the
//  {"$num":"nan"|"+inf"|"-inf"} sentinel decoded to Double.nan / ±infinity.
//
//  Comparison rule (test/golden-format.ts §6.5): EXACT for strings / bools /
//  nulls / mixed types; numbers within FLOAT_ABS_TOL (1e-9) + FLOAT_REL_TOL
//  (1e-6) * max(|a|,|b|), with NaN == NaN true and non-finite exact. This is
//  the SHIPPED rule — it is not loosened here.
//

import Foundation

/// A decoded golden JSON value. Numbers carry their exact Double (non-finite
/// included via the sentinel); the enum mirrors JS's null/bool/number/string/
/// array/object shape so a heterogeneous `results` array round-trips.
enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue {
    /// Mirror of golden-format.ts FLOAT_ABS_TOL / FLOAT_REL_TOL.
    static let floatAbsTol = 1e-9
    static let floatRelTol = 1e-6

    /// numbersClose (golden-format.ts): NaN==NaN, non-finite exact, else
    /// |a-b| <= ABS + REL*max(|a|,|b|).
    static func numbersClose(_ a: Double, _ b: Double) -> Bool {
        if a.isNaN && b.isNaN { return true }
        if !a.isFinite || !b.isFinite { return a == b }
        let scale = max(abs(a), abs(b))
        return abs(a - b) <= floatAbsTol + floatRelTol * scale
    }

    /// goldenDiff (golden-format.ts): nil on match, else "path: detail" naming
    /// the FIRST mismatch (mirrors the generator's --check output style).
    static func diff(_ a: JSONValue, _ b: JSONValue, path: String = "$") -> String? {
        switch (a, b) {
        case let (.number(x), .number(y)):
            return numbersClose(x, y) ? nil : "\(path): \(x) vs \(y)"
        case let (.array(xs), .array(ys)):
            if xs.count != ys.count {
                return "\(path): length \(xs.count) vs \(ys.count)"
            }
            for i in 0..<xs.count {
                if let d = diff(xs[i], ys[i], path: "\(path)[\(i)]") { return d }
            }
            return nil
        case (.array, _), (_, .array):
            return "\(path): array vs non-array"
        case let (.object(xo), .object(yo)):
            let ka = xo.keys.sorted()
            let kb = yo.keys.sorted()
            if ka != kb {
                return "\(path): keys [\(ka.joined(separator: ","))] vs [\(kb.joined(separator: ","))]"
            }
            for k in ka {
                if let d = diff(xo[k]!, yo[k]!, path: "\(path).\(k)") { return d }
            }
            return nil
        case (.null, .null):
            return nil
        case let (.bool(x), .bool(y)):
            return x == y ? nil : "\(path): \(x) vs \(y)"
        case let (.string(x), .string(y)):
            return x == y ? nil : "\(path): \(x) vs \(y)"
        default:
            // Mixed types never match.
            return "\(path): \(a.describe) vs \(b.describe)"
        }
    }

    var describe: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return "\(b)"
        case .number(let n): return "\(n)"
        case .string(let s): return s
        case .array: return "array"
        case .object: return "object"
        }
    }
}

// ---------------------------------------------------------------------------
// Decoding — JSONSerialization -> JSONValue, decoding the $num sentinel.
// ---------------------------------------------------------------------------

extension JSONValue {
    /// Decode from a Foundation JSON object (JSONSerialization output). The
    /// {"$num": "nan"|"+inf"|"-inf"} sentinel object maps to the matching
    /// non-finite Double (inverse of pose-tapes.ts sanitize / golden-format.ts
    /// decodeNums).
    static func from(_ any: Any) -> JSONValue {
        if any is NSNull { return .null }
        // NSNumber straddles bool and number; distinguish by objCType.
        if let num = any as? NSNumber {
            if isBool(num) { return .bool(num.boolValue) }
            return .number(num.doubleValue)
        }
        if let s = any as? String { return .string(s) }
        if let arr = any as? [Any] { return .array(arr.map { from($0) }) }
        if let dict = any as? [String: Any] {
            // $num sentinel: exactly one key, "$num", a known token.
            if dict.count == 1, let token = dict["$num"] as? String {
                switch token {
                case "nan": return .number(Double.nan)
                case "+inf": return .number(Double.infinity)
                case "-inf": return .number(-Double.infinity)
                default: break
                }
            }
            var out: [String: JSONValue] = [:]
            for (k, v) in dict { out[k] = from(v) }
            return .object(out)
        }
        // Unreachable for well-formed JSON.
        return .null
    }

    /// NSNumber boolean discrimination (JSONSerialization tags true/false as
    /// __NSCFBoolean with objCType "c").
    private static func isBool(_ n: NSNumber) -> Bool {
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
}

// ---------------------------------------------------------------------------
// Convenience accessors for reading vector inputs (not the comparison path).
// ---------------------------------------------------------------------------

extension JSONValue {
    var isNull: Bool { if case .null = self { return true }; return false }

    var asDouble: Double? {
        if case .number(let n) = self { return n }
        return nil
    }
    var asString: String? {
        if case .string(let s) = self { return s }
        return nil
    }
    var asBool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
    var asArray: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }
    var asObject: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }
    subscript(_ key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
}
