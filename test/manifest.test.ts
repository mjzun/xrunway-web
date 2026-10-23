import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE PWA MANIFEST LOCK (marketplace pack 2026-07-15): the Quest browser only
// offers a real app-tile install when index.html links a valid webmanifest
// whose icons actually exist. Pins: the <link>, JSON validity, the identity
// fields, and that every icon path resolves to a committed file in public/.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const exists = (rel: string): boolean =>
  existsSync(fileURLToPath(new URL(rel, import.meta.url)));

describe("PWA manifest (public/manifest.webmanifest)", () => {
  const html = read("../index.html");
  const manifest = JSON.parse(read("../public/manifest.webmanifest")) as {
    name: string;
    short_name: string;
    display: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string }>;
  };

  it("index.html links the manifest", () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
  });

  it("carries the brand identity", () => {
    expect(manifest.name).toBe("(X)RUNWAY");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#0a0c10");
  });

  it("every icon path resolves to a committed file", () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true);
      expect(exists(`../public${icon.src}`), icon.src).toBe(true);
    }
    // The install sizes the Quest browser wants.
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
});
