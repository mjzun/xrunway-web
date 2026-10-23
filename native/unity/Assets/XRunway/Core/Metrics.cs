// (X)RUNWAY — AI-coach metrics (C# port of src/metrics.ts).
//
// MetricsSystem publishes a MetricSnapshot (~6 Hz) while the show phase is
// "walk". Every score derives from the trainee's REAL head motion (head world
// position via IHeadProvider), projected into the USER-MAPPED runway frame (one
// RunwayProjector kept in sync with the active layout):
//
//   pace          <- horizontal head velocity vs ideal catwalk speed
//   rhythm        <- vertical-bob zero-crossing regularity (ring buffer)
//   posture       <- head-height stability vs walk start
//   footPlacement <- |lateral| deviation from the runway centerline
//   presence / confidence / presentation — composites of those four
//
// When a fresh external PoseFrame is present, pace/posture/rhythm/footwork
// instead derive from the streamed skeleton (DeriveFromPose); absent/stale, head
// derivation is used (DeriveFromHead). Head still owns walkProgress + the floor
// (ShowDirector), so the external camera only sharpens the *quality* scores.
//
// Footstrikes: each detected bob up-crossing IS a footstrike. On every strike the
// system updates LastStep (one reused struct exposed via a callback) carrying the
// shader-clock timestamp and the head's along-axis position as a deck-local 0..1
// FRACTION (RunwayProjector.AlongFraction, NOT world z).
//
// Zero per-frame allocation in the hot path: ring buffers and working state are
// fields; the only allocation is the snapshot copy published at the 6 Hz tick.
// NO UnityEngine dependency — Unity injects IHeadProvider (head incl. Y),
// the ExternalTracker, and a clock; it listens to OnMetrics / OnFootStrike.

using System;
using System.Numerics; // Vector3 — head incl. Y for bob/posture.

namespace XRunway.Core
{
    /// <summary>
    /// One footstrike for the live-floor ripple. <see cref="Time"/> is the shader
    /// clock (so ripple age = uTime - Time is consistent); <see cref="Z"/> is the
    /// deck-local ALONG FRACTION (0..1), fed straight to the floor shader's uStepZ.
    /// Mirrors globals.lastStep { time, z }.
    /// </summary>
    public struct FootStrike
    {
        public double Time;
        public float Z;
    }

    /// <summary>
    /// Static metric metadata — single source for HUD row order/labels. Mirrors
    /// the METRICS table in metrics.ts (M1..M7).
    /// </summary>
    public static class MetricsTable
    {
        public readonly struct Entry
        {
            public readonly string Key;   // matches MetricSnapshot field name (camelCase, as TS)
            public readonly string Label;
            public readonly string Short;
            public Entry(string key, string label, string @short)
            {
                Key = key;
                Label = label;
                Short = @short;
            }
        }

        /// <summary>Row order: posture, pace, rhythm, footPlacement, presence, confidence, presentation.</summary>
        public static readonly Entry[] Metrics =
        {
            new Entry("posture", "POSTURE", "M1"),
            new Entry("pace", "PACE", "M2"),
            new Entry("rhythm", "RHYTHM", "M3"),
            new Entry("footPlacement", "FOOTWORK", "M4"),
            new Entry("presence", "PRESENCE", "M5"),
            new Entry("confidence", "CONFIDENCE", "M6"),
            new Entry("presentation", "PRESENTATION", "M7"),
        };

        /// <summary>Checkbox threshold — a metric's box fills when its live value >= this.</summary>
        public const int MetricPass = 78;
    }

    /// <summary>
    /// The coach-metrics derivation system. Drive it by calling
    /// <see cref="BeginWalk"/> when the show enters the walk phase, <see cref="Stop"/>
    /// when it leaves, and <see cref="Update"/> every frame with (delta, time)
    /// where <c>time</c> is the same shader/ECS clock used for ripple age.
    /// </summary>
    public sealed class MetricsSystem
    {
        // -- Tuning (mirror metrics.ts). ----------------------------------------
        private const float PublishInterval = 1f / 6f; // ~6 Hz
        private const float ScoreMin = 40f;
        private const float ScoreMax = 98f;
        private const float Neutral = 62f;

