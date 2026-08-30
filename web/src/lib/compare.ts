import { SITE } from "./site";

export type CompareRow = {
  label: string;
  rubick: string;
  them: string;
};

export type Competitor = {
  slug: string;
  name: string;
  tagline: string;
  metaDescription: string;
  verdict: string;
  pickThem: string[];
  pickRubick: string[];
  rows: CompareRow[];
  honestNote: string;
};

export const LAST_VERIFIED = "August 2026";

export function compareHead(c: Competitor) {
  const url = `${SITE.url}/vs/${c.slug}`;
  const title = `Rubick vs ${c.name}, honestly`;
  return {
    meta: [
      { title },
      { name: "description", content: c.metaDescription },
      { property: "og:title", content: title },
      { property: "og:description", content: c.metaDescription },
      { property: "og:url", content: url },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

export const COMPETITORS: Competitor[] = [
  {
    slug: "lens",
    name: "Lens",
    tagline: "the Kubernetes IDE by Mirantis",
    metaDescription:
      "Rubick vs Lens, honestly: license, price, account requirements and what each shows about your cluster. Lens is bigger and commercial; Rubick is GPLv3, account-free and built to not lie about status.",
    verdict:
      "Lens is a mature commercial IDE with a big ecosystem. Rubick is a young free tool obsessed with one thing: telling you the truth about your cluster.",
    pickThem: [
      "You want a product with commercial support and an SLA behind it.",
      "Your team already lives in Lens and its AI/GitOps tooling.",
      "You need features a one-page comparison cannot capture: Lens has had years and a company to build them.",
    ],
    pickRubick: [
      "You do not want an account for a tool that reads your own kubeconfig.",
      "Your company clears $10M and the per-seat subscription is hard to justify for cluster viewing.",
      "You have been bitten by a green dashboard over a crashlooping pod and want status derived the way kubectl does it.",
    ],
    rows: [
      {
        label: "License",
        rubick: "GPL-3.0-or-later",
        them: "proprietary; the open-source Lens Desktop repo is retired",
      },
      {
        label: "Price",
        rubick: "free for anyone",
        them: "free below $10M revenue; Plus from $25/user/month",
      },
      {
        label: "Account",
        rubick: "none",
        them: "Lens ID activation on launch",
      },
      { label: "Built on", rubick: "Tauri (Rust)", them: "Electron" },
      {
        label: "Telemetry",
        rubick: "none",
        them: "online activation required; see their policy",
      },
      {
        label: "Pod status",
        rubick: "derived like kubectl, crashloops surface",
        them: "shown per their own model",
      },
      {
        label: "Traffic path",
        rubick: "Ingress to pod drawn, break named",
        them: "resources listed separately",
      },
    ],
    honestNote:
      "Lens has more features than this table, a decade of polish, and a million users. We compare on the axes Rubick was built for; go click around Lens yourself.",
  },
  {
    slug: "k9s",
    name: "k9s",
    tagline: "the terminal UI for Kubernetes",
    metaDescription:
      "Rubick vs k9s, honestly: terminal vs desktop, what each is best at, and why plenty of people should just use k9s. Both free and open source.",
    verdict:
      "k9s is superb and you should probably have it installed either way. The real question is whether your problem today needs a terminal or a screen with history on it.",
    pickThem: [
      "You are SSH-ed into a jump host and a terminal is all there is.",
      "Speed and muscle memory beat everything; k9s is instant and fully keyboard-driven.",
      "You want zero GUI anywhere in your workflow.",
    ],
    pickRubick: [
      "You want CPU and memory over time, not just the current number.",
      "You are walking a broken Ingress path and want the chain drawn with the break named.",
      "You want cert expiry, Argo/Flux ownership and cloud node pools read for you, not hunted through YAML.",
    ],
    rows: [
      { label: "License", rubick: "GPL-3.0-or-later", them: "Apache-2.0" },
      { label: "Price", rubick: "free", them: "free" },
      { label: "Account", rubick: "none", them: "none" },
      {
        label: "Runs as",
        rubick: "desktop app (macOS, Windows, Linux)",
        them: "terminal UI, anywhere a terminal runs",
      },
      { label: "Built on", rubick: "Tauri (Rust)", them: "Go" },
      {
        label: "Metrics",
        rubick: "history over time via Prometheus",
        them: "live values via metrics-server",
      },
      { label: "Works over SSH", rubick: "no", them: "yes, that is the point" },
    ],
    honestNote:
      "This is not really a versus. k9s lives in the terminal, Rubick lives on a screen; most people who like one end up using both.",
  },
  {
    slug: "headlamp",
    name: "Headlamp",
    tagline: "the Kubernetes SIG UI web interface",
    metaDescription:
      "Rubick vs Headlamp, honestly: a CNCF web UI your whole team shares versus a local desktop client that trusts nothing. Both free and open source.",
    verdict:
      "Headlamp is what you deploy for a team. Rubick is what you run on your own machine when you want the unvarnished version of what the cluster is doing.",
    pickThem: [
      "You want one URL the whole team opens, deployed in-cluster with RBAC deciding who sees what.",
      "You want to extend the UI with your own plugins and branding.",
      "You want a Kubernetes sub-project with SIG UI governance behind it.",
    ],
    pickRubick: [
      "You do not want to deploy or operate anything to look at your cluster.",
      "You want status that disagrees with .status.phase when the container is crashlooping.",
      "You want the traffic chain, interception warnings and integrations read out of the box, no plugins to write.",
    ],
    rows: [
      { label: "License", rubick: "GPL-3.0-or-later", them: "Apache-2.0" },
      { label: "Price", rubick: "free", them: "free" },
      { label: "Account", rubick: "none", them: "none; your cluster auth" },
      {
        label: "Runs as",
        rubick: "desktop app on your machine",
        them: "web UI in-cluster, or a desktop app",
      },
      {
        label: "Governance",
        rubick: "one project, GPLv3",
        them: "Kubernetes SIG UI sub-project",
      },
      {
        label: "Extensibility",
        rubick: "integrations built in, folder + line to add one",
        them: "plugin SDK, write your own",
      },
      {
        label: "Team sharing",
        rubick: "no, it is a local client",
        them: "yes, that is the point",
      },
    ],
    honestNote:
      "Headlamp solves team access; Rubick does not even try. If you need a shared URL, that is Headlamp and this page will not talk you out of it.",
  },
];
