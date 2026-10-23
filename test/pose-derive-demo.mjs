/**
 * Synthetic-pose validation harness (offline, no phone/network).
 *
 * Faithfully replicates the WORLD-POSE speed/footwork/rhythm math from
 * src/metrics.ts (deriveFromPoseWorld) and drives it with a simulated walk to
 * validate the 2026-06-30 pose-receiving fixes WITHOUT a live pose stream:
 *
 *   BUG (pre-fix): MetricsSystem.update() runs every APP frame (72-90 Hz) but
 *   ExternalTracker.latest() returns the SAME frame until the sender pushes a
 *   new one (<=30 Hz). Re-deriving a repeated frame divides a zero hip
 *   displacement by the app delta and pulls the pace EMA toward zero.
 *
 *   FIX: gate on frame.t and derive with the TRUE inter-pose delta.
 *
 * This is a faithful REPLICA of the formulas (same constants, same EMA), so it
 * validates the ALGORITHM; the live-pose smoke test on-device is the full-
 * fidelity check. Run:  node test/pose-derive-demo.mjs
 */

const APP_HZ = 90; // app/render loop rate
const POSE_HZ = 30; // capped pose-stream rate (iOS sender throttle)
const SECONDS = 12; // simulated walk length
const IDEAL_PACE = 1.3; // m/s the pace score is tuned around (representative)
const SPEED_CLAMP = 4; // metrics.ts clamps speed to 4 m/s

// pace score exactly as metrics.ts deriveFromPoseWorld (lines ~577-580)
const paceScore = (ema) =>
  ema < 0.05 ? 44 : Math.max(0, Math.min(100, 95 - Math.abs(ema - IDEAL_PACE) * 70));

// One EMA speed integrator with the two derivation policies.
function run(trueSpeed, gated) {
  const appDt = 1 / APP_HZ;
  const poseDt = 1 / POSE_HZ;
  let ema = 0;
  let prevHx = 0;
  let havePrev = false;
  let poseLastT = -1;
  // pose frames: frame index -> {t(ms), hx}
  const nApp = Math.round(SECONDS * APP_HZ);
  const samples = []; // ema sampled over the last 2 s to measure noise
  for (let k = 0; k < nApp; k++) {
    const tApp = k / APP_HZ;
    // latest() = most recent pose frame at or before tApp
    const poseIdx = Math.floor(tApp / poseDt);
    const tPose = poseIdx / POSE_HZ;
    const hx = trueSpeed * tPose; // walking +x at trueSpeed; hz=0
    const frameT = tPose * 1000; // frame.t in ms (restamped on arrival, monotonic)

    if (gated) {
      // NEW: derive only on a fresh frame, with the true inter-pose delta.
      if (frameT !== poseLastT) {
        const dt = poseLastT >= 0 ? (frameT - poseLastT) / 1000 : 0;
        poseLastT = frameT;
        if (havePrev && dt > 0) {
          let speed = Math.abs(hx - prevHx) / dt;
          if (speed > SPEED_CLAMP) speed = SPEED_CLAMP;
          ema += (speed - ema) * (1 - Math.exp(-2 * dt));
        }
        prevHx = hx;
        havePrev = true;
      }
    } else {
      // OLD: derive every app frame with the app delta on the (repeated) frame.
      if (havePrev) {
        let speed = Math.abs(hx - prevHx) / appDt;
        if (speed > SPEED_CLAMP) speed = SPEED_CLAMP;
        ema += (speed - ema) * (1 - Math.exp(-2 * appDt));
      }
      prevHx = hx;
      havePrev = true;
    }
    if (tApp >= SECONDS - 2) samples.push(ema);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd = Math.sqrt(
    samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / samples.length,
  );
  return { mean, sd };
}

console.log(`Simulated walk: app ${APP_HZ}Hz, pose ${POSE_HZ}Hz (${APP_HZ / POSE_HZ} app frames/pose), ${SECONDS}s\n`);
console.log("speed | true | OLD est (score) ±noise | NEW est (score) ±noise | true score");
console.log("------+------+------------------------+------------------------+-----------");
for (const v of [0.8, 1.1, 1.3, 1.6, 2.0, 2.6]) {
  const oldR = run(v, false);
  const newR = run(v, true);
  const fmt = (r) => `${r.mean.toFixed(2)} (${paceScore(r.mean).toFixed(0)}) ±${r.sd.toFixed(2)}`;
  const oldErr = (((oldR.mean - v) / v) * 100).toFixed(0);
  const newErr = (((newR.mean - v) / v) * 100).toFixed(0);
  console.log(
    `${v.toFixed(1)}   | ${v.toFixed(2)} | ${fmt(oldR).padEnd(22)} | ${fmt(newR).padEnd(22)} | ${paceScore(v).toFixed(0)}   [old ${oldErr}% / new ${newErr}%]`,
  );
}
console.log("\nest = converged pace EMA (m/s); score = the metrics.ts pace score; noise = SD over last 2s.");