        /// <summary>Ideal catwalk head speed (m/s).</summary>
        private const float IdealPace = 0.85f;
        /// <summary>Vertical-bob zero-crossing hysteresis (m).</summary>
        private const float BobThreshold = 0.004f;
        /// <summary>Plausible step-interval window (s).</summary>
        private const float StepMin = 0.15f;
        private const float StepMax = 1.2f;
        private const int RingSize = 8;

        private static float ClampScore(float v) =>
            v < ScoreMin ? ScoreMin : (v > ScoreMax ? ScoreMax : v);

        // The seven target/smooth slots are ordered exactly like MetricsTable:
        //   0 posture, 1 pace, 2 rhythm, 3 footPlacement, 4 presence,
        //   5 confidence, 6 presentation.
        private const int N = 7;

        // -- Collaborators. -----------------------------------------------------
        private readonly IHeadProvider _head;
        private readonly RunwayProjector _projector;
        private readonly ExternalTracker _tracker; // may be null (head-only)

        // -- Published state + events. ------------------------------------------
        /// <summary>True when the last tick derived from the external pose stream (globals.trackerActive).</summary>
        public bool TrackerActive { get; private set; }

        /// <summary>Fires at ~6 Hz with a fresh rounded snapshot.</summary>
        public event Action<MetricSnapshot> OnMetrics;
        /// <summary>Fires on each footstrike (head derivation) with the reused FootStrike.</summary>
        public event Action<FootStrike> OnFootStrike;
        /// <summary>Fires when the floor's strike should be cleared (walk (re)start).</summary>
        public event Action OnFootStrikeCleared;

        // -- Lifecycle. ---------------------------------------------------------
        private bool _active;
        private float _walkTime;
        private float _publishAcc;

        // One mutable working snapshot (the smoothed display values live in _smooth).
        private MetricSnapshot _snapshot;
        private readonly float[] _smooth = new float[N];
        private readonly float[] _target = new float[N];

        // Reused footstrike ref (never re-allocated).
        private FootStrike _lastStep;

        // -- Head-derivation state. ---------------------------------------------
        private Vector3 _headPrev;
        private bool _havePrev;
        private float _baselineY;
        private float _baselineAcc;
        private int _baselineSamples;
        private float _bobBaseline;
        private int _bobSign;
        private float _lastCrossTime = -1f;
        private readonly float[] _intervals = new float[RingSize];
        private int _intervalIdx;
        private int _intervalCount;
        private float _speedEma;
        private float _latEma;
        private float _heightDevEma;

        // -- External pose-derivation state. ------------------------------------
        private float _posePrevHipX;
        private float _posePrevHipZ; // world-space only
        private bool _poseHavePrev;
        private float _poseSpeedEma;
        private float _poseLatEma;
        private float _poseUprightEma = 0.92f;
        private float _poseBobBaseline;
        private bool _poseBobHavePrev;
        private int _poseBobSign;
        private float _poseLastCross = -1f;
        // World-space travel heading (seeded from the runway forward vector).
        private float _poseHeadingX;
        private float _poseHeadingZ = -1f;
        /// <summary>Yaw of the active layout — seeds the world-pose heading on walk start.</summary>
        private float _layoutYaw;
        /// <summary>True when the previous tick used the external stream (for clean cadence handoff).</summary>
        private bool _lastUsedExternal;

        /// <param name="head">Head world-position provider (XR camera; Y used for bob/posture).</param>
        /// <param name="tracker">External pose tracker, or null for head-only.</param>
        /// <param name="layout">Initial runway layout (defaults to DEFAULT_LAYOUT).</param>
        public MetricsSystem(IHeadProvider head, ExternalTracker tracker = null, RunwayLayout? layout = null)
        {
            _head = head ?? throw new ArgumentNullException(nameof(head));
            _tracker = tracker;
            _projector = new RunwayProjector();
            if (layout.HasValue)
            {
                _projector.Set(layout.Value);
                _layoutYaw = layout.Value.Yaw;
            }
            _snapshot = MetricSnapshot.Uniform(Neutral);
        }

