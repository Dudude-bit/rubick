import { useState } from "react";
import {
  LuBox,
  LuDatabase,
  LuFileText,
  LuGlobe,
  LuHardDrive,
  LuHardDriveDownload,
  LuKeyRound,
  LuLayers,
  LuNetwork,
  LuServer,
} from "react-icons/lu";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

type Kind =
  | "Pod"
  | "Deployment"
  | "ConfigMap"
  | "Secret"
  | "PersistentVolumeClaim"
  | "PersistentVolume"
  | "StorageClass"
  | "Node"
  | "Ingress"
  | "Service";

// The app's kind glyphs and hues: a family per sidebar category, siblings
// spread inside it, dark theme at 38% saturation and 70% lightness.
const KINDS: Record<Kind, { Icon: typeof LuBox; hue: number }> = {
  Pod: { Icon: LuBox, hue: 246 },
  Deployment: { Icon: LuLayers, hue: 252 },
  ConfigMap: { Icon: LuFileText, hue: 18 },
  Secret: { Icon: LuKeyRound, hue: 54 },
  PersistentVolumeClaim: { Icon: LuHardDriveDownload, hue: 308 },
  PersistentVolume: { Icon: LuHardDrive, hue: 326 },
  StorageClass: { Icon: LuDatabase, hue: 344 },
  Node: { Icon: LuServer, hue: 210 },
  Ingress: { Icon: LuGlobe, hue: 174 },
  Service: { Icon: LuNetwork, hue: 170 },
};

type Ref = { kind: Kind; name: string; note: string; tone?: "bad" | "ok" };

type Group = {
  title: string;
  note?: string;
  rows: Ref[];
  empty?: { label: string; note: string };
};

type Subject = {
  kind: Kind;
  name: string;
  facts: string;
  status?: { label: string; tone: "bad" | "ok" };
  chain?: Ref[];
  groups: Group[];
};

const keyOf = (r: { kind: Kind; name: string }) => `${r.kind}/${r.name}`;

const POD: Ref = { kind: "Pod", name: "checkout", note: "" };

