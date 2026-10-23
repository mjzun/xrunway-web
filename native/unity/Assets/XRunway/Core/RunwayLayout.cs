// (X)RUNWAY — Live runway mapping model (C# port of src/runway-layout.ts).
//
// Faithful, UNIT-TESTED port: the RunwayLayout model + RunwayProjector along/
// lateral math match the TypeScript EXACTLY (this is the validated logic). Plain
// C#, NO UnityEngine dependency, so Core stays unit-testable. The Unity layer
// supplies an ILayoutStore (PlayerPrefs) for persistence.
//
// Frame convention (yaw = 0 reproduces the original fixed layout):
//   - The layout is a rectangle on the floor (y = 0): center (centerX, centerZ),
//     rotation `yaw` about +Y, `length` along the walk axis, `width` across.
//   - FORWARD (start end -> pose end) unit vector  f(yaw) = (-sin, 0, -cos)
//       yaw 0  -> (0, 0, -1)   (away from the trainee, original behaviour)
//   - RIGHT (lateral +) unit vector               r(yaw) = ( cos, 0, -sin)
//       yaw 0  -> (1, 0,  0)   (+X)
//   - `along` in [0, length]: 0 at the START (near) end, length at the POSE
//     (far) end. `lateral` is the signed distance from the centerline.

using System;
using System.Globalization;

namespace XRunway.Core
{
    /// <summary>A point on the floor (world meters), y implied 0.</summary>
    public struct RunwayPoint
    {
        public float X;
        public float Z;

        public RunwayPoint(float x, float z)
        {
            X = x;
            Z = z;
        }
    }

    /// <summary>
    /// The editable runway placement. Mirrors the TS RunwayLayout interface; a
    /// value type so passing it around copies (no shared mutation surprises).
    /// </summary>
    [Serializable]
    public struct RunwayLayout : IEquatable<RunwayLayout>
    {
        /// <summary>World X of the runway center, on the floor.</summary>
        public float CenterX;
        /// <summary>World Z of the runway center, on the floor.</summary>
        public float CenterZ;
        /// <summary>Rotation about +Y, radians. 0 = walk toward -Z (original layout).</summary>
        public float Yaw;
        /// <summary>Length along the walk axis, meters.</summary>
        public float Length;
        /// <summary>Width across, meters.</summary>
        public float Width;

        public RunwayLayout(float centerX, float centerZ, float yaw, float length, float width)
        {
            CenterX = centerX;
            CenterZ = centerZ;
            Yaw = yaw;
            Length = length;
            Width = width;
        }

        // Matches layoutsEqual() in the TS (1e-4 tolerance on every field).
        public bool Equals(RunwayLayout b) =>
            Math.Abs(CenterX - b.CenterX) < 1e-4f &&
            Math.Abs(CenterZ - b.CenterZ) < 1e-4f &&
            Math.Abs(Yaw - b.Yaw) < 1e-4f &&
            Math.Abs(Length - b.Length) < 1e-4f &&
            Math.Abs(Width - b.Width) < 1e-4f;

        public override bool Equals(object obj) => obj is RunwayLayout b && Equals(b);

        public override int GetHashCode() =>
            HashCode.Combine(CenterX, CenterZ, Yaw, Length, Width);
    }

    /// <summary>Editable bounds (HUD sliders + walk-and-place clamp to these).</summary>
    public static class LayoutLimits
    {
        public const float MinLength = 3f;
        public const float MaxLength = 14f;
        public const float MinWidth = 0.8f;
        public const float MaxWidth = 3f;
        /// <summary>How far from the AR origin the center may sit (keeps it reachable).</summary>
        public const float MaxOffset = 8f;
    }

    /// <summary>
    /// Runway model constants + factories. The TS theme values are baked here so
    /// Core has no theme.ts dependency:
    ///   STAGE.deckWidth = 1.4, STAGE.deckLength = 7, STAGE.nearGap = 0.25
    ///   DECK_CENTER_Z   = -nearGap - deckLength/2 = -3.75
    /// </summary>
    public static class RunwayLayoutModel
    {
        /// <summary>Pose mark inset from the FAR end (m) — "walk to the mark".</summary>
        public const float PoseInset = 0.6f;

        /// <summary>Start/finish line inset from the NEAR end (m).</summary>
        public const float StartInset = 0.15f;

        // --- Baked theme constants (src/theme.ts), so Core is self-contained. ---
        private const float DeckWidth = 1.4f;
        private const float DeckLength = 7f;
        private const float NearGap = 0.25f;
        /// <summary>DECK_CENTER_Z = -nearGap - deckLength/2.</summary>
        public const float DeckCenterZ = -NearGap - DeckLength / 2f; // -3.75

