import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

type Row = { kind: string; name: string; note: string };

type Group = {
  title: string;
  note?: string;
  rows: Row[];
  empty?: { label: string; note: string };
};

const GROUPS: Group[] = [
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
        note: "mounted at /data · Bound, 1Gi, local-path",
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
];

export function Connections() {
  return (
    <Section eyebrow="Connections">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          One page, everything it touches.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Open a pod and its neighbourhood is already there: the ConfigMap it
          reads, the Secret it mounts, the volume it claims, the node it landed
          on, and by name the kinds nobody asked about. Grouped by the question
          you came with, not by kind, and never as a graph: a chain has an
          order, a blob has none. This is the checkout pod from the fixture, in
          the groups its Connections tab uses.
        </p>
      </Reveal>
      <Reveal
        settle
        className="mt-12 max-w-3xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 px-5 py-4 font-mono text-sm">
          <span className="text-neutral-400">Pod</span>
          <span className="text-neutral-100">checkout</span>
          <span className="text-neutral-500">rubick-lies</span>
          <span className="ml-auto inline-flex items-center gap-2 rounded-md border border-red-400/70 px-2 py-0.5 text-[13px] text-red-300">
            <span className="size-1.5 rounded-full bg-red-400" />
            CrashLoopBackOff
          </span>
        </div>
        <div className="flex flex-col gap-6 px-5 py-5">
          {GROUPS.map((g, i) => (
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
                <ul className="mt-2 flex flex-col gap-1.5">
                  {g.rows.map((r) => (
                    <li
                      key={`${r.kind}/${r.name}`}
                      className="flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]"
                    >
                      <span className="text-neutral-400">{r.kind}</span>
                      <span className="text-neutral-200">{r.name}</span>
                      <span className="text-neutral-400">{r.note}</span>
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
        The traffic to this pod is not repeated here: the chain on the Overview
        draws it, one scroll up, and a tab that repeated it would be a second
        answer to a question already answered.
      </p>
    </Section>
  );
}
