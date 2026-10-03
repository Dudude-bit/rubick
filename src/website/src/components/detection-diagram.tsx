import type { CSSProperties } from "react";
import { useInView } from "../lib/use-in-view";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function Rail({
  label,
  items,
  caption,
  delay,
}: {
  label: string;
  items: string;
  caption: string;
  delay: number;
}) {
  return (
    <div className="trace-node min-w-0" style={d(delay)}>
      <p className="font-mono text-xs text-neutral-500">{label}</p>
      <p className="mt-1.5 rounded-md border border-neutral-700 px-3 py-2 font-mono text-sm text-neutral-200">
        {items}
      </p>
      <p className="mt-2 text-xs text-neutral-500">{caption}</p>
    </div>
  );
}

export function DetectionDiagram() {
  const ref = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className="mt-10">
      <span className="sr-only">
        Detected integrations come from CRDs and node labels already in the
        cluster. Configured ones come from an address you typed in. Rubick never
        goes looking for an address on its own.
      </span>
      <div
        aria-hidden
        className="grid items-center gap-4 md:grid-cols-[1fr_auto_auto_auto_1fr] md:gap-3"
      >
        <Rail
          label="in the cluster already"
          items="CRDs · node labels"
          caption="detected: nothing to configure, and nothing to get wrong"
          delay={0}
        />
        <span
          className="trace-link hidden h-px w-10 bg-accent md:block"
          style={d(250)}
        />
        <div
          className="trace-node justify-self-center rounded-md border border-accent/60 bg-accent/10 px-4 py-2 font-mono text-sm text-neutral-100"
          style={d(500)}
        >
          Rubick
        </div>
        <span
          className="trace-link hidden h-px w-10 bg-accent md:block [transform-origin:right]"
          style={d(750)}
        />
        <Rail
          label="typed in by you"
          items="Prometheus · Loki"
          caption="configured: an address you gave, never one Rubick guessed"
          delay={1000}
        />
      </div>
    </div>
  );
}