        /// <summary>The original REV2 placement, expressed as a layout.</summary>
        public static readonly RunwayLayout DefaultLayout = new RunwayLayout
        {
            CenterX = 0f,
            CenterZ = DeckCenterZ,
            Yaw = 0f,
            Length = DeckLength,
            Width = DeckWidth,
        };

        /// <summary>Along-coordinate of the pose mark for a given layout.</summary>
        public static float PoseAlong(in RunwayLayout layout) =>
            Math.Max(0f, layout.Length - PoseInset);

        /// <summary>Along-coordinate of the start/finish line (layout-independent).</summary>
        public static float StartAlong() => StartInset;

        private static float Clamp(float v, float lo, float hi) =>
            v < lo ? lo : (v > hi ? hi : v);

        /// <summary>
        /// Clamp a (possibly user/auto-supplied) layout into the editable bounds.
        /// Mirrors sanitizeLayout(): the yaw wraps via the float `%` like the TS
        /// `% (Math.PI * 2)` (note: C# `%` keeps the sign of the dividend, same as
        /// JS — negative yaws stay negative).
        /// </summary>
        public static RunwayLayout Sanitize(in RunwayLayout p)
        {
            return new RunwayLayout
            {
                CenterX = Clamp(p.CenterX, -LayoutLimits.MaxOffset, LayoutLimits.MaxOffset),
                CenterZ = Clamp(p.CenterZ, -LayoutLimits.MaxOffset, LayoutLimits.MaxOffset),
                Yaw = p.Yaw % (float)(Math.PI * 2.0),
                Length = Clamp(p.Length, LayoutLimits.MinLength, LayoutLimits.MaxLength),
                Width = Clamp(p.Width, LayoutLimits.MinWidth, LayoutLimits.MaxWidth),
            };
        }

        /// <summary>layoutsEqual() helper (see RunwayLayout.Equals).</summary>
        public static bool LayoutsEqual(in RunwayLayout a, in RunwayLayout b) => a.Equals(b);

        /// <summary>
        /// Build a layout from two floor points (the walk-and-place flow): the
        /// trainee marks where they START and where they END (the pose mark). The
        /// runway is the rectangle whose centerline runs start -> end, with the
        /// given width. Faithful to layoutFromEndpoints().
        /// </summary>
        public static RunwayLayout FromEndpoints(
            float startX, float startZ, float endX, float endZ, float width)
        {
            float dx = endX - startX;
            float dz = endZ - startZ;
            // Walked distance is StartInset .. (length - PoseInset); recover full length.
            float walked = (float)Math.Sqrt(dx * dx + dz * dz); // Math.hypot
            float length = walked + StartInset + PoseInset;
            // forward = normalize(end - start); solve yaw from f = (-sin, 0, -cos).
            float yaw = (float)Math.Atan2(-dx, -dz);
            float fx = -(float)Math.Sin(yaw);
            float fz = -(float)Math.Cos(yaw);
            // start end of the rectangle sits StartInset behind the marked start point.
            float rectStartX = startX - fx * StartInset;
            float rectStartZ = startZ - fz * StartInset;
            float centerX = rectStartX + fx * (length / 2f);
            float centerZ = rectStartZ + fz * (length / 2f);
            return Sanitize(new RunwayLayout
            {
                CenterX = centerX,
                CenterZ = centerZ,
                Yaw = yaw,
                Length = length,
                Width = width,
            });
        }
    }

    /// <summary>
    /// Reusable projector: world (x, z) -> runway-local (along, lateral). Hold ONE
    /// per system, call <see cref="Set"/> whenever the layout changes, and call
    /// <see cref="Along"/>/<see cref="Lateral"/> in update() — pure scalar math,
    /// zero allocation. Faithful to the TS RunwayProjector.
    /// </summary>
    public sealed class RunwayProjector
    {
        private float _fx = 0f;
        private float _fz = -1f;
        private float _rx = 1f;
        private float _rz = 0f;
        private float _cx = 0f;
        private float _cz = RunwayLayoutModel.DeckCenterZ;

        public float Length { get; private set; } = RunwayLayoutModel.DefaultLayout.Length;
        public float Width { get; private set; } = RunwayLayoutModel.DefaultLayout.Width;

        public RunwayProjector() : this(RunwayLayoutModel.DefaultLayout) { }

        public RunwayProjector(in RunwayLayout layout)
        {
            Set(layout);
        }

        public void Set(in RunwayLayout layout)
        {
            float s = (float)Math.Sin(layout.Yaw);
            float c = (float)Math.Cos(layout.Yaw);
            _fx = -s;
            _fz = -c;
            _rx = c;
            _rz = -s;
            _cx = layout.CenterX;
            _cz = layout.CenterZ;
            Length = layout.Length;
            Width = layout.Width;
        }

