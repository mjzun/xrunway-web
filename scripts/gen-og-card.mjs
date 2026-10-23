// gen-og-card.mjs — regenerate the committed 1200x630 share card (public/og.png).
//
// Regen-time only: the PNG is COMMITTED, so nothing at build/deploy time depends
// on this script or its deps. playwright + chromium and sharp are TRANSITIVE deps
// (via @iwsdk/vite-plugin-dev / @iwsdk/reference) — if a future IWSDK upgrade
// drops them, recover with `npx playwright install chromium` (or fall back to a
// python3+PIL render; lowest fidelity, needs the brand TTFs).
//
// Typography is baked at gen time from the SELF-HOSTED slices in public/fonts/
// (the favicon house pattern: commit pixels, never let a share scraper depend on
// a webfont). document.fonts.check asserts fail loudly if a face didn't load.
//
// Usage:
//   node scripts/gen-og-card.mjs          # regenerate public/og.png + verify
//   node scripts/gen-og-card.mjs --check  # verify the committed PNG dims only

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, "public", "og.png");
const W = 1200;
const H = 630;
const MAX_BYTES = 300 * 1024; // warn threshold; X/Twitter hard limit is 5 MB

// data: URIs — a setContent page has no file: access, and the card must never
// fetch a network font (an offline run would silently bake a fallback face).
const fontUrl = (file) =>
  `data:font/woff2;base64,${readFileSync(path.join(root, "public", "fonts", file)).toString("base64")}`;

// Brand truth: src/theme.ts BRAND / index.html CSS vars + .wordmark / #hero h2.
// ASCII-only copy (house law): hyphen separators, no middle dots.
const TEMPLATE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: "Inter"; font-style: normal; font-weight: 400 600;
    src: url(${fontUrl("inter-v20-latin-wght.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Playfair Display"; font-style: italic; font-weight: 600 700;
    src: url(${fontUrl("playfair-display-v40-latin-italic-wght.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Space Grotesk"; font-style: normal; font-weight: 400 600;
    src: url(${fontUrl("space-grotesk-v22-latin-wght.woff2")}) format("woff2");
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden; position: relative;
    background: radial-gradient(ellipse 120% 90% at 50% 42%, #0a0c10 0%, #05070a 100%);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  /* Converging runway-perspective lines — the floor motif, low-opacity accent. */
  svg.runway { position: absolute; inset: 0; }
  .card { position: relative; text-align: center; }
  .wordmark {
    font-family: "Space Grotesk"; font-weight: 600; font-size: 96px;
    letter-spacing: 0.18em; color: #f2f5f8; white-space: nowrap;
    /* optical centering: tracking pads the right edge only */
    padding-left: 0.18em;
  }
  .wordmark .x { color: #4b9cd3; text-shadow: 0 0 24px rgba(75, 156, 211, 0.35); }
  .tagline {
    font-family: "Playfair Display"; font-style: italic; font-weight: 600;
    font-size: 44px; color: #f2f5f8; margin-top: 26px;
  }
  .micro {
    font-family: "Space Grotesk"; font-weight: 500; font-size: 17px;
    letter-spacing: 0.26em; color: #8a8f96; margin-top: 42px;
    white-space: nowrap; padding-left: 0.26em;
  }
</style></head><body>
  <svg class="runway" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <g stroke="#4b9cd3" stroke-opacity="0.22" stroke-width="2" fill="none">
      <line x1="480" y1="700" x2="583" y2="330" />
      <line x1="720" y1="700" x2="617" y2="330" />
      <line x1="330" y1="700" x2="560" y2="330" />
      <line x1="870" y1="700" x2="640" y2="330" />
    </g>
    <g stroke="#4b9cd3" stroke-opacity="0.10" stroke-width="1.5" fill="none">
      <line x1="140" y1="700" x2="530" y2="330" />
      <line x1="1060" y1="700" x2="670" y2="330" />
    </g>
  </svg>
  <div class="card">
    <div class="wordmark"><span class="x">(X)</span>RUNWAY</div>
    <div class="tagline">Take the next step.</div>
    <div class="micro">AR RUNWAY TRAINING - META QUEST 3</div>
  </div>
</body></html>`;

async function verify(pngPath) {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(pngPath).metadata();
  if (meta.width !== W || meta.height !== H || meta.format !== "png") {
    console.error(
      `[og] FAIL: ${pngPath} is ${meta.width}x${meta.height} ${meta.format}, expected ${W}x${H} png`,
    );
    process.exit(1);
  }
  const { size } = await import("node:fs").then((fs) =>
    fs.promises.stat(pngPath),
  );
  if (size > MAX_BYTES) {
    console.warn(`[og] warn: ${Math.round(size / 1024)} KB > ${MAX_BYTES / 1024} KB target (hard limit 5 MB)`);
  }
  console.log(`[og] ok: ${pngPath} ${meta.width}x${meta.height} png, ${Math.round(size / 1024)} KB`);
}

if (process.argv.includes("--check")) {
  await verify(OUT);
  process.exit(0);
}

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  await page.setContent(TEMPLATE, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  // Fail loudly if a face silently fell back to a system font.
  const checks = await page.evaluate(() => ({
    sg: document.fonts.check('600 16px "Space Grotesk"'),
    pf: document.fonts.check('italic 600 16px "Playfair Display"'),
  }));
  for (const [face, ok] of Object.entries(checks)) {
    if (!ok) {
      console.error(`[og] FAIL: font "${face}" did not load — the card would bake a fallback face.`);
      process.exit(1);
    }
  }
  await page.screenshot({ path: OUT, type: "png" });
} finally {
  await browser.close();
}
await verify(OUT);
