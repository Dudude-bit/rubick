import { useState } from "react";
import { LuGauge, LuGitFork, LuFolderGit2, LuBoxes } from "react-icons/lu";
import { SiArgo, SiFlux } from "react-icons/si";
import { Reveal } from "./motion/reveal";
import { CORE_KINDS, Peek, type KindStyle, type Subject } from "./peek";
import { Section } from "./section";
import { Footer } from "../sections/footer";
import { Nav } from "../sections/nav";
import { useHydrated } from "../lib/use-hydrated";

const KINDS: Record<string, KindStyle> = {
  ...CORE_KINDS,
  Application: { Icon: SiArgo, color: "#ef7b4d" },
  AppProject: { Icon: LuFolderGit2, color: "#ef7b4d" },
  ApplicationSet: { Icon: LuGitFork, color: "#ef7b4d" },
  Kustomization: { Icon: SiFlux, color: "#5468ff" },
  GitRepository: { Icon: LuFolderGit2, color: "#5468ff" },
  HorizontalPodAutoscaler: { Icon: LuGauge, hue: 210 },
  Namespace: { Icon: LuBoxes, hue: 210 },
};

const REV = "master@sha1:dd507173b7b75b2312a36cabe0de5f09c1ce69c8";
const SHORT = "dd50717";

