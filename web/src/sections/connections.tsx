import type { ReactNode } from "react";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

type Row = { kind: string; name: string; note: ReactNode; tone?: "bad" };

type Group = {
  title: string;
  note?: string;
  rows: Row[];
  empty?: { label: string; note: string; dashed?: boolean };
};

const GROUPS: Group[] = [
  {
    title: "What answers here",
    note: "what made the pods behind this address",
    rows: [
      {
        kind: "Ingress",
        name: "shop",
        note: "/checkout, host shop.example.test",
      },
      {
        kind: "Service",
        name: "checkout",
        note: "0 ready · running, none ready",
        tone: "bad",
      },
    ],
  },
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
        note: "captured on the k3d cluster the fixture was verified on",
      },
    ],
  },
  {
    title: "Governed by",
    note: "acts on this on its own schedule, and nothing here asked for it",
    rows: [],
    empty: {
      label: "nobody does",
      note: "no autoscaler, no controller, a bare pod",
    },
  },
  {
    title: "Delivered by",
    rows: [],
    empty: {
      label: "Not looked at",
      note: "named, so a group that is absent is never read as a group that is empty",
      dashed: true,
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
          Open a pod and its neighbourhood is already there: what routes to it,
          what it needs to start, what acts on it without being asked. Grouped
          by the question you came with, not by kind, and never as a graph: a
          chain has an order, a blob has none. This is the checkout pod from the
          fixture, as its page draws it.
        </p>
      </Reveal>
      <Reveal
        settle
        className="mt-12 max-w-3xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 px-5 py-4 font-mono text-sm">
          <span className="text-neutral-500">Pod</span>
          <span className="text-neutral-100">checkout</span>
          <span className="text-neutral-600">rubick-lies</span>
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
              <p className="font-mono text-sm text-neutral-100">
                {g.title}
                {g.note ? (
                  <span className="text-neutral-500"> · {g.note}</span>
                ) : null}
              </p>
              {g.rows.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {g.rows.map((r) => (
                    <li
                      key={`${r.kind}/${r.name}`}
                      className="flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]"
                    >
                      <span className="text-neutral-500">{r.kind}</span>
                      <span
                        className={
                          r.tone === "bad" ? "text-red-300" : "text-neutral-200"
                        }
                      >
                        {r.name}
                      </span>
                      <span className="text-neutral-500">{r.note}</span>
                    </li>
                  ))}
                </ul>
              ) : g.empty ? (
                <p className="mt-2 flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
                  <span
                    className={
                      g.empty.dashed
                        ? "rounded-md border border-dashed border-neutral-700 px-2 py-0.5 text-neutral-400"
                        : "text-neutral-400"
                    }
                  >
                    {g.empty.label}
                  </span>
                  <span className="text-neutral-500">{g.empty.note}</span>
                </p>
              ) : null}
            </Reveal>
          ))}
        </div>
      </Reveal>
      <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-500">
        The same groups sit in the peek panel, one keystroke from any list, so
        the neighbourhood is read before the page is opened.
      </p>
    </Section>
  );
}