        /// <summary>along in [0, length]: 0 at the start (near) end, length at the pose end.</summary>
        public float Along(float px, float pz)
        {
            float dx = px - _cx;
            float dz = pz - _cz;
            return dx * _fx + dz * _fz + Length / 2f;
        }

        /// <summary>Signed lateral distance from the centerline (m).</summary>
        public float Lateral(float px, float pz)
        {
            float dx = px - _cx;
            float dz = pz - _cz;
            return dx * _rx + dz * _rz;
        }

        /// <summary>along as a 0..1 fraction (clamped) — for the floor shader's uStepZ.</summary>
        public float AlongFraction(float px, float pz)
        {
            float a = Along(px, pz) / Length;
            return a < 0f ? 0f : (a > 1f ? 1f : a);
        }
    }

    // -----------------------------------------------------------------------
    // Persistence seam — survives reloads and device handoff.
    //
    // Core defines the contract only; a PlayerPrefs implementation lives in the
    // Unity layer (see README). The TS uses localStorage under the key
    // "xrunway.runwayLayout.v1" — keep the same key + JSON shape so the native
    // app can read a layout saved by the web prototype if ever copied across.
    // -----------------------------------------------------------------------

    /// <summary>Load/save hook for a RunwayLayout. Unity provides a PlayerPrefs impl.</summary>
    public interface ILayoutStore
    {
        /// <summary>Load a saved layout, or the default if none/invalid.</summary>
        RunwayLayout Load();
        /// <summary>Persist a layout.</summary>
        void Save(in RunwayLayout layout);
    }

    /// <summary>
    /// Storage-key + minimal JSON (de)serialization shared by ILayoutStore impls,
    /// matching the TS persistence format exactly. Kept in Core (no UnityEngine)
    /// so it is unit-testable; the Unity store just supplies the string get/set.
    /// </summary>
    public static class LayoutStorage
    {
        /// <summary>Matches STORAGE_KEY in runway-layout.ts.</summary>
        public const string StorageKey = "xrunway.runwayLayout.v1";

        /// <summary>
        /// Serialize to the SAME JSON shape the TS writes:
        /// {"centerX":..,"centerZ":..,"yaw":..,"length":..,"width":..}.
        /// Invariant culture so the decimal separator is always '.'.
        /// </summary>
        public static string ToJson(in RunwayLayout l)
        {
            var ci = CultureInfo.InvariantCulture;
            return "{" +
                "\"centerX\":" + l.CenterX.ToString("R", ci) + "," +
                "\"centerZ\":" + l.CenterZ.ToString("R", ci) + "," +
                "\"yaw\":" + l.Yaw.ToString("R", ci) + "," +
                "\"length\":" + l.Length.ToString("R", ci) + "," +
                "\"width\":" + l.Width.ToString("R", ci) +
                "}";
        }

        /// <summary>
        /// Parse a layout from the TS JSON shape and Sanitize it (matching
        /// loadLayout(): bad/empty input falls back to the default). Tolerant,
        /// dependency-free key scan — avoids pulling in a JSON library into Core.
        /// </summary>
        public static RunwayLayout FromJson(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return RunwayLayoutModel.DefaultLayout;
            }
            try
            {
                var d = RunwayLayoutModel.DefaultLayout;
                var parsed = new RunwayLayout
                {
                    CenterX = ReadNumber(raw, "centerX", d.CenterX),
                    CenterZ = ReadNumber(raw, "centerZ", d.CenterZ),
                    Yaw = ReadNumber(raw, "yaw", 0f),
                    Length = ReadNumber(raw, "length", d.Length),
                    Width = ReadNumber(raw, "width", d.Width),
                };
                return RunwayLayoutModel.Sanitize(parsed);
            }
            catch
            {
                return RunwayLayoutModel.DefaultLayout;
            }
        }

        private static float ReadNumber(string json, string key, float fallback)
        {
            string needle = "\"" + key + "\"";
            int k = json.IndexOf(needle, StringComparison.Ordinal);
            if (k < 0) return fallback;
            int c = json.IndexOf(':', k + needle.Length);
            if (c < 0) return fallback;
            int i = c + 1;
            while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
            int start = i;
            while (i < json.Length)
            {
                char ch = json[i];
                bool numeric = (ch >= '0' && ch <= '9') || ch == '-' || ch == '+' ||
                               ch == '.' || ch == 'e' || ch == 'E';
                if (!numeric) break;
                i++;
            }
            if (i == start) return fallback;
            string slice = json.Substring(start, i - start);
            return float.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out float v)
                ? v
                : fallback;
        }
    }
}
