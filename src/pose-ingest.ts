/**
 * (X)RUNWAY — Pose relay ingest (Phase 2).
 *
 * Connects the running app to the pose relay (vite.config.ts, port 8082) and
 * feeds incoming `PoseFrame`s into the shared {@link ExternalTracker}. The
 * companion capture page (an iPhone/webcam on a tripod) is the producer; this
 * is the consumer side inside the headset/browser session.
 *
 * Clock note: the companion stamps `frame.t` with ITS OWN performance clock,
 * which is not comparable to ours across devices. Freshness here means "arrived
 * recently", so we RESTAMP `frame.t` to our local clock on arrival before
 * pushing — the tracker's staleness math then works regardless of device skew.
 * (The companion's original timestamp is preserved on `frame.sentT` for latency
 * inspection.)
 *
 * Non-fatal by design: if no relay is running (the common case — nobody has a
 * companion connected), this quietly retries in the background and the app runs
 * on head-only metrics. Returns a disposer that stops reconnecting and closes.
 */

import type { ExternalTracker, PoseFrame } from "./external-tracker.js";

/** Relay port — must match POSE_RELAY_PORT in vite.config.ts. */
const RELAY_PORT = 8082;
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 15000;

interface RelayMessage {
  type: string;
  frame?: PoseFrame;
}

export function connectPoseRelay(
  tracker: ExternalTracker,
  opts: { url?: string; log?: (m: string) => void } = {},
): () => void {
  const log = opts.log ?? (() => {});
  const url = opts.url ?? defaultRelayUrl();
  if (!url) {
    log("[pose-ingest] no window.location — relay disabled");
    return () => {};
  }

  let ws: WebSocket | null = null;
  let disposed = false;
  let backoff = RECONNECT_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (): void => {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, backoff);
    backoff = Math.min(backoff * 1.6, RECONNECT_MAX_MS);
  };

  const open = (): void => {
    if (disposed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = (): void => {
      log(`[pose-ingest] connected to ${url}`);
      try {
        ws?.send(JSON.stringify({ type: "hello", role: "receiver" }));
      } catch {
        /* ignore */
      }
    };

    ws.onmessage = (ev: MessageEvent): void => {
      // Reset backoff only once the connection has proven useful (a real frame
      // arrived) — NOT on open — so a flapping relay (opens then immediately
      // closes) still backs off instead of hammering reconnect every 1.5s.
      backoff = RECONNECT_MIN_MS;
      let msg: RelayMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as RelayMessage;
      } catch {
        return;
      }
      if (
        msg.type === "pose" &&
        msg.frame &&
        msg.frame.keypoints &&
        Object.keys(msg.frame.keypoints).length > 0
      ) {
        // Reject a content-free frame (empty keypoints {}): pushing it would
        // mark the tracker "connected" with no data, suppressing head fallback.
        const frame = msg.frame;
        // Restamp into our clock; keep the sender's stamp for latency.
        (frame as PoseFrame & { sentT?: number }).sentT = frame.t;
        frame.t = now();
        tracker.push(frame);
      }
    };

    ws.onclose = (): void => {
      ws = null;
      if (!disposed) scheduleReconnect();
    };

    ws.onerror = (): void => {
      // onclose will follow and schedule the retry.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  };

  open();

  return (): void => {
    disposed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  };
}

function defaultRelayUrl(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.hostname || "localhost";
  return `${proto}://${host}:${RELAY_PORT}`;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
