// (X)RUNWAY — External tracker seam (C# port of src/external-tracker.ts).
//
// Phase-2 contract: a companion (native iOS/ARKit, Quest passthrough CV, or a
// webcam relay) streams PoseFrames; MetricsSystem prefers a fresh frame over
// head-only derivation and transparently falls back when absent/stale. No
// transport here — the relay client lives in the Unity layer
// (NativePoseRelayClient, see README). NO UnityEngine dependency.
//
// Relay protocol (shared by all peers): connect ws://<host>:8082, send
//   {"type":"hello","role":"sender"|"receiver","source":"..."}.
// Senders stream {"type":"pose","frame":PoseFrame}. Keypoint names:
//   nose, leftShoulder, rightShoulder, leftHip, rightHip,
//   leftKnee, rightKnee, leftAnkle, rightAnkle.

using System;
using System.Collections.Generic;

namespace XRunway.Core
{
    /// <summary>
    /// A normalized body keypoint. In the web stack (side camera) x/y are
    /// normalized image coords (origin top-left, y down); with native world-space
    /// tracking they are meters in the runway/world frame. Mirrors PoseKeypoint.
    /// </summary>
    public struct PoseKeypoint
    {
        public float X;
        public float Y;
        public float Z;
        /// <summary>0..1 detector confidence.</summary>
        public float Score;

        public PoseKeypoint(float x, float y, float z, float score)
        {
            X = x;
            Y = y;
            Z = z;
            Score = score;
        }
    }

    /// <summary>
    /// One frame of external body tracking. Keypoint names follow BlazePose/COCO.
    /// Mirrors PoseFrame: { t (ms), source, keypoints }. A class (reference type)
    /// so the tracker can hold the latest frame by reference like the TS does.
    /// </summary>
    public sealed class PoseFrame
    {
        /// <summary>Capture clock (ms). Restamped to the local clock on ingest (see relay client).</summary>
        public double T;

        /// <summary>Source label, e.g. "iphone-arkit", "webcam".</summary>
        public string Source;

        /// <summary>
        /// Coordinate space of the keypoints. "image" (default) = normalized image
        /// coords from a side camera (x/y in 0..1, y down); "world" = meters in the
        /// runway/world frame from native ARKit landmarks. MetricsSystem dispatches
        /// to DeriveFromPoseWorld when this is "world". Mirrors PoseFrame.space.
        /// </summary>
        public string Space = "image";

        /// <summary>Sparse map of keypoint name -> position.</summary>
        public Dictionary<string, PoseKeypoint> Keypoints;

        /// <summary>Original sender stamp, preserved on restamp for latency inspection (TS frame.sentT).</summary>
        public double? SentT;

        public PoseFrame()
        {
            Keypoints = new Dictionary<string, PoseKeypoint>(StringComparer.Ordinal);
        }

        public PoseFrame(double t, string source, Dictionary<string, PoseKeypoint> keypoints)
        {
            T = t;
            Source = source;
            Keypoints = keypoints ?? new Dictionary<string, PoseKeypoint>(StringComparer.Ordinal);
        }
    }

    /// <summary>Canonical keypoint names (the relay protocol's nine).</summary>
    public static class KeypointNames
    {
        public const string Nose = "nose";
        public const string LeftShoulder = "leftShoulder";
        public const string RightShoulder = "rightShoulder";
        public const string LeftHip = "leftHip";
        public const string RightHip = "rightHip";
        public const string LeftKnee = "leftKnee";
        public const string RightKnee = "rightKnee";
        public const string LeftAnkle = "leftAnkle";
        public const string RightAnkle = "rightAnkle";
    }

    /// <summary>What a connected tracker advertises. Mirrors TrackerStatus.</summary>
    public struct TrackerStatus
    {
        public bool Connected;
        public string Source;
        /// <summary>Age of the most recent frame in seconds, or +Infinity if none.</summary>
        public double AgeSec;
        public float Fps;
    }

    /// <summary>
    /// Singleton ingestion point (C# port of ExternalTracker). A companion/relay
    /// client calls <see cref="Push"/> with each frame; consumers (Metrics) call
    /// <see cref="Latest"/>/<see cref="Status"/>.
    ///
    /// Clock injection: <c>nowMs</c> defaults to a process stopwatch. The Unity
    /// layer passes a provider sourced from the SAME clock its relay client uses
    /// to restamp frame.T, so the staleness math is consistent (see README).
    /// </summary>
    public sealed class ExternalTracker
    {
        /// <summary>Frames older than this are treated as "no live data" (STALE_AFTER_SEC).</summary>
        public const double StaleAfterSec = 0.6;

        private PoseFrame _frame;
        private long _frameCount;
        private double _windowStart;
        private int _windowCount;
        private float _fps;
        private readonly Func<double> _nowMs;

        public ExternalTracker(Func<double> nowMs = null)
        {
            _nowMs = nowMs ?? DefaultNow;
            _windowStart = _nowMs();
        }

        /// <summary>Total frames pushed since construction.</summary>
        public long FrameCount => _frameCount;

        /// <summary>Companion entry point: hand in the newest frame.</summary>
        public void Push(PoseFrame frame)
        {
            _frame = frame;
            _frameCount++;
            _windowCount++;
            double now = _nowMs();
            double span = (now - _windowStart) / 1000.0;
            if (span >= 1.0)
            {
                _fps = (float)(_windowCount / span);
                _windowStart = now;
                _windowCount = 0;
            }
        }

        /// <summary>Most recent frame if fresh enough, else null (consumer falls back).</summary>
        public PoseFrame Latest()
        {
            if (_frame == null) return null;
            double ageSec = (_nowMs() - _frame.T) / 1000.0;
            return ageSec <= StaleAfterSec ? _frame : null;
        }

        public TrackerStatus Status()
        {
            double ageSec = _frame != null
                ? (_nowMs() - _frame.T) / 1000.0
                : double.PositiveInfinity;
            return new TrackerStatus
            {
                Connected = ageSec <= StaleAfterSec,
                Source = _frame?.Source,
                AgeSec = ageSec,
                // Round to one decimal, matching the TS Math.round(fps*10)/10
                // (JS half-toward-+Infinity, not .NET banker's rounding).
                Fps = (float)(CoreMath.JsRound(_fps * 10.0) / 10.0),
            };
        }

        private static readonly System.Diagnostics.Stopwatch _stopwatch =
            System.Diagnostics.Stopwatch.StartNew();

        private static double DefaultNow() => _stopwatch.Elapsed.TotalMilliseconds;
    }
}
