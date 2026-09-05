// Renders the Open Graph cards into public/og.png and public/og/<lie>.png.
// Needs a Chromium binary; run from web/: `node scripts/og.mjs`.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const ROOT = resolve(import.meta.dirname, "..");
const FONT_DISPLAY = `${ROOT}/node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2`;
const FONT_MONO = `${ROOT}/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2`;

const CARDS = [
  {
    file: "og.png",
    eyebrow: "A desktop Kubernetes client",
    title: "Your cluster is lying to you.",
    reported: "Running",
    observed: "CrashLoopBackOff",
  },
  {
    file: "og/running.png",
    eyebrow: "Lie #1 of 3",
    title: "“Running”, says the pod.",
    reported: "Running",
    observed: "CrashLoopBackOff",
  },
  {
    file: "og/all-green.png",
    eyebrow: "Lie #2 of 3",
    title: "“All green”, says the Service.",
    reported: "3 endpoints",
    observed: "no port published",
  },
  {
    file: "og/delivery.png",
    eyebrow: "Delivered by",
    title: "Argo CD and Flux, and whether your edit survives.",
    reported: "Ready",
    observed: "suspended, frozen at dd50717",
  },
  {
    file: "og/certificates.png",
    eyebrow: "cert-manager",
    title: "Valid. For somebody else.",
    reported: "Ready, 89 days left",
    observed: "not covering api.shop.k8s-gui.test",
  },
  {
    file: "og/no-route.png",
    eyebrow: "Lie #3 of 3",
    title: "“No route to host”, says nobody at all.",
    reported: "Ingress accepted",
    observed: "Service api-v2 not found",
  },
];

const html = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:D;src:url(file://${FONT_DISPLAY}) format("woff2")}
@font-face{font-family:M;src:url(file://${FONT_MONO}) format("woff2")}
html,body{margin:0;width:1200px;height:630px;background:#09090b;color:#fafafa;font-family:D,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.grid{position:absolute;inset:0;background-image:linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(70% 70% at 40% 40%,#000 30%,transparent 100%)}
.card{position:relative;padding:64px 72px;height:630px;box-sizing:border-box;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:28px;letter-spacing:-.01em}
.eyebrow{margin-top:56px;font-family:M,monospace;font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:#3b82f6}
h1{margin:20px 0 0;font-size:${c.title.length > 30 ? 66 : 76}px;line-height:1.05;letter-spacing:-.03em;font-weight:700;max-width:1000px}
.row{margin-top:auto;display:flex;align-items:center;gap:22px;font-family:M,monospace;font-size:26px}
.chip{display:inline-flex;align-items:center;gap:12px;padding:12px 22px;border-radius:999px;border:2px solid #52525b;background:#111114}
.chip .dot{width:12px;height:12px;border-radius:50%;background:#4ade80}
.chip.said{color:#71717a;text-decoration:line-through;text-decoration-color:#f87171;text-decoration-thickness:3px}
.chip.seen{border-color:rgba(248,113,113,.7);color:#fca5a5}.chip.seen .dot{background:#f87171}
.conn{width:64px;height:3px;background:#3b82f6;position:relative}.conn::after{content:"";position:absolute;right:-2px;top:-6px;border:7px solid transparent;border-left:10px solid #3b82f6}
.foot{margin-left:auto;font-family:M,monospace;font-size:20px;color:#8e8e99;font-weight:400}
</style></head><body><div class="grid"></div><div class="card">
<div class="brand"><svg width="36" height="36" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.25" fill="#12151a"/>${[0, 1, 2].flatMap((r) => [0, 1, 2].map((col) => `<rect x="${3.5 + col * 6}" y="${3.5 + r * 6}" width="4.9" height="4.9" rx=".85" fill="${col === 1 && r === 1 ? "#e0554f" : "#3f9e6a"}"/>`)).join("")}</svg>Rubick<span class="foot">rubick.tech · free · GPLv3 · no telemetry</span></div>
<div class="eyebrow">${c.eyebrow}</div>
<h1>${c.title}</h1>
<div class="row"><span class="chip said"><span class="dot"></span>${c.reported}</span><span class="conn"></span><span class="chip seen"><span class="dot"></span>${c.observed}</span></div>
</div></body></html>`;

const chrome = spawn(CHROMIUM, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--remote-debugging-port=0",
  "about:blank",
]);
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) res(m[0]);
  });
  chrome.on("exit", () => rej(new Error("chromium exited")));
});
const port = new URL(wsUrl).port;
const page = (
  await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error) p.rej(new Error(JSON.stringify(d.error)));
  else p.res(d.result);
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
  mobile: false,
});
mkdirSync(`${ROOT}/public/og`, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "rubick-og-"));
for (const c of CARDS) {
  const tmp = join(scratch, `${c.file.replace(/[/.]/g, "-")}.html`);
  writeFileSync(tmp, html(c));
  await send("Page.navigate", { url: `file://${tmp}` });
  await new Promise((r) => setTimeout(r, 700));
  await send("Runtime.evaluate", {
    expression: "document.fonts.ready",
    awaitPromise: true,
  });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${ROOT}/public/${c.file}`, Buffer.from(shot.data, "base64"));
  console.log("wrote", c.file);
}
ws.close();
chrome.kill();
rmSync(scratch, { recursive: true, force: true });
