// (X)RUNWAY — shared show/metric value types.
//
// Engine-agnostic mirror of the TS contracts in src/show.ts. NO UnityEngine
// dependency here so Core is plain-C# unit-testable; the Unity layer plugs in
// via the interfaces in ShowDirector.cs / Metrics.cs.

using System;

namespace XRunway.Core
{
    /// <summary>
    /// Internal numeric helpers shared across Core, kept here so every file can
    /// reach them without cross-type coupling.
    /// </summary>
    internal static class CoreMath
    {
        /// <summary>
        /// JS-faithful round: half rounds toward +Infinity (JavaScript Math.round),
        /// NOT .NET's banker's rounding. Used everywhere the TS calls Math.round so
        /// the published metric/overall/fps values match the web prototype exactly.
        /// </summary>
        public static double JsRound(double x) => Math.Floor(x + 0.5);
    }

    /// <summary>
    /// Show state machine phases: idle -> brief -> countdown -> walk -> summary.
    /// Mirrors ShowPhaseValue ("idle" | "brief" | "countdown" | "walk" | "summary").
    /// </summary>
    public enum ShowPhase
    {
        Idle,
        Brief,
        Countdown,
        Walk,
        Summary,
    }

    /// <summary>
    /// Seven coach metrics, each 0..100. Field names match the TS MetricSnapshot
    /// exactly (pace, posture, rhythm, presence, footPlacement, confidence,
    /// presentation). A struct so a published snapshot is a value copy, matching
    /// the TS object-copy semantics.
    /// </summary>
    [Serializable]
    public struct MetricSnapshot : IEquatable<MetricSnapshot>
    {
        public float Pace;
        public float Posture;
        public float Rhythm;
        public float Presence;
        public float FootPlacement;
        public float Confidence;
        public float Presentation;

        /// <summary>A snapshot with every metric set to <paramref name="v"/>.</summary>
        public static MetricSnapshot Uniform(float v) => new MetricSnapshot
        {
            Pace = v,
            Posture = v,
            Rhythm = v,
            Presence = v,
            FootPlacement = v,
            Confidence = v,
            Presentation = v,
        };

        public bool Equals(MetricSnapshot o) =>
            Pace == o.Pace && Posture == o.Posture && Rhythm == o.Rhythm &&
            Presence == o.Presence && FootPlacement == o.FootPlacement &&
            Confidence == o.Confidence && Presentation == o.Presentation;

        public override bool Equals(object obj) => obj is MetricSnapshot o && Equals(o);

        public override int GetHashCode() => HashCode.Combine(
            Pace, Posture, Rhythm, Presence, FootPlacement, Confidence, Presentation);
    }

    /// <summary>
    /// Frozen run result published when the walk finishes. Mirrors ShowSummary:
    /// per-metric scores, the weighted overall (0..100), the delta vs the previous
    /// run this session (null on the first run), and the run duration in seconds.
    /// </summary>
    [Serializable]
    public struct ShowSummary
    {
        public MetricSnapshot Scores;
        /// <summary>Weighted overall, 0..100.</summary>
        public int Overall;
        /// <summary>Overall delta vs the previous run this session, or null first time.</summary>
        public int? DeltaVsLast;
        /// <summary>Run duration, seconds (rounded to one decimal, like the TS).</summary>
        public float DurationSec;
    }
}
