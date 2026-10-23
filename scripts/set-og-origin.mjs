// set-og-origin.mjs — inject the absolute og:image/og:url block into a BUILT
// index.html once a deploy origin is known.
//
// Why deploy-time: the majors (FB / X / LinkedIn / WhatsApp) require an
// ABSOLUTE https og:image URL, and this project travels over ephemeral hosts
// (cloudflared tunnels, unclaimed Netlify Drops) — committing an absolute URL
// would ship wrong-origin links. The committed index.html stays image-less;
// this rewrites dist/ only. The asset itself is committed at public/og.png
// (regen: node scripts/gen-og-card.mjs).
//
// Usage (after `npx vite build`, before uploading dist/):
//   node scripts/set-og-origin.mjs https://<site>.netlify.app [dist/index.html]
//
// Idempotent: re-running with a new origin replaces the previous injection in
// place. Also flips twitter:card summary -> summary_large_image (and only
// then — a large_image card with no image degrades the text-only card).
// Netlify Drop chicken-and-egg: a fresh Drop reveals its URL only after
// upload — claim a stable site name once, then inject before dropping.

import { readFileSync, writeFileSync } from "node:fs";

const [origin, target = "dist/index.html"] = process.argv.slice(2);
if (!origin || !/^https:\/\/[^/\s]+$/.test(origin.replace(/\/$/, ""))) {
  console.error(
    "usage: node scripts/set-og-origin.mjs https://<deploy-origin> [dist/index.html]",
  );
  process.exit(1);
}
const base = origin.replace(/\/$/, "");

let html = readFileSync(target, "utf8");

const START = "<!-- og:origin-injected -->";
const END = "<!-- /og:origin-injected -->";
const ALT = "(X)RUNWAY - Take the next step. AR runway training.";
const block = [
  START,
  `<meta property="og:url" content="${base}/" />`,
  `<meta property="og:image" content="${base}/og.png" />`,
  // width/height up front: without them the FIRST share can render blank
  // while Facebook's scraper measures the image.
  `<meta property="og:image:width" content="1200" />`,
  `<meta property="og:image:height" content="630" />`,
  `<meta property="og:image:alt" content="${ALT}" />`,
  `<meta name="twitter:image" content="${base}/og.png" />`,
  END,
].join("\n    ");

if (html.includes(START)) {
  // Replace the previous injection in place (origin change / re-deploy).
  html = html.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`),
    block,
  );
} else {
  const anchor = '<meta property="og:site_name" content="(X)RUNWAY" />';
  if (!html.includes(anchor)) {
    console.error(`[og] FAIL: anchor not found in ${target}: ${anchor}`);
    process.exit(1);
  }
  html = html.replace(anchor, `${anchor}\n    ${block}`);
}

// Flip the card type ONLY alongside an injected image.
html = html.replace(
  '<meta name="twitter:card" content="summary" />',
  '<meta name="twitter:card" content="summary_large_image" />',
);

writeFileSync(target, html);
console.log(`[og] injected ${base}/og.png into ${target} (twitter:card=summary_large_image)`);
console.log(`[og] post-deploy sanity: curl -sA "facebookexternalhit/1.1" ${base}/og.png -o /dev/null -w '%{http_code}\\n'`);
