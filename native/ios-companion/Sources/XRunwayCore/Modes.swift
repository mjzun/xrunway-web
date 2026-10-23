//
//  Modes.swift — XRunwayCore
//
//  Port of src/modes.ts (the four training modes), locked by the golden
//  `modes` family (id / idealPace / passThreshold / weights / walkSeconds
//  verified per mode). Copy fields (label/tagline/greeting/instruction) ride
//  along for the A3 Solo UI; persistence (loadMode/saveMode) is deliberately
//  NOT ported here — UserDefaults is an app-layer concern (SOLO-MODE §5).
//

import Foundation

/// The seven metric keys in canonical M1..M7 order (metrics.ts METRICS).
/// This order is the targets[] slot order, the overall-rollup summation
/// order (float-sum order matters at 1e-9), and the coach's tiebreak.
public let METRIC_ORDER: [String] = [
    "posture",
    "pace",
    "rhythm",
    "footPlacement",
    "presence",
    "confidence",
    "presentation",
]

public struct TrainingMode {
    public let id: String
    /// Lesson number shown in the HUD ("01".."04").
    public let number: String
    /// Title, e.g. "BEGINNER WALK".
    public let label: String
    /// One-line description for the mode picker.
    public let tagline: String
    public let greeting: String
    public let instruction: String
    /// Walk length in seconds (the TIME box counts down from this).
    public let walkSeconds: Double
    /// Ideal catwalk head speed (m/s) the pace metric scores against.
    public let idealPace: Double
    /// Checkbox / pass threshold for this mode.
    public let passThreshold: Double
    /// Overall-score weighting — MUST sum to 1. Keyed by METRIC_ORDER names.
    public let weights: [String: Double]
    /// Visual/energy mood bias 0..1 (drama). Beginner calm, Challenge intense.
    public let intensity: Double

    public init(
        id: String, number: String, label: String, tagline: String,
        greeting: String, instruction: String, walkSeconds: Double,
        idealPace: Double, passThreshold: Double, weights: [String: Double],
        intensity: Double
    ) {
        self.id = id
        self.number = number
        self.label = label
        self.tagline = tagline
        self.greeting = greeting
        self.instruction = instruction
        self.walkSeconds = walkSeconds
        self.idealPace = idealPace
        self.passThreshold = passThreshold
        self.weights = weights
        self.intensity = intensity
    }
}

public let MODES: [TrainingMode] = [
    TrainingMode(
        id: "beginner",
        number: "01",
        label: "BEGINNER WALK",
        tagline: "Learn the fundamentals — posture, pace, and a clean line.",
        greeting: "Ready, {name}?",
        instruction:
            "Shoulders back, chin level. Land each step on the line - one foot in front of the other. Walk to the mark, hold your pose, then bring it home.",
        walkSeconds: 20,
        idealPace: 0.85,
        passThreshold: 78,
        weights: [
            "posture": 0.2,
            "pace": 0.15,
            "rhythm": 0.15,
            "footPlacement": 0.2,
            "presence": 0.1,
            "confidence": 0.1,
            "presentation": 0.1,
        ],
        intensity: 0.35
    ),
    TrainingMode(
        // Mirrors src/modes.ts — id stays "highfashion", shown label is EMERGING.
        id: "highfashion",
        number: "02",
        label: "EMERGING RUNWAY",
        tagline: "Slow, commanding, editorial. Own the room before your first step.",
        greeting: "Own it, {name}.",
        instruction:
            "Slow it down. Long, deliberate strides, chin high, eyes forward. Sell the silhouette - presence over speed. Hit the mark, hold, and let them look.",
        walkSeconds: 20,
        idealPace: 0.72,
        passThreshold: 80,
        weights: [
            "posture": 0.2,
            "presence": 0.2,
            "presentation": 0.2,
            "rhythm": 0.15,
            "pace": 0.1,
            "footPlacement": 0.1,
            "confidence": 0.05,
        ],
        intensity: 0.85
    ),
    TrainingMode(
        id: "commercial",
        number: "03",
        label: "COMMERCIAL MODELING",
        tagline: "Natural, approachable, relatable. The everyday confident walk.",
        greeting: "Keep it natural, {name}.",
        instruction:
            "Relax into it. An easy, natural pace, soft shoulders, a friendly energy. Approachable beats dramatic here - sell trust, not intimidation.",
        walkSeconds: 20,
        idealPace: 0.95,
        passThreshold: 75,
        weights: [
            "confidence": 0.2,
            "presentation": 0.2,
            "pace": 0.15,
            "posture": 0.15,
            "presence": 0.1,
            "footPlacement": 0.1,
            "rhythm": 0.1,
        ],
        intensity: 0.55
    ),
    TrainingMode(
        id: "challenge",
        number: "04",
        label: "PERFORMANCE CHALLENGE",
        tagline: "Fast, precise, demanding. Prove every step under pressure.",
        greeting: "Bring it, {name}.",
        instruction:
            "Pick up the pace and hold the line. Crisp footwork, locked rhythm, no wobble. The bar is high - every step is scored. Go.",
        walkSeconds: 20,
        idealPace: 1.05,
        passThreshold: 82,
        weights: [
            "pace": 0.2,
            "rhythm": 0.2,
            "footPlacement": 0.2,
            "posture": 0.15,
            "presentation": 0.1,
            "confidence": 0.1,
            "presence": 0.05,
        ],
        intensity: 1.0
    ),
]

public let DEFAULT_MODE = MODES[0]

public func getMode(_ id: String) -> TrainingMode {
    return MODES.first { $0.id == id } ?? DEFAULT_MODE
}
