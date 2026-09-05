// Measures the built site and writes the numbers into every prerendered
// page's receipt line. Runs after `vite build`; see package.json.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT = join(ROOT, "dist", "client");
const OWN_HOSTS = new Set(["rubick.tech"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const gzipKb = (files) =>
  Math.round(
    files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0) / 1024
  );

const files = walk(CLIENT);
const js = gzipKb(files.filter((f) => f.endsWith(".js")));
const css = gzipKb(files.filter((f) => f.endsWith(".css")));
const fonts = Math.round(
  files
    .filter((f) => f.endsWith(".woff2"))
    .reduce((n, f) => n + statSync(f).size, 0) / 1024
);

const pages = files.filter((f) => f.endsWith(".html"));
// Links a person clicks are not requests the page makes; only fetched
// resources count. Anchors to GitHub and the AUR are expected here.
const loaded = new Set();
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const m of html.matchAll(
    /<(?:script|link|img|iframe)[^>]+(?:src|href)="(https?:\/\/[^/"]+)/g
  )) {
    const host = new URL(m[1]).host;
    if (!OWN_HOSTS.has(host)) loaded.add(host);
  }
}

const receipt = `The whole site ships ${js} KB of JavaScript, ${css} KB of CSS and ${fonts} KB of fonts, gzip, measured at build. ${loaded.size === 0 ? "No third-party requests." : `${loaded.size} third-party hosts: ${[...loaded].join(", ")}.`} No cookies.`;

let patched = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const next = html.replace(
    /(<span data-receipt[^>]*>)[^<]*(<\/span>)/,
    `$1${receipt}$2`
  );
  if (next !== html) {
    writeFileSync(page, next);
    patched++;
  }
}
console.log(receipt);
console.log(`patched ${patched} of ${pages.length} pages`);
if (loaded.size > 0) {
  console.error("third-party resources found:", [...loaded].join(", "));
  process.exit(1);
}
