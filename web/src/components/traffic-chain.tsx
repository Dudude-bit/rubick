import { useState, type CSSProperties, type ReactNode } from "react";
import { useInView } from "../lib/use-in-view";
import { useHydrated } from "../lib/use-hydrated";

const COLUMNS = ["path", "service", "published", "pod"] as const;

type Tone = "neutral" | "ok" | "stop" | "unknown";

type Cell = { label: string; sub?: string; tone: Tone; chip?: boolean };

type Lane = {
  cells: [Cell, Cell, Cell, Cell];
  inspected: 1 | 2 | 3;
  lead: string;
  verdict: string;
  tone: "ok" | "bad";
};

const CHIP: Record<Tone, string> = {
  neutral: "border-neutral-700 text-neutral-200",
  ok: "border-green-400/60 text-green-300",
  stop: "border-red-400/70 text-red-300",
  unknown: "border-dashed border-neutral-700 text-neutral-500",
};

const TEXT: Record<Tone, string> = {
  neutral: "text-neutral-200",
  ok: "text-green-300",
  stop: "text-red-300",
  unknown: "text-neutral-500",
};

const GRID =
  "md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)]";

const LEGACY: Lane = {
  cells: [
    { label: "/legacy", tone: "neutral" },
    { label: "api:80", sub: "targetPort: htp", tone: "neutral", chip: true },
    { label: "no port", tone: "stop" },
    { label: "not inspected", tone: "unknown", chip: true },
  ],
  inspected: 2,
  lead: "Blocked.",
  verdict:
    "Target port htp matches no container, so the addresses are published with no port and the Service stays green.",
  tone: "bad",
};

// The same Service after `kubectl patch`: targetPort http. Read on k3d six
// seconds after the patch; the endpoint controller had published port 80.
const LEGACY_FIXED: Lane = {
  cells: [
    { label: "/legacy", tone: "neutral" },
    {
      label: "api:80",
      sub: "targetPort: http, was htp",
      tone: "neutral",
      chip: true,
    },
    { label: "3 ready · :80", tone: "ok" },
    { label: "api ×3", tone: "ok", chip: true },
  ],
  inspected: 3,
  lead: "Resolved.",
  verdict:
    "One letter. The endpoint controller published port 80 on its next pass, and nothing else changed.",
  tone: "ok",
};

const LANES: Lane[] = [
  {
    cells: [
      { label: "/", tone: "neutral" },
      {
        label: "api-ok:80",
        sub: "targetPort: http",
        tone: "neutral",
        chip: true,
      },
      { label: "3 ready · :80", tone: "ok" },
      { label: "api ×3", tone: "ok", chip: true },
    ],
    inspected: 3,
    lead: "Resolved.",
    verdict: "Every object resolves, all the way to three ready pods.",
    tone: "ok",
  },
  {
    cells: [
      { label: "/checkout", tone: "neutral" },
      {
        label: "checkout:80",
        sub: "targetPort: 8080",
        tone: "neutral",
        chip: true,
      },
      { label: "0 ready", tone: "stop" },
      { label: "checkout", sub: "CrashLoopBackOff", tone: "stop", chip: true },
    ],
    inspected: 3,
    lead: "Blocked.",
    verdict:
      "The one pod behind it crashes on start and has never been Ready, so nothing is published.",
    tone: "bad",
  },
  {
    cells: [
      { label: "/api", tone: "neutral" },
      { label: "api-v2 · missing", tone: "stop", chip: true },
      { label: "not inspected", tone: "unknown" },
      { label: "not inspected", tone: "unknown", chip: true },
    ],
    inspected: 1,
    lead: "Missing.",
    verdict:
      "No Service named api-v2 in this namespace. Inspection stops here.",
    tone: "bad",
  },
];

function CellView({ cell }: { cell: Cell }) {
  const inner: ReactNode = (
    <>
      {cell.label}
      {cell.sub ? (
        <span className="mt-0.5 block text-[11px] text-neutral-500">
          {cell.sub}
        </span>
      ) : null}
    </>
  );
  return cell.chip ? (
    <span
      className={`min-w-0 rounded-md border px-2.5 py-1.5 font-mono text-[13px] leading-tight ${CHIP[cell.tone]}`}
    >
      {inner}
    </span>
  ) : (
    <span
      className={`min-w-0 py-1.5 font-mono text-[13px] leading-tight ${TEXT[cell.tone]}`}
    >
      {inner}
    </span>
  );
}

