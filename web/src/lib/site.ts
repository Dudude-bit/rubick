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

export const IMG = {
  hero: "/images/hero-workload-detail.png",
  logs: "/images/logs-failing-init-container.png",
  connections: "/images/connections-tab.png",
  chain: "/images/traffic-chain-stops.png",
  scale: "/images/scale-interception.png",
};
