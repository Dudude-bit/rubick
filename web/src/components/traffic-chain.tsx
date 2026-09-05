import type { CSSProperties } from "react";
import { useScrollProgress } from "../lib/use-scroll-progress";

const COLUMNS = [
  "entry point",
  "rule",
  "middleware",
  "service",
  "published",
  "pod",
] as const;

type Tone = "neutral" | "none" | "ok" | "stop" | "unknown";

type Node = { label: string; sub?: string; tone: Tone };

type Lane = {
  path: string;
  stopAt: number | null;
  nodes: Node[];
  verdict: string;
  tone: "ok" | "bad";
};

const NODE: Record<Tone, string> = {
  neutral: "border-neutral-700 text-neutral-200",
  none: "border-neutral-800 text-neutral-500",
  ok: "border-green-400/60 text-green-300",
  stop: "border-red-400/70 text-red-300",
  unknown: "border-dashed border-neutral-700 text-neutral-500",
};

const LANES: Lane[] = [
  {
    path: "/",
    stopAt: null,
    nodes: [
      { label: "shop.example.test", tone: "neutral" },
      { label: "/ → api-ok", tone: "neutral" },
      { label: "none", tone: "none" },
      { label: "api-ok :80", sub: "targetPort: http", tone: "neutral" },
      { label: "3 ready, port 80", tone: "ok" },
      { label: "api ×3", tone: "ok" },
    ],
    verdict:
      "Every object resolves, all the way to three ready pods. Delivery itself is not tested: this is what the cluster wrote, not a request that got through.",
    tone: "ok",
  },
  {
    path: "/legacy",
    stopAt: 4,
    nodes: [
      { label: "shop.example.test", tone: "neutral" },
      { label: "/legacy → api", tone: "neutral" },
      { label: "none", tone: "none" },
      { label: "api :80", sub: "targetPort: htp", tone: "neutral" },
      {
        label: "published with no port",
        sub: '"htp" matches no container',
        tone: "stop",
      },
      { label: "not inspected", tone: "unknown" },
    ],
    verdict:
      "The same three pods, one letter apart. The endpoint controller publishes their addresses with no port, so nothing reaches them, and the Service stays green.",
    tone: "bad",
  },
  {
    path: "/api",
    stopAt: 3,
    nodes: [
      { label: "shop.example.test", tone: "neutral" },
      { label: "/api → api-v2", tone: "neutral" },
      { label: "none", tone: "none" },
      {
        label: "No Service named api-v2",
        sub: "in this namespace",
        tone: "stop",
      },
      { label: "not inspected", tone: "unknown" },
      { label: "not inspected", tone: "unknown" },
    ],
    verdict:
      "0 published, no service to send to. Nothing past the missing Service was looked at, so nothing past it is drawn as broken either.",
    tone: "bad",
  },
];

const at = (i: number) => ({ "--i": i }) as CSSProperties;

export function TrafficChain({ className = "" }: { className?: string }) {
  const ref = useScrollProgress<HTMLDivElement>();
  return (
    <div ref={ref} className={`chain ${className}`}>
      <p className="sr-only">
        Three paths on one host. Slash reaches three ready pods through Service
        api-ok. Slash legacy reaches Service api, whose target port name matches
        no container, so its addresses are published with no port. Slash api
        points at Service api-v2, which does not exist in this namespace;
        nothing past it was looked at.
      </p>
      <div aria-hidden className="flex flex-col gap-8 md:gap-5">
        <div className="hidden gap-x-3 font-mono text-[11px] tracking-wider text-neutral-500 uppercase md:grid md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1.35fr)_minmax(0,0.8fr)]">
          {COLUMNS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        {LANES.map((lane) => (
          <div
            key={lane.path}
            className="lane flex flex-col md:grid md:items-center md:gap-x-3 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1.35fr)_minmax(0,0.8fr)]"
          >
            {lane.nodes.map((n, i) => {
              const inspected = lane.stopAt === null || i < lane.stopAt;
              return (
                <div
                  key={i}
                  className="flex min-w-0 flex-col items-start md:flex-row md:items-center"
                >
                  <span className="mb-1 font-mono text-[10px] tracking-wider text-neutral-500 uppercase md:hidden">
                    {COLUMNS[i]}
                  </span>
                  <span
                    className={`node min-w-0 rounded-md border px-2.5 py-1.5 font-mono text-[13px] leading-tight ${NODE[n.tone]}`}
                  >
                    {n.label}
                    {n.sub ? (
                      <span className="mt-0.5 block text-[11px] text-neutral-500">
                        {n.sub}
                      </span>
                    ) : null}
                  </span>
                  {i < COLUMNS.length - 1 ? (
                    <span
                      className="link relative my-1 ml-4 h-4 w-0.5 shrink-0 md:mx-1.5 md:my-0 md:ml-1.5 md:h-0.5 md:w-auto md:min-w-4 md:flex-1"
                      style={at(i)}
                    >
                      <span className="absolute inset-0 border-l-2 border-dashed border-neutral-700 md:border-t-2 md:border-l-0" />
                      {inspected ? (
                        <span className="link-seen absolute inset-0 bg-accent" />
                      ) : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
            <p
              className={`verdict mt-3 font-mono text-sm md:col-span-6 ${lane.tone === "ok" ? "text-green-300/90" : "text-red-300/90"}`}
            >
              {lane.verdict}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