        /// <summary>Re-fit the projector to a (new) runway layout (lateral + ripple fraction).</summary>
        public void ApplyLayout(in RunwayLayout layout)
        {
            _projector.Set(layout);
            _layoutYaw = layout.Yaw;
        }

        // -- Walk lifecycle (was the phase-signal subscription). ----------------

        /// <summary>Start tracking — call when the show enters the walk phase.</summary>
        public void BeginWalk()
        {
            _active = true;
            _walkTime = 0f;
            _publishAcc = 0f;
            Fill(_smooth, Neutral);
            Fill(_target, Neutral);

            _havePrev = false;
            _baselineY = 0f;
            _baselineAcc = 0f;
            _baselineSamples = 0;
            _bobBaseline = 0f;
            _bobSign = 0;
            _lastCrossTime = -1f;
            _intervalIdx = 0;
            _intervalCount = 0;
            _speedEma = 0f;
            _latEma = 0f;
            _heightDevEma = 0f;

            _poseHavePrev = false;
            _posePrevHipX = 0f;
            _posePrevHipZ = 0f;
            _poseSpeedEma = 0f;
            _poseLatEma = 0f;
            _poseUprightEma = 0.92f;
            // Seed the world-pose travel heading from the mapped runway's forward
            // vector (f(yaw) = (-sin, -cos)) so footPlacement is right from the
            // first frame on a rotated runway, before the heading EMA converges.
            _poseHeadingX = -(float)Math.Sin(_layoutYaw);
            _poseHeadingZ = -(float)Math.Cos(_layoutYaw);
            _poseBobHavePrev = false;
            _poseBobBaseline = 0f;
            _poseBobSign = 0;
            _poseLastCross = -1f;
            _lastUsedExternal = false;

            // Clear the previous run's strike so the floor doesn't ripple stale.
            OnFootStrikeCleared?.Invoke();
        }

        /// <summary>Stop tracking — call when the show leaves the walk phase.</summary>
        public void Stop() => _active = false;

        /// <summary>
        /// Restart cadence detection cleanly on a camera&lt;-&gt;head source switch: the
        /// two paths push step intervals with different crossing semantics, so
        /// mixing them in one ring buffer corrupts rhythm CV until it rolls over.
        /// </summary>
        private void ResetCadence()
        {
            _intervalIdx = 0;
            _intervalCount = 0;
            _bobSign = 0;
            _lastCrossTime = -1f;
            _poseBobSign = 0;
            _poseLastCross = -1f;
            _poseBobHavePrev = false;
        }

        // -- Frame tick. --------------------------------------------------------

