import type { CSSProperties } from "react";
import { useInView } from "../../lib/use-in-view";

export function TruthSwap({
  reported,
  observed,
  delay = 0,
}: {
  reported: string;
  observed: string;
  delay?: number;
}) {
  const ref = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-sm"
      style={{ "--d": `${delay}ms` } as CSSProperties}
    >
      <span className="sr-only">
        Reported: {reported}. Observed: {observed}.
      </span>
      <span
        aria-hidden
        className="truth-said inline-flex items-center gap-2 text-neutral-500 line-through decoration-red-400"
      >
        <span className="size-1.5 rounded-full bg-current" />
        {reported}
      </span>
      <span aria-hidden className="truth-conn h-px w-8 shrink-0 bg-accent" />
      <span
        aria-hidden
        className="truth-seen inline-flex items-center gap-2 text-red-300"
      >
        <span className="size-1.5 rounded-full bg-red-400" />
        {observed}
      </span>
    </div>
  );
}
