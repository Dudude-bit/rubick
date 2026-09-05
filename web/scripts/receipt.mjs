// Runs after vite build: writes the measured sizes into every prerendered page.
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
// Only fetched resources count; a link a person clicks is not a request the
// page makes. Everything the client fetches at runtime is listed by hand.
const RUNTIME_HOSTS = ["api.github.com"];
const loaded = new Set();
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const tag of html.matchAll(
    /<(script|link|img|iframe|source)\b[^>]*>/g
  )) {
    if (/rel=["'](?:canonical|alternate|me)["']/.test(tag[0])) continue;
    for (const m of tag[0].matchAll(/(?:src|href|srcset)=["']([^"']+)["']/g)) {
      for (const candidate of m[1].split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!/^(?:https?:)?\/\//.test(url)) continue;
        const host = new URL(url, "https://rubick.tech").host;
        if (!OWN_HOSTS.has(host)) loaded.add(host);
      }
    }
  }
}

const receipt = `The whole site ships ${js} KB of JavaScript and ${css} KB of CSS, gzip, plus ${fonts} KB of woff2 fonts, measured at build. ${loaded.size === 0 ? "No third-party resource is loaded" : `Third-party resources from ${[...loaded].join(", ")}`}; the one request that leaves the page goes to ${RUNTIME_HOSTS.join(", ")}, for the release number under Install. No cookies are set.`;

const marker = /(<span data-receipt[^>]*>)[^<]*(<\/span>)/g;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const markers = html.match(marker)?.length ?? 0;
  if (markers !== 1) {
    console.error(`${page}: expected one receipt marker, found ${markers}`);
    process.exit(1);
  }
  writeFileSync(page, html.replace(marker, `$1${receipt}$2`));
}
console.log(receipt);
console.log(`written into ${pages.length} pages`);
if (loaded.size > 0) {
  console.error("third-party resources found:", [...loaded].join(", "));
  process.exit(1);
}