function LaneView({ lane }: { lane: Lane }) {
  const ref = useInView<HTMLDivElement>("0px 0px -40% 0px");
  return (
    <div
      ref={ref}
      className={`lane flex flex-col md:grid md:items-center md:gap-x-4 ${GRID}`}
      style={{ "--n": lane.inspected } as CSSProperties}
    >
      {lane.cells.map((cell, i) => (
        <div
          key={i}
          className="flex min-w-0 flex-col items-start md:flex-row md:items-center"
        >
          <span className="mb-1 font-mono text-[10px] tracking-wider text-neutral-500 uppercase md:hidden">
            {COLUMNS[i]}
          </span>
          <CellView cell={cell} />
          {i < COLUMNS.length - 1 ? (
            <span
              className="link relative my-1 ml-3 h-4 w-0.5 shrink-0 md:mx-2 md:my-0 md:h-0.5 md:w-auto md:min-w-4 md:flex-1"
              style={{ "--i": i } as CSSProperties}
            >
              <span className="absolute inset-0 border-l-2 border-dashed border-neutral-700 md:border-t-2 md:border-l-0" />
              {i < lane.inspected ? (
                <span className="link-seen absolute inset-0 bg-accent" />
              ) : null}
            </span>
          ) : null}
        </div>
      ))}
      <p className="verdict mt-2 text-sm text-neutral-400 md:col-span-4">
        <b
          className={`font-medium ${lane.tone === "ok" ? "text-green-300" : "text-red-300"}`}
        >
          {lane.lead}
        </b>{" "}
        {lane.verdict}
      </p>
    </div>
  );
}

export function TrafficChain({ className = "" }: { className?: string }) {
  const interactive = useHydrated();
  const [fixed, setFixed] = useState(false);
  return (
    <div className={`chain ${className}`}>
      <p className="sr-only">
        Four paths on host shop.example.test, no middleware. Slash resolves to
        three ready pods through Service api-ok. Slash legacy reaches Service
        api, whose target port name matches no container, so its addresses are
        published with no port. Slash checkout reaches Service checkout, whose
        only pod crashes on start and has never been Ready, so nothing is
        published. Slash api points at Service api-v2, which does not exist in
        this namespace; inspection stops there. Cluster configuration was
        inspected; request delivery was not tested.
      </p>
      <div aria-hidden>
        <p className="font-mono text-sm text-neutral-300">
          shop.example.test
          <span className="text-neutral-500"> · no middleware</span>
        </p>
        <div
          className={`mt-5 hidden gap-x-4 font-mono text-[11px] tracking-wider text-neutral-500 uppercase md:grid ${GRID}`}
        >
          {COLUMNS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-8 md:gap-6">
          <LaneView lane={LANES[0]!} />
          <div className="flex flex-col gap-3">
            <LaneView
              key={fixed ? "fixed" : "broken"}
              lane={fixed ? LEGACY_FIXED : LEGACY}
            />
            {interactive ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setFixed((f) => !f)}
                  className="min-h-9 rounded-md border border-neutral-700 px-3 py-1.5 font-mono text-[13px] text-neutral-200 hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {fixed ? "Put the typo back" : "Fix the port, inspect again"}
                </button>
                <span className="font-mono text-[12px] text-neutral-500">
                  {fixed
                    ? "kubectl patch svc api: targetPort http. Recorded on k3d; this page is not connected to a cluster."
                    : "the same edit, recorded on k3d"}
                </span>
              </div>
            ) : null}
          </div>
          {LANES.slice(1).map((lane) => (
            <LaneView key={lane.cells[0].label} lane={lane} />
          ))}
        </div>
        <p className="mt-6 font-mono text-xs text-neutral-500">
          Cluster configuration inspected. Request delivery not tested.
        </p>
      </div>
    </div>
  );
}
