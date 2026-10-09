import type { ContainerInfo } from "@/generated/types";
import { PHASE_LABEL } from "@/lib/container-sequence";

import { formatCount } from "@/lib/count";
import { useT } from "@/i18n/useT";
import { CHIP_WORD, type LaneReading } from "./readings";

/** One chip of the legend: a container of one pod, or a pod of a workload. */
export interface LegendEntry {
  key: string;
  label: string;
  phase?: ContainerInfo["phase"];
  gone?: boolean;
  reading?: LaneReading;
}

interface LogLegendProps {
  entries: LegendEntry[];
  colors: Map<string, string>;
  /** Lines received per entry, by key. */
  counts: Map<string, number>;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Everything else off, or everything back on when it is already alone. */
  onSolo: (key: string) => void;
  onShowAll: () => void;
  /** Drawn after the chips: a coverage sentence, a label-mode control. */
  trailing?: React.ReactNode;
}

export function LogLegend({
  entries,
  colors,
  counts,
  hidden,
  onToggle,
  onSolo,
  onShowAll,
  trailing,
}: LogLegendProps) {
  const t = useT();
  if (entries.length === 0) return null;

  const shown = entries.filter((entry) => !hidden.has(entry.key));
  const soloed = shown.length === 1 ? shown[0].key : null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-2 py-1 text-[11px]"
      data-testid="log-legend"
    >
      {entries.map(({ key, label, phase, gone, reading }, index) => {
        const off = hidden.has(key);
        const solo = soloed === key;
        const word = reading ? CHIP_WORD[reading.reading] : null;
        const count = counts.get(key) ?? 0;
        // A hairline where the phase changes: an init container and an
        // app container are not two entries in one list, they are two
        // parts of the pod's life.
        const divides =
          index > 0 &&
          phase !== undefined &&
          entries[index - 1].phase !== phase;
        return (
          <span key={key} className="flex items-center">
            {divides && (
              <span
                aria-hidden="true"
                className="mx-1.5 h-3 w-px bg-hair"
                data-testid="log-legend-divider"
              />
            )}
            <button
              type="button"
              aria-pressed={!off}
              aria-keyshortcuts={index < 9 ? `${index + 1}` : undefined}
              title={`${
                off
                  ? t("action", "legendShow", { name: label })
                  : t("action", "legendHide", { name: label })
              }. ${t("action", "legendSoloHint", { name: label })}${
                index < 9
                  ? t("action", "legendOrPress", { key: index + 1 })
                  : ""
              }.`}
              onClick={(event) => (event.altKey ? onSolo(key) : onToggle(key))}
              onDoubleClick={() => onSolo(key)}
              className={`inline-flex items-center gap-1.5 rounded py-0.5 pl-1 pr-1.5 hover:bg-hover ${
                solo ? "bg-sel text-fg" : off ? "text-fg-fnt" : "text-fg-mut"
              } ${gone ? "line-through decoration-hair" : ""}`}
            >
              <span
                aria-hidden="true"
                className={`h-3 w-[3px] rounded-sm ${off ? "opacity-25" : ""}`}
                style={{ background: colors.get(key) }}
              />
              {label}
              {phase && PHASE_LABEL[phase] && (
                <span className="text-[9px] uppercase tracking-[0.04em] text-fg-fnt">
                  {PHASE_LABEL[phase]}
                </span>
              )}
              {/* What has arrived, not what the container wrote — a
                  stream still backfilling counts up. */}
              <span className="font-mono text-[10px] text-fg-fnt">
                {formatCount(count)}
              </span>
              {gone && !word && (
                <span className="text-fg-fnt">{t("action", "legendGone")}</span>
              )}
              {reading && word && (
                <span
                  className={
                    reading.reading === "lost" ? "text-err" : "text-warn"
                  }
                  title={reading.note ?? undefined}
                >
                  {"\u00b7 "}
                  {t("empty", word)}
                </span>
              )}
            </button>
          </span>
        );
      })}
      {/* Dimming a chip is a quiet way to say "withheld", and on a row of
          nine chips a dim one is easy to miss; the count is loud. */}
      {hidden.size > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-1 rounded px-1.5 py-0.5 text-warn hover:bg-hover"
        >
          {t("count", "hiddenShowAll", { n: hidden.size })}
        </button>
      )}
      {trailing}
    </div>
  );
}
