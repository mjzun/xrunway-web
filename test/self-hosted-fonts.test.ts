import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Self-hosted fonts drift lock (2026-07-10): the landing + companion pages
// serve their typefaces from same-origin /fonts/ slices (deterministic on
// isolated networks; no Google host sees an IP). This pins the swap so a
// future template refresh can't quietly re-introduce the Google Fonts
// preconnect/stylesheet, and so the committed woff2 payloads + the OFL
// notice (a license requirement for redistribution) can't be dropped while
// the @font-face blocks still reference them. methodology.html is exempt:
// it is deliberately system-stack only.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const PAGES: Array<[string, string, string[]]> = [
  [
    "index.html",
    "../index.html",
    [
      "/fonts/inter-v20-latin-wght.woff2",
      "/fonts/playfair-display-v40-latin-italic-wght.woff2",
      "/fonts/space-grotesk-v22-latin-wght.woff2",
    ],
  ],
  [
    "public/companion/index.html",
    "../public/companion/index.html",
    [
      "/fonts/inter-v20-latin-wght.woff2",
      "/fonts/space-grotesk-v22-latin-wght.woff2",
    ],
  ],
];

describe("self-hosted fonts", () => {
  for (const [label, rel, files] of PAGES) {
    describe(label, () => {
      const src = read(rel);

      it("makes no Google Fonts connection (no stylesheet, no preconnect)", () => {
        expect(src).not.toContain("fonts.googleapis");
        expect(src).not.toContain("fonts.gstatic");
        expect(src).not.toContain("preconnect");
      });

      it("declares an @font-face for every family it uses", () => {
        for (const file of files) {
          expect(src).toContain(`src: url(${file}) format("woff2")`);
        }
      });

      it("preloads each font file with the mandatory crossorigin attribute", () => {
        for (const file of files) {
          const preload = src
            .split("\n")
            .find((line) => line.includes("preload") && line.includes(file));
          expect(preload, `preload for ${file}`).toBeDefined();
          expect(preload).toContain("crossorigin");
          expect(preload).toContain('as="font"');
        }
      });
    });
  }

  it("the committed woff2 payloads and the OFL notice exist under public/fonts/", () => {
    for (const file of [
      "inter-v20-latin-wght.woff2",
      "playfair-display-v40-latin-italic-wght.woff2",
      "space-grotesk-v22-latin-wght.woff2",
      "OFL-LICENSES.txt",
    ]) {
      const path = fileURLToPath(new URL(`../public/fonts/${file}`, import.meta.url));
      expect(existsSync(path), `public/fonts/${file}`).toBe(true);
    }
    // woff2 magic bytes ("wOF2") — a corrupted/LFS-pointer commit fails here.
    for (const file of [
      "inter-v20-latin-wght.woff2",
      "playfair-display-v40-latin-italic-wght.woff2",
      "space-grotesk-v22-latin-wght.woff2",
    ]) {
      const path = fileURLToPath(new URL(`../public/fonts/${file}`, import.meta.url));
      const head = readFileSync(path).subarray(0, 4).toString("latin1");
      expect(head, `${file} magic`).toBe("wOF2");
    }
  });
});
