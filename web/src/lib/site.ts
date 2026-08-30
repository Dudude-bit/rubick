export const SITE = {
  name: "Rubick",
  title: "Rubick, a desktop Kubernetes client that tries not to lie to you",
  description:
    "A crashlooping pod says Running. A dead Service draws green. Rubick reads what the cluster actually does and tells you that instead. Free, GPLv3, no account, no telemetry.",
  // PLACEHOLDER, replace when the domain exists
  url: "https://rubick.example",
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
};

export const OG_IMAGE = {
  url: `${SITE.url}/images/hero-workload-detail.png`,
  width: "1400",
  height: "900",
  alt: "Rubick showing a workload page with live status, usage history and the traffic chain",
};

export const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE.name,
  description: SITE.description,
  url: SITE.url,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  isAccessibleForFree: true,
  license: "https://www.gnu.org/licenses/gpl-3.0.html",
  downloadUrl: `${GH}/releases/latest`,
  screenshot: OG_IMAGE.url,
  sameAs: [GH],
});

export const IMG = {
  hero: "/images/hero-workload-detail.png",
  logs: "/images/logs-failing-init-container.png",
  connections: "/images/connections-tab.png",
  chain: "/images/traffic-chain-stops.png",
  scale: "/images/scale-interception.png",
};
