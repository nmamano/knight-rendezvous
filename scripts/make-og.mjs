// One-shot generator for the static social card frontend/public/og.png (C6).
// NO external fetch: it renders a self-contained inline SVG to a 1200x630 PNG via
// the already-installed headless system Chrome (Playwright). Re-runnable, but the
// committed og.png is the artifact the build serves — this script is just how it
// was produced. Run: `bun scripts/make-og.mjs`.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../frontend/public/og.png");

// A cozy two-knights card in the Knight Rendezvous palette (lavender field,
// amber + violet knights meeting). Two boards' worth of grass tiles flank the
// title; the two knights face each other on a shared square.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="50%" cy="-10%" r="120%">
      <stop offset="0%" stop-color="#efeaff"/>
      <stop offset="60%" stop-color="#f2f0fa"/>
      <stop offset="100%" stop-color="#e7e2fb"/>
    </radialGradient>
    <linearGradient id="board" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a6dd7d"/>
      <stop offset="100%" stop-color="#8bc763"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- meeting board: a small 3x3 grass grid centered, two knights sharing the middle -->
  <g transform="translate(470,210)">
    <rect x="-12" y="-12" width="264" height="264" rx="20" fill="#4d7c3c"/>
    <rect x="0" y="0" width="240" height="240" rx="12" fill="url(#board)"/>
    <g fill="rgba(0,0,0,0.08)">
      <rect x="80" y="0" width="80" height="80"/>
      <rect x="0" y="80" width="80" height="80"/>
      <rect x="160" y="80" width="80" height="80"/>
      <rect x="80" y="160" width="80" height="80"/>
    </g>
    <!-- shared center square highlighted -->
    <rect x="80" y="80" width="80" height="80" fill="#e8c892" opacity="0.85"/>
    <!-- two knights converging on the center -->
    <text x="108" y="148" font-size="86" text-anchor="middle"
      fill="#f6a609" stroke="#5a3b00" stroke-width="3" paint-order="stroke"
      font-family="Georgia, 'Times New Roman', serif">♞</text>
    <text x="150" y="138" font-size="74" text-anchor="middle"
      fill="#8b5cf6" stroke="#2e1065" stroke-width="3" paint-order="stroke"
      font-family="Georgia, 'Times New Roman', serif">♞</text>
  </g>

  <text x="600" y="115" font-size="74" font-weight="800" text-anchor="middle"
    fill="#3a3357" font-family="Verdana, 'Segoe UI', system-ui, sans-serif">Knight
    <tspan fill="#6c5cff">Rendezvous</tspan>
  </text>
  <text x="600" y="540" font-size="34" text-anchor="middle"
    fill="#6b6580" font-family="Verdana, 'Segoe UI', system-ui, sans-serif">
    Two knights, one board — meet on the same square.
  </text>
</svg>`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, {
    waitUntil: "networkidle",
  });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log("wrote", out);
} finally {
  await browser.close();
}
