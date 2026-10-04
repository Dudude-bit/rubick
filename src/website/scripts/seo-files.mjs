// Runs with bun after vite build (bun reads the TypeScript data modules):
// writes llms.txt, llms-full.txt and sitemap.xml from the prerendered pages
// and the data they render, and fails when a page is missing from them.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { COMPETITORS, LAST_VERIFIED } from "../src/lib/compare.ts";
import { LIES, lieNumber } from "../src/lib/lies.tsx";
import { CERTIFICATES, DELIVERY, pageUrl } from "../src/lib/pages.ts";
import { LINKS, SITE } from "../src/lib/site.ts";

const CLIENT = join(resolve(import.meta.dirname, ".."), "dist", "client");

const lieUrl = (slug) => `${SITE.url}/lies/${slug}`;
const vsUrl = (slug) => `${SITE.url}/vs/${slug}`;

const summary = `> Rubick is a free, open-source desktop Kubernetes client for macOS, Windows and Linux that reports what a cluster actually does rather than what one field claims. It derives pod status the way kubectl does instead of trusting .status.phase, reads the endpoints a Service really publishes, and traces Ingress and Gateway API traffic to the pod, naming the exact link that broke. GPL-3.0-or-later, no account, no telemetry, built with Tauri and Rust.

Rubick here is the Kubernetes client published at rubick.tech, not the Dota 2 hero of the same name.

Key facts:

- Reads your kubeconfig, like Lens, k9s or Headlamp, and needs Kubernetes 1.21 or later.
- When the cluster refuses a read, Rubick says it could not check, instead of drawing an empty list that reads as "there are none".
- Before it applies a change, it warns who will undo it: an HPA, Argo CD or Flux.
- Integrates with Traefik, ingress-nginx, Istio, cert-manager, Argo CD, Flux, Prometheus, Loki, Cilium, CloudNativePG, ScyllaDB, Karpenter, GKE, EKS and AKS.
- Install with \`${LINKS.brew}\`, from the AUR package rubick-kubernetes-bin, or as a dmg, exe, deb, rpm, AppImage or Flatpak bundle from the latest release.`;

const lies = LIES.map(
  (l) =>
    `- [Lie ${lieNumber(l)}: ${l.lie}](${lieUrl(l.slug)}): ${l.description}`
);
const pages = [DELIVERY, CERTIFICATES].map(
  (p) => `- [${p.title}](${pageUrl(p)}): ${p.description}`
);
const comparisons = COMPETITORS.map(
  (c) =>
    `- [Rubick vs ${c.name}, honestly](${vsUrl(c.slug)}): ${c.metaDescription}`
);

const llms = `# ${SITE.name}

${summary}

## What dashboards get wrong, and what Rubick shows instead

${lies.join("\n")}
- [Reproduce the first three](${LINKS.lies}): a manifest for any throwaway cluster; the fourth needs Cilium and has its own steps on its page

## Pages

- [Home](${SITE.url}/): what Rubick shows that dashboards miss, and downloads for every platform
${pages.join("\n")}

## Comparisons

${comparisons.join("\n")}

## Source and downloads

- [GitHub repository](${LINKS.github}): GPL-3.0-or-later source code
- [Releases](${LINKS.releases}): dmg, exe, deb, rpm, AppImage and Flatpak downloads
- [Contributing](${LINKS.contributing}): adding an integration costs a folder and a line

## Listed independently

- [Kubetools by Collabnix](${LINKS.kubetools}): a curated list of Kubernetes tools, where Rubick is listed as a free and open-source desktop client that is honest about refused reads

## Optional

- [Full text of every page](${SITE.url}/llms-full.txt): each lie, each comparison table, in plain text
- [Security policy](${LINKS.security}): how to report a vulnerability
- [License](${LINKS.license}): GPL-3.0-or-later
`;

const lieText = LIES.map((l) => {
  const reproduce = l.reproduce
    ? `${l.reproduce.blurb}\n\n${l.reproduce.commands.map((c) => `    ${c}`).join("\n")}\n\n${l.reproduce.note}`
    : `Reproduce it with ${LINKS.lies} on any throwaway cluster.`;
  return `## Lie ${lieNumber(l)}: ${l.lie}

${lieUrl(l.slug)}

What a dashboard reports: ${l.reported}. What is true: ${l.observed}.

${l.bust}

${reproduce}`;
});

const comparisonText = COMPETITORS.map(
  (c) => `## Rubick vs ${c.name}, honestly

${vsUrl(c.slug)} (last verified ${LAST_VERIFIED})

${c.verdict}

Pick ${c.name} if:
${c.pickThem.map((x) => `- ${x}`).join("\n")}

Pick Rubick if:
${c.pickRubick.map((x) => `- ${x}`).join("\n")}

| | Rubick | ${c.name} |
|---|---|---|
${c.rows.map((r) => `| ${r.label} | ${r.rubick} | ${r.them} |`).join("\n")}

${c.honestNote}`
);

const pageText = [DELIVERY, CERTIFICATES].map(
  (p) => `## ${p.title}\n\n${pageUrl(p)}\n\n${p.description}`
);

const full = `# ${SITE.name}

${summary}

${[...lieText, ...comparisonText, ...pageText].join("\n\n")}
`;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const prerendered = walk(CLIENT)
  .filter((f) => f.endsWith(".html"))
  .map((f) =>
    `/${relative(CLIENT, f)}`
      .replace(/index\.html$/, "")
      .replace(/\.html$/, "")
      .replace(/(.)\/$/, "$1")
  )
  .filter((path) => path !== "/404")
  .sort();
const missing = prerendered.filter(
  (path) => !llms.includes(`${SITE.url}${path}`)
);
if (missing.length > 0) {
  console.error(`llms.txt names no link to: ${missing.join(", ")}`);
  process.exit(1);
}

// No <lastmod>: the build date on every page would tell a crawler that
// everything changed every deploy, and it learns to ignore the field.
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${prerendered.map((path) => `  <url><loc>${SITE.url}${path}</loc></url>`).join("\n")}
</urlset>
`;

writeFileSync(join(CLIENT, "llms.txt"), llms);
writeFileSync(join(CLIENT, "llms-full.txt"), full);
writeFileSync(join(CLIENT, "sitemap.xml"), sitemap);
console.log(
  `llms.txt, llms-full.txt and sitemap.xml cover ${prerendered.length} pages`
);
