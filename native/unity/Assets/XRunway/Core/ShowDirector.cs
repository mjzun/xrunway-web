// (X)RUNWAY — Show direction state machine (C# port of src/show.ts).
//
// ShowDirector owns the show state machine:
//   idle -> brief -> countdown -> walk -> summary -> (idle | next run)
//
// The walk phase belongs to THE TRAINEE and runs in the USER-MAPPED runway frame.
// The director holds one RunwayProjector (kept in sync with the active layout via
// ApplyLayout), and each Update() reads the head world position (via an injected
// IHeadProvider), projects it to the runway-local `along` axis, and updates:
//
//   WalkProgress  — round-trip progress: 0..0.5 walking down the deck
//                   (startAlong -> poseAlong), 0.5..1 walking back after reaching
//                   the pose mark. Monotonically clamped (never published more
//                   than JITTER_BACK below its peak). -1 outside the walk phase.
//   WalkRemaining — seconds left (WALK_SEC - elapsed, >= 0). -1 outside walk.
//
// The walk finishes on round-trip complete OR at WALK_SEC, whichever first.
//
// All phase timing is delta-accumulated in Update() (no timers/coroutines), so
// the show respects engine pause. Energy is an exponential lerp toward a per-
// phase target. NO UnityEngine dependency: the Unity layer injects an
// IHeadProvider (from the XR camera), a live MetricSnapshot via SetLiveMetrics,
// and listens to the change events to drive HUD/stage/music.
//
// Subscriber-throw fidelity note: the TS settles director state BEFORE publishing
// signals and publishes the summary BEFORE flipping the phase, so phase listeners
// can read it. This port preserves that ordering: state mutates first, then the
// change events fire (OnSummaryChanged before OnPhaseChanged in FinishWalk).

using System;
using System.Numerics; // Vector3 — plain math, no UnityEngine. Unity adapts in IHeadProvider.

namespace XRunway.Core
{
    /// <summary>
    /// Supplies the trainee head world position each frame. The Unity layer
    /// implements this from the XR camera (UnityEngine.Camera -> System.Numerics
    /// Vector3). Only X and Z feed the along/lateral projection; Y is read by
    /// Metrics for bob/posture (Metrics has its own provider call).
    /// </summary>
    public interface IHeadProvider
    {
        /// <summary>Trainee head position in world meters.</summary>
        Vector3 HeadWorld { get; }
    }

    /// <summary>
    /// The phase state machine. Pure C#; drive it by calling <see cref="Update"/>
    /// every frame with the frame delta (seconds). Read published state via the
    /// properties; subscribe to the events to react (HUD, stage mood, music).
    /// </summary>
    public sealed class ShowDirector
    {
        // -- Direction constants (mirror show.ts). ------------------------------
        private const float BriefSec = 3.2f;
        private const float CountdownSec = 3f;
        /// <summary>Trainee walk length — the TIME box counts down from this (LESSON.walkSeconds = 60).</summary>
        public const float WalkSec = 60f;
        /// <summary>Exponential energy-lerp rate (higher = snappier).</summary>
        private const float EnergyRate = 2.2f;

        /// <summary>"Reached the pose mark" radius along the walk axis (m).</summary>
        private const float MarkRadius = 0.4f;
        /// <summary>"Back at the start line" radius along the walk axis (m).</summary>
        private const float FinishRadius = 0.4f;
        /// <summary>Max backwards jitter tolerated on WalkProgress (monotonic clamp).</summary>
        private const float JitterBack = 0.05f;

        /// <summary>Neutral fallback if a run somehow ends before any metric tick.</summary>
        private const float FallbackScore = 62f;

        private static float EnergyTarget(ShowPhase phase) => phase switch
        {
            ShowPhase.Idle => 0.12f,
            ShowPhase.Brief => 0.35f,
            ShowPhase.Countdown => 0.6f,
            ShowPhase.Walk => 1f,
            ShowPhase.Summary => 0.45f,
            _ => 0.12f,
        };

        // Weighted overall — must sum to 1 (mirrors OVERALL_WEIGHTS order/weights).
        private static float WeightedOverall(in MetricSnapshot s) =>
            s.Posture * 0.2f +
            s.Pace * 0.15f +
            s.Rhythm * 0.15f +
            s.FootPlacement * 0.2f +
            s.Presence * 0.1f +
            s.Confidence * 0.1f +
            s.Presentation * 0.1f;

