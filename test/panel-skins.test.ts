import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The web-engine skin pipeline (founder ask 2026-07-10: "adapt the web
// rendering engine to the headset panel"): headless Chromium bakes the web
// landing's CSS washes to alpha PNGs (scripts/gen-panel-skins.mjs), and
// hud.ts mounts them as absolutely-positioned UIKit.Image children behind
// the panel surfaces (src/panel-skins.ts). These pins hold the seams: the
// committed textures, the mount wiring, every mount target's markup id,
// and the two safety-critical Image props (pointer-events none so ray
// input never lands on a skin; zIndexOffset -1 so skins stay BEHIND text).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const readBytes = (rel: string): Buffer =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const SKIN_FILES = ["panel-root.png", "card.png", "pill-accent.png"];
const MOUNT_IDS = [
  "hud-root",
  "instruction-box",
  "score-card",
  "begin-button",
  "again-button",
  "map-confirm",
  "set-fit",
];

describe("panel skins (the web-engine material pipeline)", () => {
  it("the committed skin textures exist and are real PNGs", () => {
    for (const file of SKIN_FILES) {
      const bytes = readBytes(`../public/skins/${file}`);
      expect(bytes.subarray(1, 4).toString("latin1"), `${file} magic`).toBe("PNG");
    }
  });

  it("the generator exists with its --check mode (regen + CI path)", () => {
    const gen = read("../scripts/gen-panel-skins.mjs");
    expect(gen).toContain("--check");
    for (const file of SKIN_FILES) {
      expect(gen).toContain(file.replace(".png", ""));
    }
  });

  it("hud.ts mounts the skins once per document load", () => {
    const hud = read("../src/hud.ts");
    expect(hud).toContain("mountPanelSkins(doc);");
  });

  it("every mount target is wired in panel-skins.ts AND exists in the markup", () => {
    const skins = read("../src/panel-skins.ts");
    const uikitml = read("../ui/lesson.uikitml");
    for (const id of MOUNT_IDS) {
      expect(skins, `panel-skins mounts #${id}`).toContain(`id: "${id}"`);
      expect(uikitml, `markup carries #${id}`).toContain(`id="${id}"`);
    }
  });

  it("skins are ray-invisible and behind content (the safety props)", () => {
    const skins = read("../src/panel-skins.ts");
    expect(skins).toContain('pointerEvents: "none"');
    expect(skins).toContain("zIndexOffset: -1");
  });
});