        /// <param name="delta">Frame time in seconds.</param>
        /// <param name="time">Shader/ECS clock (seconds) — used for footstrike ripple age.</param>
        public void Update(float delta, double time)
        {
            if (!_active || delta <= 0f) return;
            _walkTime += delta;

            // Prefer a fresh external pose stream for the quality scores; else
            // derive from the headset alone. On a source switch the two paths
            // measure cadence differently and against different baselines, so
            // restart the cadence ring + bob trackers cleanly to avoid a phantom
            // footstrike / mixed-rhythm spike during the camera<->head handoff.
            PoseFrame frame = _tracker?.Latest();
            if (frame != null)
            {
                if (!_lastUsedExternal) ResetCadence(); // head -> camera
                if (frame.Space == "world")
                {
                    DeriveFromPoseWorld(frame, delta);
                }
                else
                {
                    DeriveFromPose(frame, delta);
                }
                // Force the head path to re-seed (not cross against a stale
                // baseline) if it resumes after the stream drops.
                _havePrev = false;
                TrackerActive = true;
                _lastUsedExternal = true;
            }
            else
            {
                if (_lastUsedExternal) ResetCadence(); // camera -> head
                DeriveFromHead(delta, time);
                TrackerActive = false;
                _lastUsedExternal = false;
            }

            // Smooth raw targets into display values, ramping in from NEUTRAL over
            // the first 2 s so bars never jump on incomplete data.
            float rampIn = _walkTime < 2f ? _walkTime * 0.5f : 1f;
            float blend = 1f - (float)Math.Exp(-3f * delta);
            for (int i = 0; i < N; i++)
            {
                float goal = Neutral + (ClampScore(_target[i]) - Neutral) * rampIn;
                _smooth[i] += (goal - _smooth[i]) * blend;
            }
            WriteSnapshotFromSmooth();

            // Publish a fresh rounded copy at ~6 Hz.
            _publishAcc += delta;
            if (_publishAcc >= PublishInterval)
            {
                _publishAcc %= PublishInterval;
                OnMetrics?.Invoke(new MetricSnapshot
                {
                    Pace = (float)CoreMath.JsRound(_snapshot.Pace),
                    Posture = (float)CoreMath.JsRound(_snapshot.Posture),
                    Rhythm = (float)CoreMath.JsRound(_snapshot.Rhythm),
                    Presence = (float)CoreMath.JsRound(_snapshot.Presence),
                    FootPlacement = (float)CoreMath.JsRound(_snapshot.FootPlacement),
                    Confidence = (float)CoreMath.JsRound(_snapshot.Confidence),
                    Presentation = (float)CoreMath.JsRound(_snapshot.Presentation),
                });
            }
        }

        // -- External camera: pose-stream derivation. ---------------------------

