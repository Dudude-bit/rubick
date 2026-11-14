/**
 * Which sources this Prometheus has series for, and for each the words of
 * what it found, what it could not read, and what it cannot see.
 */
import { useT } from "@/i18n/useT";
import type { FlowSource, TrafficReading } from "@/lib/traffic";
import { cn } from "@/lib/utils";
import { MEASURE_WORD, SOURCE_STATE_WORD } from "./traffic-words";

const STATE_TONE = {
  present: "text-ok",
  absent: "text-fg-fnt",
  unpaired: "text-warn",
  failed: "text-err",
} as const satisfies Record<FlowSource["state"]["says"], string>;

export function SourceRail({
  sources,
  reading,
}: {
  sources: readonly FlowSource[];
  reading: TrafficReading | null;
}) {
  const t = useT();
  return (
    <aside
      className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto scrollbar-lane rounded-lg border border-hair p-2 text-[12px]"
      aria-label={t("traffic", "sources")}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-fg-fnt">
        {t("traffic", "sources")}
      </p>
      {sources.map((source) => {
        const index =
          reading?.sources.findIndex((each) => each.id === source.id) ?? -1;
        const failed =
          index < 0
            ? []
            : reading!.answer.reads.filter(
                (read) => read.source === index && read.state.says === "failed"
              );
        const coverage = reading?.answer.coverage.find(
          (each) => each.source === index
        );
        return (
          <section key={source.id} className="flex flex-col gap-0.5">
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-fg">{source.name}</span>
              <span
                className={cn("text-[11px]", STATE_TONE[source.state.says])}
              >
                {t("traffic", SOURCE_STATE_WORD[source.state.says], {
                  said: source.state.says === "failed" ? source.state.said : "",
                })}
              </span>
            </p>
            {source.state.says === "present" && (
              <p className="break-all font-mono text-[11px] text-fg-mut">
                {source.found.join(", ")}
              </p>
            )}
            {failed.map((read) => (
              <p key={read.measure} className="text-[11px] text-err">
                {t("traffic", "measureFailed", {
                  measure: t("traffic", MEASURE_WORD[read.measure]),
                  said: read.state.says === "failed" ? read.state.message : "",
                })}
              </p>
            ))}
            {coverage && (
              <p className="text-[11px] text-fg-mut">
                {t("traffic", "coverage", {
                  source: source.name,
                  marked: coverage.marked,
                  partly: coverage.partly,
                  of: t("count", "ofWorkloads", { n: coverage.workloads }),
                })}
              </p>
            )}
            {source.state.says === "present" && source.nodeAgent && (
              <p className="text-[11px] text-fg-fnt">
                {t("traffic", "nodeAgent", { source: source.name })}
              </p>
            )}
            {source.state.says !== "present" && (
              <p className="text-[11px] text-fg-fnt">
                {t("traffic", source.need)}
              </p>
            )}
          </section>
        );
      })}
    </aside>
  );
}
