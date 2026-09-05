import { useState } from "react";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { useHydrated } from "../lib/use-hydrated";

type Tone = "ok" | "bad" | "warn" | "muted";

const CHIP: Record<Tone, string> = {
  ok: "border-green-400/60 text-green-300",
  bad: "border-red-400/70 text-red-300",
  warn: "border-amber-400/70 text-amber-200",
  muted: "border-neutral-600 text-neutral-300",
};

function Chip({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[12px] ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

type App = {
  name: string;
  argo: { label: string; tone: Tone }[];
  rubick: string;
  edit: string;
};

// Argo CD Applications from test-manifests/k8s-gui-all.yaml, in the states
// its comments describe; the sentences are the app's own.
const ARGO: App[] = [
  {
    name: "podinfo",
    argo: [
      { label: "Synced", tone: "ok" },
      { label: "Healthy", tone: "ok" },
    ],
    rubick: "The quiet case, and the one that must stay quiet.",
    edit: "Argo self-heals this Application: an edit made here is put back on its next comparison, within about five minutes.",
  },
  {
    name: "shop",
    argo: [
      { label: "OutOfSync", tone: "warn" },
      { label: "Missing", tone: "bad" },
    ],
    rubick:
      "sync failing: the destination namespace does not exist and CreateNamespace is off, so the API server refuses every object and Argo retries for ever.",
    edit: "Auto-sync is on, so whatever you change here is compared again on the next pass; the sync itself keeps failing until the namespace exists.",
  },
  {
    name: "analytics",
    argo: [
      { label: "OutOfSync", tone: "warn" },
      { label: "Healthy", tone: "ok" },
    ],
    rubick:
      "1 out of sync with nothing fixing it: the same column Argo shows, and the opposite problem. Nothing is retrying, and nothing will change until a person decides.",
    edit: "Auto-sync is off, so an edit here stands until somebody syncs the Application.",
  },
];

type FluxState = {
  flux: { label: string; tone: Tone }[];
  title: string;
  detail?: string;
  edit: string;
};

const FLUX_BEFORE: FluxState = {
  flux: [{ label: "Ready", tone: "ok" as Tone }],
  title: "Reconciling every 10m, applied the revision the source has.",
  edit: "tenant-b re-applies its manifests every 10m, so an edit here is undone on the next pass.",
};

const FLUX_AFTER: FluxState = {
  flux: [{ label: "Ready", tone: "ok" as Tone }],
  title: "Suspended: it is not reconciling and it is not failing.",
  detail:
    "A suspended Kustomization keeps the Ready condition from the last time it ran, so it reads as healthy in every list, Flux's own included. It last applied the revision from before the suspend; whatever has been committed since is not here.",
  edit: "tenant-b is suspended, so nothing is being applied and an edit here stands, until somebody resumes it, at which point it is undone.",
};

export function GitOps() {
  const interactive = useHydrated();
  const [suspended, setSuspended] = useState(true);
  const flux = suspended ? FLUX_AFTER : FLUX_BEFORE;

  return (
    <Section id="gitops" eyebrow="Delivered by">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Argo CD and Flux, and whether your edit survives.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Every delivered object says who delivers it, from which revision, and
          what happens to a change you make by hand. The status words are the
          controllers' own; the sentences under them are Rubick's. These are the
          specimens from the repo's test manifests, in the states its harness
          puts them in.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        <Reveal className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
          <h3 className="font-display text-xl font-bold">Argo CD</h3>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            argocd · 3 Applications, project prod
          </p>
          <ul className="mt-5 flex flex-col divide-y divide-neutral-800">
            {ARGO.map((a, i) => (
              <Reveal
                key={a.name}
                as="li"
                delay={80 + i * 90}
                className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
                  <span className="text-neutral-100">{a.name}</span>
                  {a.argo.map((c) => (
                    <Chip key={c.label} tone={c.tone}>
                      {c.label}
                    </Chip>
                  ))}
                </div>
                <p className="text-sm text-neutral-400">{a.rubick}</p>
                <p className="text-sm text-neutral-300">
                  <span className="font-mono text-xs text-neutral-500">
                    if you edit it{" "}
                  </span>
                  {a.edit}
                </p>
              </Reveal>
            ))}
          </ul>
        </Reveal>

        <Reveal
          delay={90}
          className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
        >
          <h3 className="font-display text-xl font-bold">Flux</h3>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            flux-system · Kustomization tenant-b
          </p>
          {interactive ? (
            <div
              role="group"
              aria-label="Kustomization state"
              className="mt-5 flex flex-wrap gap-2"
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
                  className={`min-h-11 rounded-md border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${suspended === value ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div key={String(suspended)} className="mt-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
              <span className="text-neutral-100">tenant-b</span>
              {flux.flux.map((c) => (
                <Chip key={c.label} tone={c.tone}>
                  {c.label}
                </Chip>
              ))}
              {suspended ? <Chip tone="muted">suspended</Chip> : null}
            </div>
            <p className="quiz-answer text-sm text-neutral-200">{flux.title}</p>
            {flux.detail ? (
              <p className="quiz-answer text-sm text-neutral-400">
                {flux.detail}
              </p>
            ) : null}
            <p className="quiz-answer text-sm text-neutral-300">
              <span className="font-mono text-xs text-neutral-500">
                if you edit it{" "}
              </span>
              {flux.edit}
            </p>
          </div>
          <p className="mt-5 font-mono text-xs text-neutral-500">
            The badge that does not move is the point: Flux keeps Ready from the
            last run, so every list stays green. Rubick names the suspend and
            the revision it stopped at.
          </p>
        </Reveal>
      </div>

      <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-400">
        These specimens need Argo CD and Flux installed, so they are not in
        lies.yaml; they live in test-manifests/k8s-gui-all.yaml with the
        commands that put them into these states.
      </p>
    </Section>
  );
}
