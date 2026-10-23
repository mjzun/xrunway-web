/**
 * (X)RUNWAY — web-engine skins for the in-headset lesson panel.
 *
 * "Adapt the web rendering engine to the headset panel" (founder ask
 * 2026-07-10): the panel's uikit renderer has no gradients, no blur and an
 * unlit material, so the web landing's glass washes are BAKED by headless
 * Chromium (scripts/gen-panel-skins.mjs renders the SAME CSS material
 * language to alpha PNGs) and mounted here as absolutely-positioned
 * UIKit.Image children BEHIND each surface's content.
 *
 * Adjudicated by deep research (2026-07-10, 104-agent verified): live DOM
 * can never be world-anchored in WebXR — DOM Overlay is UA-positioned by
 * spec (world anchoring an explicit non-goal; Meta confirmed it unworkable
 * on Quest and points to uikit), and WebXR quad/cylinder layers are
 * texture-only. Rasterized-CSS textures on the in-scene panel is the one
 * viable architecture; probe-verified locally (an Image composites under
 * MSDF text inside the instanced panel, z-ordered by zIndexOffset).
 *
 * Contracts: every skin is an ALPHA WASH over the authored backgroundColor,
 * so all dynamic color writes (medal tiers, verdict recolors, chip stamps,
 * :hover fills) show through; pointer-events none so ray input never lands
 * on a skin; mounted ONCE at document load (no per-frame work, no
 * allocation after init). A failed texture load degrades to the exact
 * pre-skin panel.
 */

import { UIKit, type UIKitDocument } from "@iwsdk/core";

/** Mount targets: element id -> skin asset + the target's own corner
 * radius (the wash must clip to the surface it dresses). */
const SKIN_MOUNTS: ReadonlyArray<{
  id: string;
  src: string;
  borderRadius: number;
}> = [
  // The whole panel sheet: Carolina bloom + top light + edge vignette.
  { id: "hud-root", src: "/skins/panel-root.png", borderRadius: 2.8 },
  // Card surfaces.
  { id: "instruction-box", src: "/skins/card.png", borderRadius: 1.6 },
  { id: "score-card", src: "/skins/card.png", borderRadius: 1.6 },
  // Primary pills: the lit-convex top light (authored fill + hover show
  // through the alpha).
  { id: "begin-button", src: "/skins/pill-accent.png", borderRadius: 2.2 },
  { id: "again-button", src: "/skins/pill-accent.png", borderRadius: 2.2 },
  { id: "map-confirm", src: "/skins/pill-accent.png", borderRadius: 2.2 },
  { id: "set-fit", src: "/skins/pill-accent.png", borderRadius: 2.2 },
];

/**
 * Mount every skin into the loaded panel document. Call once per document
 * load; missing targets warn and skip (the panel keeps its authored look).
 */
export function mountPanelSkins(doc: UIKitDocument): void {
  for (const mount of SKIN_MOUNTS) {
    const target = doc.getElementById(mount.id) as UIKit.Container | null;
    if (!target) {
      console.warn(`[panel-skins] missing mount target #${mount.id}`);
      continue;
    }
    const skin = new UIKit.Image({
      src: mount.src,
      positionType: "absolute",
      positionTop: 0,
      positionLeft: 0,
      positionRight: 0,
      positionBottom: 0,
      borderRadius: mount.borderRadius,
      // Behind the target's children (probe-verified ordering)...
      zIndexOffset: -1,
      // ...and invisible to the ray so buttons keep their hit-testing.
      pointerEvents: "none",
      // Washes stretch with the surface; gradients scale gracefully.
      objectFit: "fill",
    });
    target.add(skin);
  }
}
