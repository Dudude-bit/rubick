import type { CSSProperties } from "react";
import { useInView } from "../../lib/use-in-view";

const STEP_MS = 420;

const NODE = {
  neutral: "border-neutral-700 text-neutral-200",
  bad: "border-red-400/70 text-red-300",
  warn: "border-amber-400/70 text-amber-200",
} as const;

const LINK = {
  neutral: "bg-accent",
  bad: "bg-red-400",
  warn: "bg-amber-400",
} as const;

export type TraceStep = { label: string; tone?: keyof typeof NODE };

export function Trace({
  steps,
  linkTone = "neutral",
  reason,
}: {
  steps: TraceStep[];
  linkTone?: keyof typeof LINK;
  reason?: string;
}) {
  const ref = useInView<HTMLDivElement>();
  const lastLink = steps.length - 2;
  return (
    <div ref={ref} className="font-mono text-sm">
      <span className="sr-only">
        {steps.map((s) => s.label).join(", then ")}
        {reason ? `. ${reason}` : ""}
      </span>
      <div aria-hidden className="flex flex-wrap items-center gap-y-3">
        {steps.map((s, i) => (
          <span key={s.label} className="flex items-center">
            <span
              className={`trace-node rounded-md border px-2.5 py-1 ${NODE[s.tone ?? "neutral"]}`}
              style={{ "--d": `${i * STEP_MS}ms` } as CSSProperties}
            >
              {s.label}
            </span>
            {i <= lastLink ? (
              <span
                className={`trace-link mx-1.5 h-px w-6 shrink-0 sm:w-10 ${i === lastLink && reason ? LINK[linkTone] : "bg-accent"}`}
                style={{ "--d": `${i * STEP_MS + 200}ms` } as CSSProperties}
              />
            ) : null}
          </span>
        ))}
      </div>
      {reason ? (
        <p
          aria-hidden
          className={`trace-reason mt-2 text-xs ${linkTone === "warn" ? "text-amber-200/90" : "text-red-300/90"}`}
          style={
            { "--d": `${steps.length * STEP_MS + 100}ms` } as CSSProperties
          }
        >
          {reason}
        </p>
      ) : null}
    </div>
  );
}
