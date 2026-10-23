/**
 * (X)RUNWAY — THE WALK CARD (Build: WALK CARD).
 *
 * A shareable 1200x630 score-card PNG composed IN-BROWSER on a 2D canvas
 * from the summary the page already holds — the og.png brand language
 * (scripts/gen-og-card.mjs): near-black radial stage, the converging
 * runway-perspective accent lines, Space Grotesk wordmark with the Carolina
 * (X), Playfair italic tagline. Every string on the card is structural /
 * numeric (labels the product already ships + numbers); the tagline is the
 * founder's ruled brand line.
 *
 * Display-only: reads the finished summary, never touches scoring. The
 * typefaces are the SELF-HOSTED slices index.html already @font-face-loads
 * (public/fonts/) — ensureCardFonts() awaits them so the canvas never bakes
 * a fallback face.
 */

import { MEDAL_COLOR, MEDAL_LABEL, type MedalTier } from "./hud-copy.js";

export const WALK_CARD_W = 1200;
export const WALK_CARD_H = 630;

/** The founder's ruled brand tagline (B1.1 / venture outline). */
export const WALK_CARD_TAGLINE = "Take the next step.";

/** Everything the card renders — all structural/numeric (no new voice). */
export interface WalkCardData {
  overall: number;
  medal: MedalTier | null;
  pace: number;
  /** Head-carriage score, or null when the channel never engaged. */
  carriage: number | null;
  line: number;
  /** Runway shape kind ("straight" | "T" | "X" | "U") — drives the glyph. */
  shapeKind: string;
  runwayLength: number | null;
  runwayWidth: number | null;
  /** YYYY-MM-DD (the walk's day). */
  dateIso: string;
}

const BG_IN = "#0a0c10";
const BG_OUT = "#05070a";
const WHITE = "#f2f5f8";
const SILVER = "#8a8f96";
const ACCENT = "#4b9cd3";

/** Await the three brand faces at the sizes the card uses (no-op once
 * loaded). document.fonts is per-page — index.html declares the faces. */
export async function ensureCardFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all([
    document.fonts.load('600 190px "Space Grotesk"'),
    document.fonts.load('500 18px "Space Grotesk"'),
    document.fonts.load('italic 600 34px "Playfair Display"'),
  ]).catch(() => {
    /* a missing face draws with the fallback — never block the share */
  });
}

/** Letter-spaced text (canvas letterSpacing where supported, else manual). */
function spacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacingPx: number,
): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) {
    c.letterSpacing = `${spacingPx}px`;
    ctx.fillText(text, x, y);
    c.letterSpacing = "0px";
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacingPx;
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The runway shape glyph (stroke, Carolina) — matches the app's shapes:
 * straight spine / T-bar at the far end / the X "+" cross / the U horseshoe. */
function drawShapeGlyph(
  ctx: CanvasRenderingContext2D,
  kind: string,
  cx: number,
  cy: number,
  size: number,
): void {
  const h = size / 2;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  if (kind === "T") {
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx, cy - h + 6);
    ctx.moveTo(cx - h, cy - h + 6);
    ctx.lineTo(cx + h, cy - h + 6);
  } else if (kind === "X") {
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx, cy - h);
    ctx.moveTo(cx - h, cy);
    ctx.lineTo(cx + h, cy);
  } else if (kind === "U") {
    ctx.moveTo(cx - h + 6, cy - h);
    ctx.lineTo(cx - h + 6, cy + h - 14);
    ctx.arcTo(cx - h + 6, cy + h, cx, cy + h, 14);
    ctx.arcTo(cx + h - 6, cy + h, cx + h - 6, cy + h - 14, 14);
    ctx.lineTo(cx + h - 6, cy - h);
  } else {
    // straight
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx, cy - h);
  }
  ctx.stroke();
  ctx.restore();
}

/** Draw the whole card into a 2D context (canvas must be 1200x630). Pure
 * given its inputs — the verification harness calls it directly. */