// Everything below was read from the fixture on a k3d cluster, not typed in.
const SUBJECTS: Subject[] = [
  {
    kind: "Pod",
    name: "checkout",
    facts: "rubick-lies · 1 container · 3 restarts and counting",
    status: { label: "CrashLoopBackOff", tone: "bad" },
    chain: [
      { kind: "Ingress", name: "shop", note: "/checkout" },
      { kind: "Service", name: "checkout", note: "0 ready", tone: "bad" },
      { kind: "Pod", name: "checkout", note: "never Ready", tone: "bad" },
    ],
    groups: [
      {
        title: "Needs to run",
        note: "if one of these is missing the pod does not start",
        rows: [
          {
            kind: "ConfigMap",
            name: "checkout-config",
            note: "every key becomes an environment variable",
          },
          {
            kind: "Secret",
            name: "checkout-tls",
            note: "mounted at /etc/tls, read-only",
          },
          {
            kind: "PersistentVolumeClaim",
            name: "checkout-data",
            note: "mounted at /data · Bound, 1Gi",
          },
        ],
      },
      {
        title: "Runs on",
        rows: [
          {
            kind: "Node",
            name: "k3d-k8s-gui-dev-server-0",
            note: "the k3d node the fixture was verified on",
          },
        ],
      },
      {
        title: "Not looked at",
        note: "named, so a group that is absent is never read as a group that is empty",
        rows: [],
        empty: {
          label: "the kinds this page did not read",
          note: "listed by name, with the reason, instead of left as a gap",
        },
      },
    ],
  },
  {
    kind: "ConfigMap",
    name: "checkout-config",
    facts: "2 keys · CHECKOUT_REGION, CHECKOUT_CURRENCY",
    groups: [
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [
          {
            ...POD,
            note: "envFrom, every key becomes an environment variable",
          },
        ],
      },
    ],
  },
  {
    kind: "Secret",
    name: "checkout-tls",
    facts: "Opaque · 2 keys, tls.crt and tls.key · values never shown",
    groups: [
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [{ ...POD, note: "mounted at /etc/tls, read-only" }],
      },
    ],
  },
  {
    kind: "PersistentVolumeClaim",
    name: "checkout-data",
    facts: "Bound · 1Gi · ReadWriteOnce",
    groups: [
      {
        title: "Bound to",
        rows: [
          {
            kind: "PersistentVolume",
            name: "pvc-8d1e2f2f-8df4-47d1-94c2-50174980961d",
            note: "provisioned on claim",
          },
          {
            kind: "StorageClass",
            name: "local-path",
            note: "the default class on k3d",
          },
        ],
      },
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [{ ...POD, note: "mounted at /data" }],
      },
    ],
  },
  {
    kind: "Node",
    name: "k3d-k8s-gui-dev-server-0",
    facts: "v1.35.5+k3s1 · K3s · containerd 2.2.3 · amd64",
    groups: [
      {
        title: "What runs here",
        rows: [
          { ...POD, note: "0/1 ready", tone: "bad" },
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods, all ready",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Ingress",
    name: "shop",
    facts: "host shop.example.test · 4 paths · no TLS",
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          { kind: "Service", name: "api-ok", note: "/ · 3 ready", tone: "ok" },
          {
            kind: "Service",
            name: "api",
            note: "/legacy · published with no port",
            tone: "bad",
          },
          {
            kind: "Service",
            name: "checkout",
            note: "/checkout · 0 ready",
            tone: "bad",
          },
          {
            kind: "Service",
            name: "api-v2",
            note: "/api · no Service by that name",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "Service",
    name: "checkout",
    facts: "ClusterIP 10.43.39.231 · 80 to 8080",
    status: { label: "running, none ready", tone: "bad" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            ...POD,
            note: "matched, never Ready, never published",
            tone: "bad",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/checkout" }],
      },
    ],
  },
  {
    kind: "Service",
    name: "api-ok",
    facts: "ClusterIP · 80 to http · 3 endpoints on port 80",
    status: { label: "3 ready", tone: "ok" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods, all published",
            tone: "ok",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/" }],
      },
    ],
  },
  {
    kind: "Service",
    name: "api",
    facts: "ClusterIP · 80 to htp · addresses published with no port",
    status: { label: "no port", tone: "bad" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods matched, htp matches no container",
            tone: "bad",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/legacy" }],
      },
    ],
  },
];

const BY_KEY = new Map(SUBJECTS.map((s) => [keyOf(s), s]));
const ROOT = keyOf(POD);

const tint = (kind: Kind) => ({ color: `hsl(${KINDS[kind].hue} 38% 70%)` });