        /// <summary>
        /// Derive the quality scores from a streamed skeleton (normalized image
        /// coords, origin top-left, y down — the classic side-camera setup). Fills
        /// _target[]; zero allocation. Faithful to deriveFromPose().
        /// </summary>
        private void DeriveFromPose(PoseFrame frame, float delta)
        {
            // ok(name): keypoint with score >= 0.3, else "missing".
            bool TryOk(string n, out PoseKeypoint k)
            {
                if (frame.Keypoints != null &&
                    frame.Keypoints.TryGetValue(n, out k) && k.Score >= 0.3f)
                {
                    return true;
                }
                k = default;
                return false;
            }

            if (!TryOk(KeypointNames.LeftHip, out PoseKeypoint lh) ||
                !TryOk(KeypointNames.RightHip, out PoseKeypoint rh))
            {
                // Not enough signal this frame — hold the previous targets.
                return;
            }

            float hipX = (lh.X + rh.X) * 0.5f;
            float hipY = (lh.Y + rh.Y) * 0.5f;
            bool haveLs = TryOk(KeypointNames.LeftShoulder, out PoseKeypoint ls);
            bool haveRs = TryOk(KeypointNames.RightShoulder, out PoseKeypoint rs);
            bool haveLa = TryOk(KeypointNames.LeftAnkle, out PoseKeypoint la);
            bool haveRa = TryOk(KeypointNames.RightAnkle, out PoseKeypoint ra);

            // Pace — horizontal hip travel across the frame (normalized units/s).
            if (_poseHavePrev)
            {
                float v = Math.Abs(hipX - _posePrevHipX) / delta;
                _poseSpeedEma += (v - _poseSpeedEma) * (1f - (float)Math.Exp(-2f * delta));
            }
            _posePrevHipX = hipX;
            _poseHavePrev = true;

            // Posture — torso uprightness (|vertical| / length of shoulder->hip).
            if (haveLs && haveRs)
            {
                float sx = (ls.X + rs.X) * 0.5f;
                float sy = (ls.Y + rs.Y) * 0.5f;
                float vx = sx - hipX;
                float vy = sy - hipY;
                float len = (float)Math.Sqrt(vx * vx + vy * vy);
                if (len == 0f) len = 1e-3f; // (Math.hypot(...) || 1e-3)
                float upright = Math.Abs(vy) / len;
                _poseUprightEma += (upright - _poseUprightEma) * (1f - (float)Math.Exp(-1.5f * delta));
            }

            // Foot placement — ankle lateral spread from the body line.
            float lat = _poseLatEma;
            if (haveLa && haveRa) lat = (Math.Abs(la.X - hipX) + Math.Abs(ra.X - hipX)) * 0.5f;
            else if (haveLa) lat = Math.Abs(la.X - hipX);
            else if (haveRa) lat = Math.Abs(ra.X - hipX);
            _poseLatEma += (lat - _poseLatEma) * (1f - (float)Math.Exp(-1.5f * delta));

            // Rhythm — lead-foot bob cadence (a lift = image y decreasing).
            float? footY =
                haveLa && haveRa ? Math.Min(la.Y, ra.Y) :
                haveLa ? la.Y :
                haveRa ? ra.Y : (float?)null;
            if (footY.HasValue)
            {
                if (!_poseBobHavePrev)
                {
                    _poseBobBaseline = footY.Value;
                    _poseBobHavePrev = true;
                }
                _poseBobBaseline += (footY.Value - _poseBobBaseline) * (1f - (float)Math.Exp(-1.2f * delta));
                float dev = footY.Value - _poseBobBaseline;
                const float TH = 0.012f;
                if (dev < -TH && _poseBobSign >= 0)
                {
                    _poseBobSign = -1;
                    if (_poseLastCross >= 0f)
                    {
                        float interval = _walkTime - _poseLastCross;
                        if (interval >= StepMin && interval <= StepMax)
                        {
                            _intervals[_intervalIdx] = interval;
                            _intervalIdx = (_intervalIdx + 1) % RingSize;
                            if (_intervalCount < RingSize) _intervalCount++;
                        }
                    }
                    _poseLastCross = _walkTime;
                }
                else if (dev > TH && _poseBobSign <= 0)
                {
                    _poseBobSign = 1;
                }
            }

            // Scores (camera-relative mappings; tuned for a side camera).
            float pace = _poseSpeedEma < 0.01f
                ? 52f
                : 95f - Math.Abs(_poseSpeedEma - 0.18f) * 180f;

            float rhythm = 60f;
            if (_intervalCount >= 3)
            {
                float mean = 0f;
                for (int i = 0; i < _intervalCount; i++) mean += _intervals[i];
                mean /= _intervalCount;
                float mad = 0f;
                for (int i = 0; i < _intervalCount; i++) mad += Math.Abs(_intervals[i] - mean);
                mad /= _intervalCount;
                float cv = mean > 0f ? mad / mean : 1f;
                rhythm = 96f - cv * 220f;
            }

            float posture = 40f + ((_poseUprightEma - 0.82f) / 0.17f) * 58f;
            float footPlacement = 96f - _poseLatEma * 260f;

            float cPace = ClampScore(pace);
            float cRhythm = ClampScore(rhythm);
            float cPosture = ClampScore(posture);
            float cFoot = ClampScore(footPlacement);

            float sessionRamp = Math.Min(_walkTime / 45f, 1f);
            float presence = cPosture * 0.4f + cRhythm * 0.3f + cPace * 0.3f;
            float confidence =
                cPace * 0.25f + cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.15f +
                sessionRamp * 10f;
            float presentation =
                cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.2f + cPace * 0.15f +
                presence * 0.15f;

            _target[0] = posture;
            _target[1] = pace;
            _target[2] = rhythm;
            _target[3] = footPlacement;
            _target[4] = presence;
            _target[5] = confidence;
            _target[6] = presentation;
        }

        // -- External camera: WORLD-SPACE pose-stream derivation. ---------------

