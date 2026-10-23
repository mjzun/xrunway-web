// gen-panel-skins.mjs — bake the WEB ENGINE's rendering of the panel surfaces
// into textures the in-headset uikit panel mounts as card backgrounds.
//
// This is the "adapt the web rendering engine to the headset panel" seam
// (founder ask 2026-07-10): headless Chromium renders the SAME CSS material
// language as the web landing (radial Carolina tint wash, directional
// gradient, edge vignette) into PNGs; at runtime hud.ts mounts each as an
// absolutely-positioned UIKit.Image BEHIND a card's children (probe-verified:
// images composite under MSDF text inside the instanced panel). Division of
// labor: gradients/washes = web-baked pixels; borders/rims + text = uikit
// (resolution-independent). Shadows stay out of skins - they cannot escape
// the texture rect.
//
// Regen-time only (PNGs are committed; playwright is a transitive dep - if
// missing: npx playwright install chromium). Usage:
//   node scripts/gen-panel-skins.mjs          # regenerate public/skins/*
//   node scripts/gen-panel-skins.mjs --check  # verify committed dims only

import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(root, "public", "skins");

// Brand truth: src/theme.ts BRAND_CSS / ui/lesson.uikitml chrome neutrals.
// Every skin is an ALPHA OVERLAY WASH (transparent PNG): strictly additive
// over the authored uikit backgroundColor, so every dynamic color contract
// (medal tiers, verdict recolors, chip stamps, :hover fills) stays visible
// beneath. A failed texture load degrades to exactly the pre-skin panel.
const SKINS = [
  {
    // The whole panel sheet: Carolina wash blooming from the top (the web
    // .glass radial tint), a directional top light, and an edge vignette -
    // all ALPHA layers over the authored #0a0c10 (which stays beneath and
    // is the load-failure fallback).
    name: "panel-root",
    width: 1024,
    height: 1344, // ~ the tallest (settings) state's aspect; washes stretch gracefully
    css: `background:
      radial-gradient(120% 42% at 50% 0%, rgba(75, 156, 211, 0.12), transparent 60%),
      linear-gradient(168deg, rgba(242, 245, 248, 0.05), rgba(242, 245, 248, 0) 34%),
      radial-gradient(140% 120% at 50% 45%, rgba(5, 7, 10, 0) 55%, rgba(5, 7, 10, 0.55) 100%);`,
  },
  {
    // Card wash (instruction box / score card): faint tint bloom + top
    // light over the authored #10151b.
    name: "card",
    width: 768,
    height: 320,
    css: `background:
      radial-gradient(130% 90% at 50% 0%, rgba(75, 156, 211, 0.08), transparent 55%),
      linear-gradient(165deg, rgba(242, 245, 248, 0.07), rgba(242, 245, 248, 0) 45%);`,
  },
  {
    // Primary pill wash: the web .btn-primary lit-convex top light. Alpha
    // only - the authored accent fill AND its :hover recolor show through.
    name: "pill-accent",
    width: 512,
    height: 128,
    css: `background:
      linear-gradient(178deg, rgba(242, 245, 248, 0.28), rgba(242, 245, 248, 0) 46%);`,
  },
];

async function verify() {
  const sharp = (await import("sharp")).default;
  for (const s of SKINS) {
    const p = path.join(OUT_DIR, `${s.name}.png`);
    const meta = await sharp(p).metadata();
    if (meta.width !== s.width || meta.height !== s.height || meta.format !== "png") {
      console.error(`[skins] FAIL: ${p} is ${meta.width}x${meta.height} ${meta.format}, expected ${s.width}x${s.height} png`);
      process.exit(1);
    }
    console.log(`[skins] ok: ${s.name}.png ${meta.width}x${meta.height}`);
  }
}

if (process.argv.includes("--check")) {
  await verify();
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  for (const s of SKINS) {
    const page = await browser.newPage({
      viewport: { width: s.width, height: s.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        * { margin: 0; padding: 0; }
        body { width: ${s.width}px; height: ${s.height}px; overflow: hidden; background: transparent; }\n        #wash { position: absolute; inset: 0; ${s.css} }
      </style></head><body><div id="wash"></div></body></html>`,
      { waitUntil: "load" },
    );
    await page.screenshot({ path: path.join(OUT_DIR, `${s.name}.png`), type: "png", omitBackground: true });
    await page.close();
    console.log(`[skins] rendered ${s.name}.png`);
  }
} finally {
  await browser.close();
}
await verify();