function KindMark({ kind }: { kind: Kind }) {
  const { Icon } = KINDS[kind];
  return (
    <span className="inline-flex items-center gap-1.5" style={tint(kind)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {kind}
    </span>
  );
}

const NAME = {
  bad: "text-red-300",
  ok: "text-green-300",
  none: "text-neutral-200",
} as const;

function RefRow({
  r,
  onOpen,
  current,
}: {
  r: Ref;
  onOpen: (key: string) => void;
  current: string;
}) {
  const key = keyOf(r);
  const target = BY_KEY.has(key) && key !== current;
  const body = (
    <>
      <KindMark kind={r.kind} />
      <span className={NAME[r.tone ?? "none"]}>{r.name}</span>
      {r.note ? <span className="text-neutral-400">{r.note}</span> : null}
    </>
  );
  return target ? (
    <button
      type="button"
      onClick={() => onOpen(key)}
      className="group -mx-2 flex min-h-9 flex-wrap items-center gap-x-2 rounded-md px-2 text-left font-mono text-[13px] transition-colors hover:bg-neutral-800/70 focus-visible:bg-neutral-800/70 focus-visible:outline-none"
    >
      {body}
      <span
        aria-hidden
        className="text-neutral-600 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
      >
        ›
      </span>
    </button>
  ) : (
    <span className="flex min-h-9 flex-wrap items-center gap-x-2 font-mono text-[13px]">
      {body}
    </span>
  );
}

export function Connections() {
  const [trail, setTrail] = useState<string[]>([ROOT]);
  const current = trail[trail.length - 1] ?? ROOT;
  const subject = BY_KEY.get(current) ?? BY_KEY.get(ROOT)!;
  const open = (key: string) => setTrail((t) => [...t, key]);
  const back = () => setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));

  return (
    <Section eyebrow="Connections">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          One page, everything it touches.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Open a pod and its neighbourhood is already there: the Ingress and
          Service in front of it, the ConfigMap it reads, the Secret it mounts,
          the volume it claims, the node it landed on, and by name the kinds
          nobody asked about. Every neighbour is a page of its own, one click
          away, with its own neighbours. This is the checkout pod from the
          fixture, as read on a k3d cluster. Click through it.
        </p>
      </Reveal>
      <Reveal
        settle
        className="mt-12 max-w-3xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 px-5 py-4 font-mono text-sm">
          {trail.length > 1 ? (
            <button
              type="button"
              onClick={back}
              aria-label="Back"
              className="-ml-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-accent"
            >
              ‹
            </button>
          ) : null}
          <KindMark kind={subject.kind} />
          <span className="text-neutral-100">{subject.name}</span>
          {subject.status ? (
            <span
              className={`ml-auto inline-flex items-center gap-2 rounded-md border px-2 py-0.5 text-[13px] ${subject.status.tone === "bad" ? "border-red-400/70 text-red-300" : "border-green-400/60 text-green-300"}`}
            >
              <span
                className={`size-1.5 rounded-full ${subject.status.tone === "bad" ? "bg-red-400" : "bg-green-400"}`}
              />
              {subject.status.label}
            </span>
          ) : null}
        </div>
        <div key={current} className="flex flex-col gap-6 px-5 py-5">
          <p className="font-mono text-[13px] text-neutral-400">
            {subject.facts}
          </p>
          {subject.chain ? (
            <Reveal delay={60} className="relative pl-4">
              <span
                aria-hidden
                className="rule-y absolute inset-y-0 left-0 w-px bg-neutral-700"
              />
              <h3 className="font-mono text-sm font-normal text-neutral-100">
                Traffic chain
                <span className="text-neutral-400">
                  {" "}
                  · on the Overview, drawn from the entry point down
                </span>
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
                {subject.chain.map((r, i) => (
                  <span
                    key={keyOf(r)}
                    className="inline-flex items-center gap-x-1"
                  >
                    {i > 0 ? (
                      <span aria-hidden className="mx-1 text-neutral-600">
                        →
                      </span>
                    ) : null}
                    <RefRow r={r} onOpen={open} current={current} />
                  </span>
                ))}
              </div>
              <p className="mt-2 font-mono text-[12px] text-neutral-500">
                A Gateway listener and an HTTPRoute draw the same chain from the
                listener down. The fixture uses an Ingress so it needs no CRDs.
              </p>
            </Reveal>
          ) : null}
          {subject.groups.map((g, i) => (
            <Reveal
              key={g.title}
              delay={120 + i * 110}
              className="relative pl-4"
            >
              <span
                aria-hidden
                className="rule-y absolute inset-y-0 left-0 w-px bg-neutral-700"
              />
              <h3 className="font-mono text-sm font-normal text-neutral-100">
                {g.title}
                {g.note ? (
                  <span className="text-neutral-400"> · {g.note}</span>
                ) : null}
              </h3>
              {g.rows.length > 0 ? (
                <ul className="mt-1 flex flex-col">
                  {g.rows.map((r) => (
                    <li key={keyOf(r)}>
                      <RefRow r={r} onOpen={open} current={current} />
                    </li>
                  ))}
                </ul>
              ) : g.empty ? (
                <p className="mt-2 flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
                  <span className="rounded-md border border-dashed border-neutral-600 px-2 py-0.5 text-neutral-300">
                    {g.empty.label}
                  </span>
                  <span className="text-neutral-400">{g.empty.note}</span>
                </p>
              ) : null}
            </Reveal>
          ))}
        </div>
      </Reveal>
      <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-400">
        Nine objects from the fixture, each drawn in the groups its own
        Connections tab uses. What the tab does not show is not drawn here
        either.
      </p>
    </Section>
  );
}