        /// <summary>
        /// Derive the quality scores from a streamed WORLD-SPACE skeleton (meters in
        /// the runway/world frame, e.g. native ARKit landmarks). True-metric
        /// mappings: pace is real m/s, footPlacement is real lateral distance from
        /// the travel line. Fills _target[]; zero allocation. Faithful to
        /// deriveFromPoseWorld().
        /// </summary>
        private void DeriveFromPoseWorld(PoseFrame frame, float delta)
        {
            bool TryOk(string name, out PoseKeypoint k)
            {
                if (frame.Keypoints != null &&
                    frame.Keypoints.TryGetValue(name, out k) && k.Score >= 0.3f)
                {
                    return true;
                }
                k = default;
                return false;
            }

            if (!TryOk(KeypointNames.LeftHip, out PoseKeypoint lh) ||
                !TryOk(KeypointNames.RightHip, out PoseKeypoint rh))
            {
                return; // Not enough signal this frame — hold the previous targets.
            }

            float hx = (lh.X + rh.X) * 0.5f;
            float hy = (lh.Y + rh.Y) * 0.5f;
            float hz = (lh.Z + rh.Z) * 0.5f;
            bool haveLs = TryOk(KeypointNames.LeftShoulder, out PoseKeypoint ls);
            bool haveRs = TryOk(KeypointNames.RightShoulder, out PoseKeypoint rs);
            bool haveLa = TryOk(KeypointNames.LeftAnkle, out PoseKeypoint la);
            bool haveRa = TryOk(KeypointNames.RightAnkle, out PoseKeypoint ra);

            if (_poseHavePrev)
            {
                float dx = hx - _posePrevHipX;
                float dz = hz - _posePrevHipZ;
                float mag = (float)Math.Sqrt(dx * dx + dz * dz);

                // Pace — true horizontal world speed (m/s), vs the ideal catwalk pace.
                float speed = mag / delta;
                if (speed > 4f) speed = 4f;
                _poseSpeedEma += (speed - _poseSpeedEma) * (1f - (float)Math.Exp(-2f * delta));

                // Heading — smoothed travel direction (only when actually moving).
                if (mag > 1e-4f)
                {
                    float a = 1f - (float)Math.Exp(-1.5f * delta);
                    _poseHeadingX += (dx / mag - _poseHeadingX) * a;
                    _poseHeadingZ += (dz / mag - _poseHeadingZ) * a;
                }

                // Foot placement — lateral distance of each ankle from the travel
                // line (perpendicular to heading). Small lateral = landing on line.
                float hmag = (float)Math.Sqrt(_poseHeadingX * _poseHeadingX + _poseHeadingZ * _poseHeadingZ);
                if (hmag == 0f) hmag = 1f;
                float hxn = _poseHeadingX / hmag;
                float hzn = _poseHeadingZ / hmag;
                float lat = 0f;
                int cnt = 0;
                if (haveLa)
                {
                    lat += Math.Abs((la.X - hx) * -hzn + (la.Z - hz) * hxn);
                    cnt++;
                }
                if (haveRa)
                {
                    lat += Math.Abs((ra.X - hx) * -hzn + (ra.Z - hz) * hxn);
                    cnt++;
                }
                if (cnt > 0)
                {
                    lat /= cnt;
                    _poseLatEma += (lat - _poseLatEma) * (1f - (float)Math.Exp(-1.5f * delta));
                }
            }
            _posePrevHipX = hx;
            _posePrevHipZ = hz;
            _poseHavePrev = true;

            // Posture — true torso tilt: |vertical| / length of shoulder->hip.
            if (haveLs && haveRs)
            {
                float vx = (ls.X + rs.X) * 0.5f - hx;
                float vy = (ls.Y + rs.Y) * 0.5f - hy;
                float vz = (ls.Z + rs.Z) * 0.5f - hz;
                float len = (float)Math.Sqrt(vx * vx + vy * vy + vz * vz);
                if (len == 0f) len = 1e-3f;
                float upright = Math.Abs(vy) / len; // 1 = perfectly vertical
                _poseUprightEma += (upright - _poseUprightEma) * (1f - (float)Math.Exp(-1.5f * delta));
            }

            // Rhythm — hip vertical-bob cadence (one up-crossing per stride).
            if (!_poseBobHavePrev)
            {
                _poseBobBaseline = hy;
                _poseBobHavePrev = true;
            }
            _poseBobBaseline += (hy - _poseBobBaseline) * (1f - (float)Math.Exp(-1.2f * delta));
            float dev = hy - _poseBobBaseline;
            const float TH = 0.008f; // world meters
            if (dev > TH && _poseBobSign <= 0)
            {
                _poseBobSign = 1;
                if (_poseLastCross >= 0f)
                {
                    float interval = _walkTime - _poseLastCross;
                    if (interval >= StepMin && interval <= StepMax)
                    {
                        _intervals[_intervalIdx] = interval;
                        _intervalIdx = (_intervalIdx + 1) % RingSize;
                        if (_intervalCount < RingSize) _intervalCount++;
                    }
                }
                _poseLastCross = _walkTime;
            }
            else if (dev < -TH && _poseBobSign >= 0)
            {
                _poseBobSign = -1;
            }

            // Scores (true-metric mappings).
            float pace = _poseSpeedEma < 0.05f
                ? 44f
                : 95f - Math.Abs(_poseSpeedEma - IdealPace) * 70f;

            float rhythm = 58f;
            if (_intervalCount >= 3)
            {
                float mean = 0f;
                for (int i = 0; i < _intervalCount; i++) mean += _intervals[i];
                mean /= _intervalCount;
                float mad = 0f;
                for (int i = 0; i < _intervalCount; i++) mad += Math.Abs(_intervals[i] - mean);
                mad /= _intervalCount;
                float cv = mean > 0f ? mad / mean : 1f;
                rhythm = 96f - cv * 220f;
            }

            // Upright torso ~0.97-1.0; a visible lean drops toward 0.90.
            float posture = 40f + ((_poseUprightEma - 0.9f) / 0.09f) * 58f;
            float footPlacement = 96f - _poseLatEma * 240f;

            float cPace = ClampScore(pace);
            float cRhythm = ClampScore(rhythm);
            float cPosture = ClampScore(posture);
            float cFoot = ClampScore(footPlacement);

            float sessionRamp = Math.Min(_walkTime / 45f, 1f);
            float presence = cPosture * 0.4f + cRhythm * 0.3f + cPace * 0.3f;
            float confidence =
                cPace * 0.25f + cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.15f +
                sessionRamp * 10f;
            float presentation =
                cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.2f + cPace * 0.15f +
                presence * 0.15f;

            _target[0] = posture;
            _target[1] = pace;
            _target[2] = rhythm;
            _target[3] = footPlacement;
            _target[4] = presence;
            _target[5] = confidence;
            _target[6] = presentation;
        }