        // -- Published state (was signals). -------------------------------------
        public ShowPhase Phase { get; private set; } = ShowPhase.Idle;
        public float Energy { get; private set; } = 0.12f; // seed at idle target
        /// <summary>-1 outside the walk phase; else 0..1 round-trip progress.</summary>
        public float WalkProgress { get; private set; } = -1f;
        /// <summary>-1 outside the walk phase; else seconds remaining (>= 0).</summary>
        public float WalkRemaining { get; private set; } = -1f;
        /// <summary>Last published summary (set on FinishWalk).</summary>
        public ShowSummary? Summary { get; private set; }

        // -- Change events (was signal subscriptions). --------------------------
        public event Action<ShowPhase> OnPhaseChanged;
        public event Action<float> OnEnergyChanged;
        public event Action<float> OnWalkProgressChanged;
        public event Action<float> OnWalkRemainingChanged;
        public event Action<ShowSummary?> OnSummaryChanged;

        // -- Internal timing / walk trackers. -----------------------------------
        private float _phaseElapsed;
        private bool _reachedMark;
        private float _peakProgress;
        private int? _lastOverall; // previous run's overall, for DeltaVsLast

        // -- Runway projection + cached marks. ----------------------------------
        private readonly RunwayProjector _projector;
        private readonly IHeadProvider _head;
        private float _startA = RunwayLayoutModel.StartAlong();
        private float _poseA;

        // Live metrics, fed by the Unity layer (mirrors globals.metrics peek in
        // FinishWalk). null until Metrics publishes a tick.
        private MetricSnapshot? _liveMetrics;

        /// <param name="head">Head world-position provider (XR camera in Unity).</param>
        /// <param name="layout">Initial runway layout (defaults to DEFAULT_LAYOUT).</param>
        public ShowDirector(IHeadProvider head, RunwayLayout? layout = null)
        {
            _head = head ?? throw new ArgumentNullException(nameof(head));
            _projector = new RunwayProjector();
            ApplyLayout(layout ?? RunwayLayoutModel.DefaultLayout);
        }

        // -- Public controls (mirror ShowControls). -----------------------------

        /// <summary>Trainee walk: brief -> countdown -> walk. Clears prior summary/metrics.</summary>
        public void BeginWalk()
        {
            Summary = null;
            OnSummaryChanged?.Invoke(null);
            _liveMetrics = null;
            SetPhase(ShowPhase.Brief);
        }

        /// <summary>Back to idle; energy settles to house level.</summary>
        public void Reset()
        {
            _liveMetrics = null;
            SetPhase(ShowPhase.Idle);
        }

        /// <summary>
        /// Feed the latest live metric tick (the Unity Metrics system calls this
        /// each publish). FinishWalk freezes whatever was last fed in.
        /// </summary>
        public void SetLiveMetrics(in MetricSnapshot snapshot) => _liveMetrics = snapshot;

        /// <summary>Clear live metrics (e.g. on walk-phase entry, matching the TS null-out).</summary>
        public void ClearLiveMetrics() => _liveMetrics = null;

        /// <summary>Re-fit the projector + cached along marks to a (new) runway layout.</summary>
        public void ApplyLayout(in RunwayLayout layout)
        {
            _projector.Set(layout);
            _startA = RunwayLayoutModel.StartAlong();
            _poseA = RunwayLayoutModel.PoseAlong(layout);
        }

        // -- Frame tick. --------------------------------------------------------

        /// <param name="delta">Frame time in seconds.</param>
        public void Update(float delta)
        {
            ShowPhase phase = Phase;

            // Energy: exponential ease toward the per-phase target. Zero alloc.
            float target = EnergyTarget(phase);
            float energy = Energy;
            float blend = 1f - (float)Math.Exp(-EnergyRate * delta);
            float next = energy + (target - energy) * blend;
            if (Math.Abs(next - energy) > 1e-5f)
            {
                float clamped = next < 0f ? 0f : (next > 1f ? 1f : next);
                Energy = clamped;
                OnEnergyChanged?.Invoke(clamped);
            }

            // Phase timing — delta-accumulated, pause-safe.
            _phaseElapsed += delta;
            switch (phase)
            {
                case ShowPhase.Brief:
                    if (_phaseElapsed >= BriefSec) SetPhase(ShowPhase.Countdown);
                    break;
                case ShowPhase.Countdown:
                    if (_phaseElapsed >= CountdownSec) SetPhase(ShowPhase.Walk);
                    break;
                case ShowPhase.Walk:
                    UpdateWalk();
                    break;
                // idle / summary: hold until controls move us.
            }
        }