// Read from the specimens in test-manifests/k8s-gui-all.yaml, applied to a
// k3d cluster with Argo CD and Flux installed, on 2026-09-05 around 04:27 UTC.
const ARGO: Subject[] = [
  {
    kind: "Application",
    name: "podinfo",
    ns: "argocd",
    facts: "project prod · kustomize @ master · auto-sync, prune, self-heal",
    status: { label: "Synced · Healthy", tone: "ok" },
    details: [
      ["Repository", "https://github.com/stefanprodan/podinfo"],
      ["Revision", `${SHORT}, master`],
      ["Destination", "argo-podinfo, created by the sync"],
      ["Last sync", "2026-09-05 04:25 UTC, succeeded"],
      [
        "If you edit it",
        "Argo self-heals this Application: an edit made here is put back on its next comparison, within about five minutes.",
      ],
    ],
    groups: [
      {
        title: "Delivers",
        note: "what the last sync wrote",
        rows: [
          {
            kind: "Deployment",
            name: "podinfo",
            ns: "argo-podinfo",
            note: "synced",
            tone: "ok",
          },
          {
            kind: "Service",
            name: "podinfo",
            ns: "argo-podinfo",
            note: "synced",
            tone: "ok",
          },
          {
            kind: "HorizontalPodAutoscaler",
            name: "podinfo",
            ns: "argo-podinfo",
            note: "synced",
            tone: "ok",
          },
        ],
      },
      {
        title: "Belongs to",
        rows: [{ kind: "AppProject", name: "prod", ns: "argocd", note: "" }],
      },
      {
        title: "Applications in argocd",
        note: "the other three, each in a different state",
        rows: [
          {
            kind: "Application",
            name: "shop",
            ns: "argocd",
            note: "sync failing",
            tone: "bad",
          },
          {
            kind: "Application",
            name: "analytics",
            ns: "argocd",
            note: "out of sync, nothing fixing it",
            tone: "warn",
          },
          {
            kind: "Application",
            name: "tenant-a",
            ns: "argocd",
            note: "generated",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Application",
    name: "shop",
    ns: "argocd",
    facts: "project prod · kustomize @ master · auto-sync, self-heal, no prune",
    status: { label: "sync failing", tone: "bad" },
    details: [
      ["Argo says", "OutOfSync · Missing"],
      ["Destination", "argo-shop-nowhere, which does not exist"],
      [
        "Operation",
        'Running: one or more objects failed to apply, reason: namespaces "argo-shop-nowhere" not found. Retrying attempt #5.',
      ],
      [
        "Out of sync",
        "Service/podinfo, Deployment/podinfo, HorizontalPodAutoscaler/podinfo",
      ],
      [
        "If you edit it",
        "Auto-sync is on, so whatever you change is compared again on the next pass; the sync itself keeps failing until the namespace exists. CreateNamespace is deliberately absent.",
      ],
    ],
    groups: [
      {
        title: "Delivers",
        note: "wants to, and cannot",
        rows: [
          {
            kind: "Deployment",
            name: "podinfo",
            ns: "argo-shop-nowhere",
            note: "not created",
            tone: "bad",
          },
          {
            kind: "Service",
            name: "podinfo",
            ns: "argo-shop-nowhere",
            note: "not created",
            tone: "bad",
          },
          {
            kind: "HorizontalPodAutoscaler",
            name: "podinfo",
            ns: "argo-shop-nowhere",
            note: "not created",
            tone: "bad",
          },
        ],
      },
      {
        title: "Belongs to",
        rows: [{ kind: "AppProject", name: "prod", ns: "argocd", note: "" }],
      },
    ],
  },
  {
    kind: "Application",
    name: "analytics",
    ns: "argocd",
    facts: "project default · kustomize @ master · auto-sync off",
    status: { label: "out of sync, nothing fixing it", tone: "warn" },
    details: [
      ["Argo says", "OutOfSync · Healthy"],
      ["Last sync", "2026-09-05 04:27 UTC, succeeded, by hand"],
      [
        "Drift",
        "Deployment/podinfo: image set to podinfo:6.5.4 by hand after the sync",
      ],
      ["Revision", `${SHORT}, master`],
      [
        "If you edit it",
        "Auto-sync is off, so an edit here stands until somebody syncs the Application.",
      ],
    ],
    groups: [
      {
        title: "Delivers",
        rows: [
          {
            kind: "Deployment",
            name: "podinfo",
            ns: "argo-analytics",
            note: "out of sync, image changed by hand",
            tone: "warn",
          },
          {
            kind: "Service",
            name: "podinfo",
            ns: "argo-analytics",
            note: "synced",
            tone: "ok",
          },
          {
            kind: "HorizontalPodAutoscaler",
            name: "podinfo",
            ns: "argo-analytics",
            note: "synced",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Application",
    name: "tenant-a",
    ns: "argocd",
    facts: "generated · kustomize @ master · auto-sync",
    status: { label: "Synced · Healthy", tone: "ok" },
    details: [
      ["Made by", "ApplicationSet tenants, list generator"],
      [
        "If you edit it",
        "An edit to a generated Application is undone by its generator. Edit the ApplicationSet, or the repository.",
      ],
    ],
    groups: [
      {
        title: "Made by, and makes",
        rows: [
          {
            kind: "ApplicationSet",
            name: "tenants",
            ns: "argocd",
            note: "made by",
          },
          {
            kind: "Deployment",
            name: "podinfo",
            ns: "argo-tenant-a",
            note: "synced",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "AppProject",
    name: "prod",
    ns: "argocd",
    facts: "sourceRepos * · destinations * · every cluster resource allowed",
    groups: [
      {
        title: "Applications",
        rows: [
          {
            kind: "Application",
            name: "podinfo",
            ns: "argocd",
            note: "Synced · Healthy",
            tone: "ok",
          },
          {
            kind: "Application",
            name: "shop",
            ns: "argocd",
            note: "sync failing",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "AppProject",
    name: "default",
    ns: "argocd",
    facts: "the project Argo ships with",
    groups: [
      {
        title: "Applications",
        rows: [
          {
            kind: "Application",
            name: "analytics",
            ns: "argocd",
            note: "out of sync",
            tone: "warn",
          },
          {
            kind: "Application",
            name: "tenant-a",
            ns: "argocd",
            note: "generated",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "ApplicationSet",
    name: "tenants",
    ns: "argocd",
    facts: "list generator · 1 element",
    groups: [
      {
        title: "Makes",
        rows: [
          {
            kind: "Application",
            name: "tenant-a",
            ns: "argocd",
            note: "generated",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Deployment",
    name: "podinfo",
    ns: "argo-podinfo",
    facts: "delivered · 1/1 ready",
    status: { label: "1 of 1 ready", tone: "ok" },
    groups: [
      {
        title: "Delivered by",
        note: "Argo self-heals it: an edit here is put back within about five minutes",
        rows: [
          {
            kind: "Application",
            name: "podinfo",
            ns: "argocd",
            note: `last applied ${SHORT} at 04:25 UTC`,
            tone: "ok",
          },
        ],
      },
      {
        title: "Governed by",
        note: "acts on this on its own schedule, and nothing here asked for it",
        rows: [
          {
            kind: "HorizontalPodAutoscaler",
            name: "podinfo",
            ns: "argo-podinfo",
            note: "sets the replica count",
          },
        ],
      },
    ],
  },
  {
    kind: "Deployment",
    name: "podinfo",
    ns: "argo-analytics",
    facts: "image podinfo:6.5.4, set by hand · 1/1 ready",
    status: { label: "out of sync", tone: "warn" },
    groups: [
      {
        title: "Delivered by",
        note: "auto-sync is off, so this edit stands until somebody syncs",
        rows: [
          {
            kind: "Application",
            name: "analytics",
            ns: "argocd",
            note: "out of sync since the image change",
            tone: "warn",
          },
        ],
      },
    ],
  },
];

const FLUX_SHARED: Subject[] = [
  {
    kind: "GitRepository",
    name: "podinfo",
    ns: "flux-system",
    facts:
      "branch master · interval 2m · the URL was moved after the first fetch",
    status: { label: "not Ready", tone: "bad" },
    details: [
      ["URL", "https://github.com/k8s-gui-demo/podinfo-moved"],
      [
        "Message",
        "failed to checkout and determine revision: unable to list remote for 'https://github.com/k8s-gui-demo/podinfo-moved': authentication required: Repository not found.",
      ],
      ["Last artifact", `${REV}, stored before the move`],
    ],
    groups: [
      {
        title: "Feeds",
        note: "everything below it is frozen at the last artifact",
        rows: [
          {
            kind: "Kustomization",
            name: "apps",
            ns: "flux-system",
            note: `Ready, frozen at ${SHORT}`,
            tone: "warn",
          },
          {
            kind: "Kustomization",
            name: "tenant-b",
            ns: "flux-system",
            note: "suspended",
            tone: "warn",
          },
          {
            kind: "Kustomization",
            name: "ingress",
            ns: "flux-system",
            note: "waiting on platform",
            tone: "bad",
          },
          {
            kind: "Kustomization",
            name: "monitoring",
            ns: "flux-system",
            note: "waiting on platform",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "GitRepository",
    name: "infra",
    ns: "flux-system",
    facts:
      "branch main · interval 2m · a private repository nothing here can read",
    status: { label: "not Ready", tone: "bad" },
    details: [
      ["URL", "https://github.com/k8s-gui-demo/private-infra"],
      [
        "Message",
        "failed to checkout and determine revision: unable to clone 'https://github.com/k8s-gui-demo/private-infra': authentication required: Repository not found.",
      ],
    ],
    groups: [
      {
        title: "Feeds",
        rows: [
          {
            kind: "Kustomization",
            name: "platform",
            ns: "flux-system",
            note: "Source artifact not found",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "Kustomization",
    name: "apps",
    ns: "flux-system",
    facts: "./kustomize · every 10m · into flux-apps",
    status: { label: "Ready", tone: "ok" },
    details: [
      ["Flux says", `Applied revision: ${REV}`],
      [
        "Rubick says",
        `Its source stopped fetching; everything below it is frozen at ${SHORT}`,
      ],
      [
        "If you edit it",
        "apps re-applies its manifests every 10m, so an edit here is undone on the next pass, from the frozen artifact.",
      ],
    ],
    groups: [
      {
        title: "Source",
        rows: [
          {
            kind: "GitRepository",
            name: "podinfo",
            ns: "flux-system",
            note: "not Ready",
            tone: "bad",
          },
        ],
      },
      {
        title: "Delivers",
        rows: [
          {
            kind: "Deployment",
            name: "podinfo",
            ns: "flux-apps",
            note: `from ${SHORT}`,
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Kustomization",
    name: "platform",
    ns: "flux-system",
    facts: "./clusters/prod · every 5m · two others depend on it",
    status: { label: "not Ready", tone: "bad" },
    details: [
      ["Flux says", "Source artifact not found, retrying in 30s"],
      ["Rubick says", "nothing to apply from: the source has never fetched"],
    ],
    groups: [
      {
        title: "Source",
        rows: [
          {
            kind: "GitRepository",
            name: "infra",
            ns: "flux-system",
            note: "Repository not found",
            tone: "bad",
          },
        ],
      },
      {
        title: "Blocks",
        note: "dependsOn points here",
        rows: [
          {
            kind: "Kustomization",
            name: "ingress",
            ns: "flux-system",
            note: "waiting",
            tone: "bad",
          },
          {
            kind: "Kustomization",
            name: "monitoring",
            ns: "flux-system",
            note: "waiting",
            tone: "bad",
          },
        ],
      },
    ],
  },
  ...(["ingress", "monitoring"] as const).map((name): Subject => ({
    kind: "Kustomization",
    name,
    ns: "flux-system",
    facts: `./kustomize · every 10m · into flux-${name}`,
    status: { label: "not Ready", tone: "bad" },
    details: [
      ["Flux says", "dependency 'flux-system/platform' is not ready"],
      [
        "Rubick says",
        "Waiting on platform, which is not ready. Nothing applied yet.",
      ],
    ],
    groups: [
      {
        title: "Depends on",
        rows: [
          {
            kind: "Kustomization",
            name: "platform",
            ns: "flux-system",
            note: "not Ready",
            tone: "bad",
          },
        ],
      },
      {
        title: "Source",
        rows: [
          {
            kind: "GitRepository",
            name: "podinfo",
            ns: "flux-system",
            note: "not Ready",
            tone: "bad",
          },
        ],
      },
    ],
  })),
  {
    kind: "Deployment",
    name: "podinfo",
    ns: "flux-apps",
    facts: "delivered · 1/1 ready",
    status: { label: "1 of 1 ready", tone: "ok" },
    groups: [
      {
        title: "Delivered by",
        note: "re-applied every 10m from the frozen artifact",
        rows: [
          {
            kind: "Kustomization",
            name: "apps",
            ns: "flux-system",
            note: `applied ${SHORT}`,
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Deployment",
    name: "podinfo",
    ns: "flux-tenant-b",
    facts: "delivered · 1/1 ready",
    status: { label: "1 of 1 ready", tone: "ok" },
    groups: [
      {
        title: "Delivered by",
        rows: [
          {
            kind: "Kustomization",
            name: "tenant-b",
            ns: "flux-system",
            note: `applied ${SHORT}`,
            tone: "ok",
          },
        ],
      },
    ],
  },
];

const TENANT_B_BEFORE: Subject = {
  kind: "Kustomization",
  name: "tenant-b",
  ns: "flux-system",
  facts: "./kustomize · every 10m · into flux-tenant-b",
  status: { label: "Ready", tone: "ok" },
  details: [
    ["Flux says", `Applied revision: ${REV}`],
    ["Rubick says", `applied ${SHORT}; the source has ${SHORT}`],
    [
      "If you edit it",
      "tenant-b re-applies its manifests every 10m, so an edit here is undone on the next pass.",
    ],
  ],
  groups: [
    {
      title: "Source",
      rows: [
        {
          kind: "GitRepository",
          name: "podinfo",
          ns: "flux-system",
          note: "Ready",
          tone: "ok",
        },
      ],
    },
    {
      title: "Delivers",
      rows: [
        {
          kind: "Deployment",
          name: "podinfo",
          ns: "flux-tenant-b",
          note: `from ${SHORT}`,
          tone: "ok",
        },
      ],
    },
  ],
};

const TENANT_B_AFTER: Subject = {
  ...TENANT_B_BEFORE,
  facts: "./kustomize · every 10m · into flux-tenant-b · spec.suspend: true",
  details: [
    ["Flux says", `Ready · Applied revision: ${REV}`],
    ["Rubick says", "Suspended: it is not reconciling and it is not failing"],
    [
      "Why the badge lies",
      `A suspended Kustomization keeps the Ready condition from the last time it ran, so it reads as healthy in every list, Flux's own included. It last applied ${SHORT}; whatever has been committed since is not here.`,
    ],
    [
      "If you edit it",
      "tenant-b is suspended, so nothing is being applied and an edit here stands, until somebody resumes it, at which point it is undone.",
    ],
  ],
  groups: [
    {
      title: "Source",
      rows: [
        {
          kind: "GitRepository",
          name: "podinfo",
          ns: "flux-system",
          note: "not Ready, moved after the fetch",
          tone: "bad",
        },
      ],
    },
    {
      title: "Delivers",
      rows: [
        {
          kind: "Deployment",
          name: "podinfo",
          ns: "flux-tenant-b",
          note: `from ${SHORT}, untouched since`,
          tone: "ok",
        },
      ],
    },
  ],
};

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

export function DeliveryPage() {
  const interactive = useHydrated();
  const [suspended, setSuspended] = useState(true);
  const flux = [suspended ? TENANT_B_AFTER : TENANT_B_BEFORE, ...FLUX_SHARED];

  return (
    <>
      <Nav />
      <main>
        <Section eyebrow="Delivered by">
          <Reveal>
            <h1 className="max-w-4xl font-display text-4xl font-bold tracking-tight md:text-6xl">
              Argo CD and Flux, and whether your edit survives.
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-neutral-400">
              Every delivered object says who delivers it, from which revision,
              and what happens to a change you make by hand. Two clusters of
              objects below, one per controller, read live from the repo's
              specimens on a k3d cluster with both controllers installed. Every
              row is a page; click through.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="flex items-center gap-2.5 font-display text-2xl font-bold">
                <SiArgo
                  aria-hidden
                  className="size-6"
                  style={{ color: "#ef7b4d" }}
                />
                Argo CD
              </h2>
              <p className="mt-2 font-mono text-sm text-neutral-400">
                Four Applications, one project, one generator. Start at the
                quiet one.
              </p>
              <Peek
                subjects={ARGO}
                kinds={KINDS}
                root="Application/argocd/podinfo"
                className="mt-5"
              />
            </div>
            <div>
              <h2 className="flex items-center gap-2.5 font-display text-2xl font-bold">
                <SiFlux
                  aria-hidden
                  className="size-6"
                  style={{ color: "#5468ff" }}
                />
                Flux
              </h2>
              <p className="mt-2 font-mono text-sm text-neutral-400">
                Two sources, five Kustomizations. Start at the one that was
                suspended after it had run.
              </p>
              {interactive ? (
                <div
                  role="group"
                  aria-label="Kustomization tenant-b state"
                  className="mt-4 flex flex-wrap gap-2"
                >
                  {(
                    [
                      ["Before the suspend", false],
                      ["After the suspend", true],
                    ] as const
                  ).map(([label, value]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={suspended === value}
                      onClick={() => setSuspended(value)}
                      className={`min-h-11 rounded-md border px-4 py-2 text-sm ${FOCUS} ${suspended === value ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              <Peek
                key={String(suspended)}
                subjects={flux}
                kinds={KINDS}
                root="Kustomization/flux-system/tenant-b"
                className="mt-5"
              />
            </div>
          </div>
          <p className="mt-8 max-w-2xl font-mono text-sm text-neutral-400">
            The status words are the controllers' own. The sentences under
            "Rubick says" and "If you edit it" are the app's, quoted from its
            catalogue. The specimens live in test-manifests/k8s-gui-all.yaml
            with the commands that put them into these states; they need the
            controllers installed, so they are not part of lies.yaml.
          </p>
        </Section>
      </main>
      <Footer />
    </>
  );
}