        // -- Trainee: real head-motion derivation. ------------------------------

        /// <summary>Faithful to deriveFromHead(). Fills _target[]; updates LastStep.</summary>
        private void DeriveFromHead(float delta, double time)
        {
            Vector3 headPos = _head.HeadWorld;

            if (!_havePrev)
            {
                _headPrev = headPos;
                _bobBaseline = headPos.Y;
                _havePrev = true;
                return;
            }

            // Posture baseline: average head height over the first 0.5 s.
            if (_walkTime < 0.5f)
            {
                _baselineAcc += headPos.Y;
                _baselineSamples++;
                _baselineY = _baselineAcc / _baselineSamples;
            }

            // Pace — horizontal head velocity, EMA-smoothed, tracking-jump clamped.
            float dx = headPos.X - _headPrev.X;
            float dz = headPos.Z - _headPrev.Z;
            float speed = (float)Math.Sqrt(dx * dx + dz * dz) / delta;
            if (speed > 4f) speed = 4f;
            _speedEma += (speed - _speedEma) * (1f - (float)Math.Exp(-2f * delta));

            // Rhythm — vertical bob zero crossings (up-crossings, with hysteresis).
            // Each up-crossing IS a footstrike: record the interval AND update LastStep.
            _bobBaseline += (headPos.Y - _bobBaseline) * (1f - (float)Math.Exp(-1.2f * delta));
            float dev = headPos.Y - _bobBaseline;
            if (dev > BobThreshold && _bobSign <= 0)
            {
                _bobSign = 1;
                if (_lastCrossTime >= 0f)
                {
                    float interval = _walkTime - _lastCrossTime;
                    if (interval >= StepMin && interval <= StepMax)
                    {
                        _intervals[_intervalIdx] = interval;
                        _intervalIdx = (_intervalIdx + 1) % RingSize;
                        if (_intervalCount < RingSize) _intervalCount++;
                    }
                }
                _lastCrossTime = _walkTime;

                // Footstrike -> LastStep. `time` is the shader clock uTime runs on.
                // LastStep.Z is the deck-local ALONG FRACTION (0..1), not world z.
                _lastStep.Time = time;
                _lastStep.Z = _projector.AlongFraction(headPos.X, headPos.Z);
                OnFootStrike?.Invoke(_lastStep);
            }
            else if (dev < -BobThreshold && _bobSign >= 0)
            {
                _bobSign = -1;
            }

            // Posture — head-height stability vs walk start.
            float heightDev = Math.Abs(headPos.Y - _baselineY);
            _heightDevEma += (heightDev - _heightDevEma) * (1f - (float)Math.Exp(-1.5f * delta));

            // Foot placement — |projected lateral| from the runway centerline.
            float lat = Math.Abs(_projector.Lateral(headPos.X, headPos.Z));
            _latEma += (lat - _latEma) * (1f - (float)Math.Exp(-1.5f * delta));

            _headPrev = headPos;

            // Scores.
            float pace = _speedEma < 0.05f
                ? 44f
                : 95f - Math.Abs(_speedEma - IdealPace) * 70f;

            float rhythm = 58f;
            if (_intervalCount >= 3)
            {
                float mean = 0f;
                for (int i = 0; i < _intervalCount; i++) mean += _intervals[i];
                mean /= _intervalCount;
                float mad = 0f;
                for (int i = 0; i < _intervalCount; i++) mad += Math.Abs(_intervals[i] - mean);
                mad /= _intervalCount;
                float cv = mean > 0f ? mad / mean : 1f;
                rhythm = 96f - cv * 220f;
            }

            float posture = 96f - _heightDevEma * 350f;
            float footPlacement = 96f - _latEma * 240f;

            float cPace = ClampScore(pace);
            float cRhythm = ClampScore(rhythm);
            float cPosture = ClampScore(posture);
            float cFoot = ClampScore(footPlacement);

            float sessionRamp = Math.Min(_walkTime / 45f, 1f);
            float presence = cPosture * 0.4f + cRhythm * 0.3f + cPace * 0.3f;
            float confidence =
                cPace * 0.25f + cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.15f +
                sessionRamp * 10f;
            float presentation =
                cPosture * 0.25f + cRhythm * 0.25f + cFoot * 0.2f + cPace * 0.15f +
                presence * 0.15f;

            _target[0] = posture;
            _target[1] = pace;
            _target[2] = rhythm;
            _target[3] = footPlacement;
            _target[4] = presence;
            _target[5] = confidence;
            _target[6] = presentation;
        }

        // -- Helpers. -----------------------------------------------------------

        // Map the index-aligned _smooth[] into the named snapshot fields. Order
        // matches MetricsTable: 0 posture,1 pace,2 rhythm,3 footPlacement,
        // 4 presence,5 confidence,6 presentation.
        private void WriteSnapshotFromSmooth()
        {
            _snapshot.Posture = _smooth[0];
            _snapshot.Pace = _smooth[1];
            _snapshot.Rhythm = _smooth[2];
            _snapshot.FootPlacement = _smooth[3];
            _snapshot.Presence = _smooth[4];
            _snapshot.Confidence = _smooth[5];
            _snapshot.Presentation = _smooth[6];
        }

        private static void Fill(float[] arr, float v)
        {
            for (int i = 0; i < arr.Length; i++) arr[i] = v;
        }
    }
}