        // -- The trainee's walk. ------------------------------------------------

        private void UpdateWalk()
        {
            Vector3 headPos = _head.HeadWorld;
            // Project head into the user-mapped runway frame. `along` grows from
            // ~startA at the near (start) end to ~poseA at the pose mark.
            float along = _projector.Along(headPos.X, headPos.Z);
            float startA = _startA;
            float poseA = _poseA;
            float span = poseA - startA;

            // One-way latch: the trainee has reached the pose mark.
            if (!_reachedMark && along >= poseA - MarkRadius)
            {
                _reachedMark = true;
            }

            // Raw round-trip progress from along.
            //   Leg 1 (down): startA -> poseA mapped 0..0.5.
            //   Leg 2 (back): poseA -> startA mapped 0.5..1.
            float raw;
            if (!_reachedMark)
            {
                float down = span > 0f ? (along - startA) / span : 0f;
                raw = 0.5f * (down < 0f ? 0f : (down > 1f ? 1f : down));
            }
            else
            {
                float back = span > 0f ? (poseA - along) / span : 0f;
                raw = 0.5f + 0.5f * (back < 0f ? 0f : (back > 1f ? 1f : back));
            }

            // Monotonic clamp: tracking jitter may dip at most JitterBack below
            // the peak — the published walk never visibly runs backwards.
            if (raw > _peakProgress) _peakProgress = raw;
            float floor = _peakProgress - JitterBack;
            float progress = raw < floor ? floor : raw;

            float remaining = WalkSec - _phaseElapsed;

            // Settle finish conditions BEFORE publishing.
            bool roundTrip = _reachedMark && along <= startA + FinishRadius;
            bool timedOut = _phaseElapsed >= WalkSec;

            WalkProgress = progress;
            OnWalkProgressChanged?.Invoke(progress);
            float pubRemaining = remaining > 0f ? remaining : 0f;
            WalkRemaining = pubRemaining;
            OnWalkRemainingChanged?.Invoke(pubRemaining);

            if (roundTrip || timedOut) FinishWalk();
        }

        // -- Internals. ---------------------------------------------------------

        private void SetPhase(ShowPhase phase)
        {
            // Internal state first, walk trackers second, phase LAST — so phase
            // listeners synchronously read initialized trackers.
            _phaseElapsed = 0f;
            if (phase == ShowPhase.Walk)
            {
                _reachedMark = false;
                _peakProgress = 0f;
                WalkProgress = 0f;
                OnWalkProgressChanged?.Invoke(0f);
                WalkRemaining = WalkSec;
                OnWalkRemainingChanged?.Invoke(WalkSec);
            }
            else
            {
                WalkProgress = -1f;
                OnWalkProgressChanged?.Invoke(-1f);
                WalkRemaining = -1f;
                OnWalkRemainingChanged?.Invoke(-1f);
            }

            Phase = phase;
            OnPhaseChanged?.Invoke(phase);
        }

        /// <summary>Freeze live metrics into a ShowSummary, then enter the summary phase.</summary>
        private void FinishWalk()
        {
            // JS-faithful rounding (Math.round = half toward +Infinity), matching show.ts.
            float durationSec = (float)(CoreMath.JsRound(_phaseElapsed * 10.0) / 10.0);
            MetricSnapshot? live = _liveMetrics;

            MetricSnapshot scores = live ?? MetricSnapshot.Uniform(FallbackScore);

            float weighted = WeightedOverall(scores);
            int overall = (int)Math.Max(0, Math.Min(100, CoreMath.JsRound(weighted)));

            int? deltaVsLast = _lastOverall == null ? (int?)null : overall - _lastOverall.Value;
            _lastOverall = overall;

            // Publish summary BEFORE the phase flips, so phase listeners read it.
            var summary = new ShowSummary
            {
                Scores = scores,
                Overall = overall,
                DeltaVsLast = deltaVsLast,
                DurationSec = durationSec,
            };
            Summary = summary;
            OnSummaryChanged?.Invoke(summary);
            SetPhase(ShowPhase.Summary);
        }
    }
}
