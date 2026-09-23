import { useT } from "@/i18n/useT";
import type { LaneLabelMode, LaneRule } from "./lanes";

/**
 * How much of the workload the pane is reading, in numbers the lanes
 * alone cannot say: streams attached, streams refused, pods gone whose
 * lines are kept. Beside it, what a lane stands for and how a line
 * names its pod.
 */
export function LaneCoverage({
  coverage,
  paused,
  rule,
  mode,
  onModeChange,
}: {
  coverage: { total: number; streaming: number; refused: number; gone: number };
  /** Nothing is attached because the reader stopped it, which is not a gap. */
  paused: boolean;
  rule: LaneRule;
  mode: LaneLabelMode;
  onModeChange: (mode: LaneLabelMode) => void;
}) {
  const t = useT();
  const ruleWord = {
    pod: "laneRulePod",
    ordinal: "laneRuleOrdinal",
    node: "laneRuleNode",
    run: "laneRuleRun",
  } as const;
  const modes = [
    ["colour", "laneLabelColour"],
    ["short", "laneLabelShort"],
    ["full", "laneLabelFull"],
  ] as const;
  return (
    <span
      className="ml-auto flex flex-wrap items-center gap-x-2 text-fg-fnt"
      data-testid="log-lane-coverage"
    >
      <span>
        {[
          paused
            ? t("count", "podsPaused", { n: coverage.total })
            : t("count", "podsStreaming", {
                streaming: coverage.streaming,
                n: coverage.total,
              }),
          coverage.refused > 0
            ? t("count", "podsUnreadable", { n: coverage.refused })
            : null,
          coverage.gone > 0
            ? t("count", "podsGoneKept", { n: coverage.gone })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="font-mono">{t("action", ruleWord[rule])}</span>
      <span
        className="flex h-5 items-center gap-px rounded-md border border-hair p-px"
        role="group"
        aria-label={t("action", "laneLabelHint")}
        title={t("action", "laneLabelHint")}
      >
        {modes.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onModeChange(value)}
            className={`flex h-full items-center rounded px-1.5 text-[10px] ${
              mode === value
                ? "bg-sel text-fg"
                : "text-fg-mut hover:bg-hover hover:text-fg"
            }`}
          >
            {t("action", label)}
          </button>
        ))}
      </span>
    </span>
  );
}