export function drawWalkCard(
  ctx: CanvasRenderingContext2D,
  d: WalkCardData,
): void {
  const W = WALK_CARD_W;
  const H = WALK_CARD_H;

  // Stage: the og radial (ellipse approximated with a wide radial).
  const grad = ctx.createRadialGradient(
    W / 2,
    H * 0.42,
    60,
    W / 2,
    H * 0.42,
    W * 0.72,
  );
  grad.addColorStop(0, BG_IN);
  grad.addColorStop(1, BG_OUT);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Converging runway-perspective lines (the og floor motif, low alpha).
  const LINES: Array<[number, number, number, number, number]> = [
    [480, 700, 583, 330, 0.22],
    [720, 700, 617, 330, 0.22],
    [330, 700, 560, 330, 0.22],
    [870, 700, 640, 330, 0.22],
    [140, 700, 530, 330, 0.1],
    [1060, 700, 670, 330, 0.1],
  ];
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  for (const [x1, y1, x2, y2, a] of LINES) {
    ctx.globalAlpha = a * 0.65; // dimmer than the og hero — data reads first
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  // Header: wordmark left, date + runway facts right.
  ctx.textBaseline = "alphabetic";
  ctx.font = '600 40px "Space Grotesk"';
  ctx.fillStyle = ACCENT;
  spacedText(ctx, "(X)", 64, 92, 6);
  const xw = ctx.measureText("(X)").width + 3 * 6;
  ctx.fillStyle = WHITE;
  spacedText(ctx, "RUNWAY", 64 + xw + 6, 92, 6);

  ctx.font = '500 17px "Space Grotesk"';
  ctx.fillStyle = SILVER;
  ctx.textAlign = "right";
  const dims =
    d.runwayLength !== null && d.runwayWidth !== null
      ? `${d.runwayLength.toFixed(1)}M X ${d.runwayWidth.toFixed(1)}M - ${d.shapeKind.toUpperCase()}`
      : d.shapeKind.toUpperCase();
  spacedText(ctx, d.dateIso, W - 64, 74, 4);
  spacedText(ctx, dims, W - 64, 102, 4);
  ctx.textAlign = "left";

  // Left: the overall number + caption + medal chip.
  ctx.font = '600 190px "Space Grotesk"';
  ctx.fillStyle = WHITE;
  const overall = String(Math.round(d.overall));
  ctx.fillText(overall, 64, 340);
  ctx.font = '500 19px "Space Grotesk"';
  ctx.fillStyle = SILVER;
  spacedText(ctx, "OVERALL / 100", 70, 384, 5);
  if (d.medal !== null) {
    const label = MEDAL_LABEL[d.medal];
    ctx.font = '600 20px "Space Grotesk"';
    const tw = ctx.measureText(label).width + 4 * label.length;
    roundedRect(ctx, 68, 416, tw + 44, 44, 22);
    ctx.fillStyle = MEDAL_COLOR[d.medal];
    ctx.fill();
    ctx.fillStyle = "#0a0c10";
    spacedText(ctx, label, 68 + 22, 445, 4);
  }

  // Right: the three shipped head-metric bars.
  const rows: Array<[string, number | null]> = [
    ["PACE", d.pace],
    ["CARRIAGE", d.carriage],
    ["LINE", d.line],
  ];
  const bx = 560;
  const bw = 500;
  let by = 200;
  for (const [label, value] of rows) {
    ctx.font = '600 20px "Space Grotesk"';
    ctx.fillStyle = SILVER;
    spacedText(ctx, label, bx, by, 5);
    ctx.font = '600 30px "Space Grotesk"';
    ctx.fillStyle = WHITE;
    ctx.textAlign = "right";
    ctx.fillText(value === null ? "-" : String(Math.round(value)), bx + bw, by + 2);
    ctx.textAlign = "left";
    // Track + fill.
    roundedRect(ctx, bx, by + 18, bw, 10, 5);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();
    if (value !== null) {
      const v = Math.max(0, Math.min(100, value));
      const fw = Math.max(10, (bw * v) / 100);
      const fill = ctx.createLinearGradient(bx, 0, bx + fw, 0);
      fill.addColorStop(0, "#2f7cb3");
      fill.addColorStop(1, ACCENT);
      roundedRect(ctx, bx, by + 18, fw, 10, 5);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    by += 92;
  }

  // Bottom: shape glyph + tagline.
  drawShapeGlyph(ctx, d.shapeKind, 104, 528, 76);
  ctx.font = 'italic 600 34px "Playfair Display"';
  ctx.fillStyle = WHITE;
  ctx.textAlign = "center";
  ctx.fillText(WALK_CARD_TAGLINE, W / 2 + 60, 560);
  ctx.textAlign = "left";
}

/** Compose the card and return it as a PNG Blob (browser only). */
export async function buildWalkCardBlob(d: WalkCardData): Promise<Blob> {
  await ensureCardFonts();
  const canvas = document.createElement("canvas");
  canvas.width = WALK_CARD_W;
  canvas.height = WALK_CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("walk-card: no 2d context");
  drawWalkCard(ctx, d);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("walk-card: toBlob failed"));
    }, "image/png");
  });
}

/** The download filename — date + score, filesystem-safe. */
export function walkCardFilename(d: WalkCardData): string {
  return `xrunway-walk-${d.dateIso}-${Math.round(d.overall)}.png`;
}
