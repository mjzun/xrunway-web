/**
 * (X)RUNWAY — External tracker: the live body-data ingestion point.
 *
 * Phase 2 is WIRED AND LIVE: real-time body data arrives from OUTSIDE the
 * headset (a phone on a tripod as a secondary camera) and drives the scoring.
 * The pipeline, end to end:
 *
 *   senders                          transport                    this app
 *   - iOS companion (native ARKit    ws(s)://<host>:8082          pose-ingest.ts
 *     body tracking; space "world",  the broadcast relay in       -> tracker.push()
 *     true meters, <=30 fps)      -> vite.config.ts — runs     -> -> MetricsSystem
 *   - /companion/ browser page       under `npm run dev` AND         (metrics.ts)
 *     (MediaPipe; space "image")     `vite preview` (#36)
 *
 * installExternalTracker() creates the singleton, and index.ts immediately
 * dials the relay with connectPoseRelay() (pose-ingest.ts: WebSocket with
 * reconnect/backoff, frames restamped to the local clock on arrival).
 * MetricsSystem prefers a fresh external frame over head-only derivation and
 * transparently falls back when frames stop or go stale (STALE_AFTER_SEC) —
 * the app runs fine with no companion at all.
 *
 * Hard constraints that shaped this design (see docs/SENSORS.md):
 *   - Quest passthrough cameras are NOT exposed to WebXR — no in-browser CV on
 *     the headset's own cameras. The headset's spatial sense comes from WebXR
 *     plane detection instead (used by the runway auto-map).
 *   - iPhone LiDAR / ARKit are native-iOS only; Safari has no WebXR. The iPhone
 *     sensor therefore streams over the network via the companion app — it
 *     cannot reach this page directly.
 *
 * This file itself stays transport-agnostic on purpose: it defines the
 * PoseFrame contract plus the freshness/fps bookkeeping, and any producer that
 * can call `push()` (the relay consumer today; WebRTC or a native bridge
 * tomorrow) plugs in without touching the consumers.
 */

/** A normalized body keypoint (meters, in the runway/world frame once mapped). */
export interface PoseKeypoint {
  x: number;
  y: number;
  z: number;
  /** 0..1 detector confidence. */
  score: number;
}

/** One frame of external body tracking. Keypoint names follow BlazePose/COCO. */
export interface PoseFrame {
  /** Performance clock (ms) when captured, in THIS page's time domain. */
  t: number;
  /** Source label, e.g. "iphone-arkit", "webcam". */
  source: string;
  /**
   * Coordinate space of the keypoints:
   *  - "world": meters in the sender's world frame (native ARKit) — real pace,
   *    posture, stride. Preferred.
   *  - "image": normalized image coords 0..1, y-down (browser MediaPipe) —
   *    camera-relative proxy. Default when omitted (browser companion).
   */
  space?: "image" | "world";
  /** Sparse map of keypoint name -> position. */
  keypoints: Record<string, PoseKeypoint>;
}

/** What a connected tracker advertises. */
export interface TrackerStatus {
  connected: boolean;
  source: string | null;
  /** Age of the most recent frame in seconds, or Infinity if none. */
  ageSec: number;
  fps: number;
}

/** Frames older than this are treated as "no live data". */
const STALE_AFTER_SEC = 0.6;

/**
 * Singleton ingestion point. In the shipped pipeline, connectPoseRelay
 * (pose-ingest.ts) calls `push()` with each PoseFrame the relay delivers;
 * any other producer (the dev console via `window.xrunwayTracker`, a future
 * WebRTC path) can do the same. Consumers (MetricsSystem) call
 * `latest()`/`status()`.
 */
export class ExternalTracker {
  private frame: PoseFrame | null = null;
  private frameCount = 0;
  private windowStart = 0;
  private windowCount = 0;
  private fps = 0;
  private nowMs: () => number;

  constructor(nowMs: () => number = defaultNow) {
    this.nowMs = nowMs;
    this.windowStart = nowMs();
  }

  /** Companion entry point: hand in the newest frame. */
  push(frame: PoseFrame): void {
    this.frame = frame;
    this.frameCount++;
    this.windowCount++;
    const now = this.nowMs();
    const span = (now - this.windowStart) / 1000;
    if (span >= 1) {
      this.fps = this.windowCount / span;
      this.windowStart = now;
      this.windowCount = 0;
    }
  }

  /** Most recent frame if fresh enough, else null (consumer falls back). */
  latest(): PoseFrame | null {
    if (!this.frame) return null;
    const ageSec = (this.nowMs() - this.frame.t) / 1000;
    return ageSec <= STALE_AFTER_SEC ? this.frame : null;
  }

  status(): TrackerStatus {
    const ageSec = this.frame
      ? (this.nowMs() - this.frame.t) / 1000
      : Infinity;
    return {
      connected: ageSec <= STALE_AFTER_SEC,
      source: this.frame?.source ?? null,
      ageSec,
      fps: Math.round(this.fps * 10) / 10,
    };
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Install the singleton on world.globals and expose `window.xrunwayTracker` so a
 * companion page/app (or the dev console) can push frames. Returns the instance.
 * The network side is wired immediately after install: index.ts hands the
 * instance to connectPoseRelay (pose-ingest.ts), which opens the relay
 * WebSocket and feeds `push()`.
 */
export function installExternalTracker(
  globals: Record<string, unknown>,
): ExternalTracker {
  const tracker = new ExternalTracker();
  globals.externalTracker = tracker;
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).xrunwayTracker = tracker;
  }
  return tracker;
}
