export const SITE = {
  name: "Rubick",
  title: "Rubick, a desktop Kubernetes client that tries not to lie to you",
  description:
    "A crashlooping pod says Running. A dead Service draws green. Rubick reads what the cluster actually does and tells you that instead. Free, GPLv3, no account, no telemetry.",
  url: "https://rubick.tech",
};

const GH = "https://github.com/Dudude-bit/rubick";

export const LINKS = {
  github: GH,
  releases: `${GH}/releases/latest`,
  issues: `${GH}/issues`,
  contributing: `${GH}/blob/main/CONTRIBUTING.md`,
  security: `${GH}/blob/main/SECURITY.md`,
  license: `${GH}/blob/main/LICENSE`,
  aur: "https://aur.archlinux.org/packages/rubick-kubernetes-bin",
  brew: "brew install --cask Dudude-bit/tap/rubick",
  lies: "https://rubick.tech/lies.yaml",
  reportLie: `${GH}/issues/new?${new URLSearchParams({
    title: "A status Rubick got wrong: ",
    body: [
      "**What the cluster reported**",
      "",
      "**What Rubick showed**",
      "",
      "**What was actually true**",
      "",
      "**Rubick version, Kubernetes version**",
      "",
      "**Smallest manifest that reproduces it** (no kubeconfigs, no secrets)",
      "",
      "```yaml",
      "```",
    ].join("\n"),
  })}`,
};

export const OG_IMAGE = {
  url: `${SITE.url}/og.png`,
  width: "1200",
  height: "630",
  alt: "Rubick showing a workload page with live status, usage history and the traffic chain",
};

export const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE.name,
  description: SITE.description,
  url: SITE.url,
  image: `${SITE.url}/logo.svg`,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  isAccessibleForFree: true,
  license: "https://www.gnu.org/licenses/gpl-3.0.html",
  downloadUrl: `${GH}/releases/latest`,
  screenshot: OG_IMAGE.url,
  sameAs: [GH],
});

export type Shot = { src: string; width: number; height: number };

export const IMG = {
  hero: { src: "/images/hero-workload-detail.webp", width: 1400, height: 900 },
  logs: {
    src: "/images/logs-failing-init-container.webp",
    width: 1190,
    height: 350,
  },
  connections: {
    src: "/images/connections-tab.webp",
    width: 1190,
    height: 380,
  },
  chain: { src: "/images/traffic-chain-stops.webp", width: 1190, height: 255 },
  scale: { src: "/images/scale-interception.webp", width: 512, height: 220 },
} satisfies Record<string, Shot>;
