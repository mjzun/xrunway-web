/**
 * Brand palette single-source lock (POLISH-AUDIT #34).
 *
 * theme.ts declares itself the single source of truth for brand color.
 * These tests enforce it two ways:
 *  1. BRAND and BRAND_CSS are exact twins (hex-for-hex).
 *  2. The 3D layer (shaders.ts, stage.ts) contains NO hand-mirrored brand
 *     literals — GLSL vec3s must be generated via glslVec3(BRAND.*) and
 *     canvas colors must come from BRAND_CSS. A drift back to literals
 *     fails this suite, not a code review.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BRAND, BRAND_CSS, glslVec3, hexToRgb01 } from "../src/theme.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

const hex6 = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

describe("BRAND / BRAND_CSS twins", () => {
  it("every BRAND entry has an identical BRAND_CSS twin", () => {
    const brandKeys = Object.keys(BRAND).sort();
    const cssKeys = Object.keys(BRAND_CSS).sort();
    expect(cssKeys).toEqual(brandKeys);
    for (const k of brandKeys) {
      expect(BRAND_CSS[k as keyof typeof BRAND_CSS]).toBe(
        hex6(BRAND[k as keyof typeof BRAND]),
      );
    }
  });
});

describe("glslVec3 / hexToRgb01", () => {
  it("matches the historical hand-tuned literals exactly", () => {
    expect(glslVec3(BRAND.accent)).toBe("vec3(0.2941, 0.6118, 0.8275)");
    expect(glslVec3(BRAND.bg)).toBe("vec3(0.0392, 0.0471, 0.0627)");
    expect(glslVec3(BRAND.navy)).toBe("vec3(0.0235, 0.0588, 0.1059)");
    expect(glslVec3(BRAND.white)).toBe("vec3(0.9490, 0.9608, 0.9725)");
  });

  it("warm white stays within rounding distance of the legacy crossing core", () => {
    // Legacy inline literal was vec3(1.0, 0.97, 0.90); #fff7e6 quantizes to:
    const [r, g, b] = hexToRgb01(BRAND.warmWhite);
    expect(r).toBe(1);
    expect(Math.abs(g - 0.97)).toBeLessThan(0.002);
    expect(Math.abs(b - 0.9)).toBeLessThan(0.003);
  });
});

describe("no hand-mirrored brand literals in the 3D layer", () => {
  const brandHexes = Object.values(BRAND_CSS).map((h) => h.slice(1));
  const hexPattern = new RegExp(`#(${brandHexes.join("|")})\\b`, "i");
  // Crumbs of the old hand-written vec3s (accent/bg/navy channel prefixes).
  const vec3Crumbs = /vec3\(0\.29(4|41)|vec3\(0\.039|vec3\(0\.023|vec3\(1\.0, 0\.97/;

  for (const file of ["shaders.ts", "stage.ts"]) {
    it(`${file} has no raw brand hex or hand-written brand vec3`, () => {
      const src = read(file);
      expect(src).not.toMatch(hexPattern);
      expect(src).not.toMatch(vec3Crumbs);
    });
  }
});
