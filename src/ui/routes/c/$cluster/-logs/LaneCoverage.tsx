import type { en } from "@/i18n/catalogue";
import { useT } from "@/i18n/useT";
import type { LaneLabelMode, LaneRule } from "./lanes";
import type { StreamReading } from "./readings";

export function LaneCoverage({
  coverage,
  paused,
  rule,
  mode,
  onModeChange,
}: {
  coverage: {
    podsRead: boolean;
    total: number;
    counts: Record<StreamReading, number>;
    gone: number;
  };
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
  const { counts } = coverage;
  const of = (clause: keyof typeof en.count, n: number, warn: boolean) =>
    n > 0 ? ([t("count", clause, { n }), warn] as const) : null;
  const clauses = [
    !coverage.podsRead
      ? ([t("empty", "podListUnread"), true] as const)
      : paused
        ? ([t("count", "podsPaused", { n: coverage.total }), false] as const)
        : ([
            t("count", "podsStreaming", {
              streaming: counts.streaming,
              n: coverage.total,
            }),
            false,
          ] as const),
    of("podsFinished", counts.ended + counts.read, false),
    of("podsRestarting", counts.restarting, true),
    of("podsNotFollowed", counts.notFollowed, true),
    of("podsNotStarted", counts.notStarted, true),
    of("podsUnreadable", counts.lost + counts.notKept, true),
    of("podsNoEarlierRun", counts.absent, false),
    of("podsGoneKept", coverage.gone, false),
  ].filter((clause) => clause !== null);
  return (
    <span
      className="ml-auto flex flex-wrap items-center gap-x-2 text-fg-fnt"
      data-testid="log-lane-coverage"
    >
      <span>
        {clauses.map(([text, unread], i) => (
          <span key={i}>
            {i > 0 && " · "}
            <span className={unread ? "text-warn" : undefined}>{text}</span>
          </span>
        ))}
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
