/**
 * (X)RUNWAY — THE JUDGES' TABLE, the paddle side (the table itself is built
 * by the stage: stage.ts buildJudgesTable, which exports the ROOT-LOCAL
 * paddle anchors on globals.judgesPaddles).
 *
 * At the score reveal (the graded sting's +REVEAL_DELAY_SEC anchor — the
 * SAME moment the medal pops), each judge raises a scored paddle: PACE,
 * CARRIAGE, LINE — the summary's own numbers, theatrical delivery. Same
 * numbers as the card/panel, never re-derived; CARRIAGE shows "-" when the
 * channel never engaged (honesty). Paddles lower + dispose when the
 * summary ends.
 *
 * Discipline:
 * - Display-only; reads globals.summary, writes nothing scoring reads.
 * - Node/canvas allocation happens ONCE per summary (the sfx event-scoped
 *   voice precedent); update() is lerp + yaw-billboard on 3 objects.
 * - Anchors are ROOT-LOCAL (stage frame): converted with the live spine
 *   placement (the front-row export convention). Null anchors (crowd
 *   hidden / no models) = the system idles.
 * - Rebuild-safe: the stage nulls judgesPaddles before every rebuild; a
 *   mid-summary rebuild lowers the paddles (anchor identity changes).
 */

import {
  CanvasTexture,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { paddleRaise01, paddleValues } from "./judges-core.js";
import { REVEAL_DELAY_SEC } from "./sfx-timeline.js";
import type { SegmentedPath } from "./runway-shape.js";
import type { ShowPhaseValue, ShowSummary } from "./show.js";

/** Raise travel distance (m) — starts hidden behind the table top. */
const RAISE_DIST = 0.55;

export interface JudgesPaddlesExport {
  rev: number;
  anchors: Array<{ x: number; y: number; z: number; yaw: number }>;
}

interface PaddleHandle {
  root: Object3D;
  baseX: number;
  baseY: number;
  baseZ: number;
  tex: CanvasTexture;
}

export class JudgesPaddlesSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private summarySig!: Signal<ShowSummary | null>;
  private pathSig!: Signal<SegmentedPath>;

  private entity: Entity | null = null;
  private paddles: PaddleHandle[] = [];
  private anchorsRef: JudgesPaddlesExport | null = null;
  /** Seconds since the summary landed; the raise starts at REVEAL_DELAY_SEC. */
  private summaryT = -1;
  private headPos!: Vector3;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.summarySig = g.summary as Signal<ShowSummary | null>;
    this.pathSig = g.compiledPath as Signal<SegmentedPath>;
    this.headPos = new Vector3();

    this.cleanupFuncs.push(
      this.phaseSig.subscribe((p) => {
        if (p === "summary") this.raise();
        else this.lower();
      }),
    );
    this.cleanupFuncs.push(() => this.lower());
  }

  /** Build the three paddles for this summary (event-scoped allocation). */
  private raise(): void {
    this.lower();
    const summary = this.summarySig.peek();
    const exp = this.globals.judgesPaddles as JudgesPaddlesExport | null;
    if (!summary || !exp || exp.anchors.length === 0) return;
    this.anchorsRef = exp;
    this.summaryT = 0;

    const spine = this.pathSig.peek().segments[0].rect;
    const c = Math.cos(spine.yaw);
    const s = Math.sin(spine.yaw);

    const root = this.world.createTransformEntity();
    root.object3D!.name = "judges-paddles-root";
    this.entity = root;
    const parent = root.object3D!;

    const values = paddleValues(summary);
    for (let i = 0; i < exp.anchors.length && i < values.length; i++) {
      const a = exp.anchors[i];
      const wx = spine.centerX + a.x * c + a.z * s;
      const wz = spine.centerZ - a.x * s + a.z * c;
      const tex = paddleTexture(values[i].label, values[i].value);
      const face = new Mesh(
        new PlaneGeometry(0.34, 0.42),
        new MeshBasicMaterial({ map: tex, side: DoubleSide, transparent: false }),
      );
      face.position.y = 0.21;
      const handle = new Mesh(
        new CylinderGeometry(0.014, 0.014, 0.2, 8),
        new MeshBasicMaterial({ color: 0x2a3038 }),
      );
      handle.position.y = -0.1;
      const paddle = new Object3D();
      paddle.name = `judges-paddle-${i}`;
      paddle.add(face, handle);
      paddle.position.set(wx, a.y - RAISE_DIST, wz);
      paddle.visible = false; // hidden until the reveal anchor
      parent.add(paddle);
      this.paddles.push({ root: paddle, baseX: wx, baseY: a.y, baseZ: wz, tex });
    }
  }

  private lower(): void {
    this.summaryT = -1;
    this.anchorsRef = null;
    this.paddles = [];
    if (this.entity) {
      this.entity.dispose(); // frees paddle geometry/materials/canvas textures
      this.entity = null;
    }
  }

  update(delta: number): void {
    if (this.summaryT < 0 || this.paddles.length === 0) return;
    // The stage rebuilt mid-summary — the table (and its anchors) moved or
    // vanished; lower rather than float paddles over a stale spot.
    if (this.globals.judgesPaddles !== this.anchorsRef) {
      this.lower();
      return;
    }
    this.summaryT += delta;
    const t = this.summaryT - REVEAL_DELAY_SEC;
    if (t < 0) return;

    this.player.head.getWorldPosition(this.headPos);
    for (let i = 0; i < this.paddles.length; i++) {
      const p = this.paddles[i];
      const k = paddleRaise01(t, i);
      if (k <= 0) continue;
      p.root.visible = true;
      // Rise from behind the table + a gentle held wobble once up.
      const wobble =
        k >= 1 ? Math.sin(t * 1.7 + i * 1.9) * 0.035 : (1 - k) * 0.12;
      p.root.position.set(p.baseX, p.baseY - RAISE_DIST * (1 - k), p.baseZ);
      p.root.rotation.z = wobble;
      // Yaw-billboard toward the viewer — readable from wherever the
      // trainee ended the walk (paddle face is +z under yaw a -> faces
      // (sin a, cos a); aim at the head).
      p.root.rotation.y = Math.atan2(
        this.headPos.x - p.baseX,
        this.headPos.z - p.baseZ,
      );
    }
  }
}

/** One paddle face: near-black card, Carolina ring, metric label + the big
 * number ("-" when the channel never engaged). Event-scoped canvas. */
function paddleTexture(label: string, value: number | null): CanvasTexture {
  const W = 256;
  const H = 320;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#4b9cd3";
    ctx.lineWidth = 10;
    ctx.strokeRect(9, 9, W - 18, H - 18);
    ctx.textAlign = "center";
    ctx.fillStyle = "#8a8f96";
    ctx.font = "600 30px 'Space Grotesk', sans-serif";
    ctx.fillText(label, W / 2, 74);
    ctx.fillStyle = "#f2f5f8";
    ctx.font = "600 128px 'Space Grotesk', sans-serif";
    ctx.fillText(value === null ? "-" : String(value), W / 2, 218);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
