import { useMemo } from "react";
import type { LogFormat } from "@/generated/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FORMAT_DESCRIPTIONS,
  formatCount,
  termLabel,
  type QueryTerm,
  type StreamedLogLine,
} from "./types";
import { useT } from "@/i18n/useT";

/**
 * Lines the rate is measured over. Long enough that one slow second does
 * not read as a stall, short enough that a burst is still visible as one.
 */
const RATE_SAMPLE = 400;

interface LogStatusBarProps {
  logs: StreamedLogLine[];
  /** Lines held right now, and the cap they are held against. */
  retained: number;
  limit: number;
  /** Rows drawn after filtering and grouping. */
  shownCount: number;
  /** Lines the filter removed and lines standing behind a collapsed run. */
  hiddenCount: number;
  /** The terms being kept at the source, as the stream is running them. */
  intake: QueryTerm[];
  /** The ids bounding the last unfiltered stretch — see the rates below. */
  intakeFrom: number;
  unfilteredFrom: number;
  isStreaming: boolean;
}

/**
 * What the buffer actually holds, said out loud.
 *
 * The fill meter is the part that matters: a number climbing towards a cap
 * is easy to read as a total, and the bar going solid is the moment the
 * pane stops being the whole log. The format is stated once here rather
 * than badged onto every line of a stream that only ever has one.
 */
export function LogStatusBar({
  logs,
  retained,
  limit,
  shownCount,
  hiddenCount,
  intake,
  intakeFrom,
  unfilteredFrom,
  isStreaming,
}: LogStatusBarProps) {
  const t = useT();
  const formatInfo = useMemo(() => describeFormat(logs, t), [logs, t]);
  const rate = useMemo(() => measureRate(logs), [logs]);
  const fill = limit > 0 ? Math.min(100, (retained / limit) * 100) : 0;

  const intakeKey = intake.map(termLabel).join(` ${t("empty", "listAnd")} `);

  /**
   * Both sides of the discard, read off the one buffer.
   *
   * Lines intake rejects are dropped in Rust and never reach this
   * process, so the arriving rate cannot be measured while intake is on.
   * It does not have to be: the lines between `unfilteredFrom` and
   * `intakeFrom` arrived while nothing was being discarded and are
   * still here, so they are the evidence for the full rate. Above
   * `intakeFrom` are the kept ones. A sample straddling the two would report the
   * old rate for as long as it took to refill, which is the one reading
   * that would make the discard look like it never happened.
   */
  const { kept, arriving } = useMemo(
    () =>
      intakeKey === ""
        ? { kept: null, arriving: null }
        : {
            kept: measureRate(logs, intakeFrom),
            arriving: measureRate(logs, unfilteredFrom, intakeFrom - 1),
          },
    [intakeKey, logs, intakeFrom, unfilteredFrom]
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-hair px-3 py-1 text-[11px] text-fg-mut">
      <span className="whitespace-nowrap">
        {formatCount(retained)}{" "}
        <span className="text-fg-fnt">
          {t("count", "ofLimitKept", { limit: formatCount(limit) })}
        </span>
      </span>
      <span
        className="h-[3px] w-14 overflow-hidden rounded-sm bg-hair"
        role="meter"
        aria-valuenow={retained}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={t("action", "bufferFill")}
      >
        <span
          className={`block h-full ${fill >= 100 ? "bg-warn" : "bg-fg-fnt"}`}
          style={{ width: `${fill}%` }}
        />
      </span>
      {formatInfo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help whitespace-nowrap text-fg-fnt">
              {formatInfo.label}
              {/* Under intake this rate would be the kept one, said
                  twice; the segment beside it says both instead. */}
              {intakeKey === "" &&
                rate !== null &&
                ` · ${t("count", "linesPerSecond", { rate: formatRate(rate) })}`}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{formatInfo.description}</TooltipContent>
        </Tooltip>
      )}

      {intakeKey !== "" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help whitespace-nowrap text-info">
              <span aria-hidden="true">⇣ </span>
              {t("action", "intake")} {intakeKey} ·{" "}
              {kept !== null
                ? `${t("count", "keptPerSecond", { rate: formatRate(kept) })}${
                    arriving === null
                      ? ""
                      : t("count", "ofPerSecond", {
                          rate: formatRate(arriving),
                        })
                  }`
                : arriving !== null
                  ? t("count", "arrivingBefore", { rate: formatRate(arriving) })
                  : t("action", "keepingOnlyMatches")}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {t("empty", "intakeDiscardNote")}
            {arriving !== null &&
              t("empty", "intakeArrivingRate", { rate: formatRate(arriving) })}
            .
          </TooltipContent>
        </Tooltip>
      )}
      <span className="ml-auto whitespace-nowrap text-fg-fnt">
        {t("count", "shown", { n: formatCount(shownCount) })}
        {hiddenCount > 0 &&
          ` · ${t("count", "hiddenByFilter", { n: formatCount(hiddenCount) })}`}
      </span>
      {isStreaming && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok"
          />
          {t("action", "streaming")}
        </span>
      )}
    </div>
  );
}

function describeFormat(logs: StreamedLogLine[], t: ReturnType<typeof useT>) {
  if (logs.length === 0) return null;

  const counts = new Map<LogFormat, number>();
  for (const log of logs) {
    const format = log.format ?? "plain";
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }

  let dominant: LogFormat = "plain";
  let best = 0;
  for (const [format, count] of counts) {
    if (count > best) {
      best = count;
      dominant = format;
    }
  }

  if (counts.size === 1) {
    return {
      label: dominant,
      description: FORMAT_DESCRIPTIONS[dominant],
    };
  }

  const share = Math.round((best / logs.length) * 100);
  if (share >= 90) {
    return {
      label: `${dominant} (${share}%)`,
      description: FORMAT_DESCRIPTIONS[dominant],
    };
  }
  return {
    label: t("action", "mixedFormat"),
    description: t("empty", "mixedFormatNote"),
  };
}

/**
 * Lines per second over the tail of the buffer, from the timestamps the
 * lines carry rather than from arrival: a backfill of five thousand lines
 * arrives in one batch, and reporting that as the rate would say the pod
 * is writing a hundred thousand lines a second the moment the pane opens.
 */
function measureRate(
  logs: StreamedLogLine[],
  /** Ids to measure between, both ends inclusive. See the caller. */
  fromId = 0,
  toId = Number.MAX_SAFE_INTEGER
): number | null {
  // Ids ascend with arrival, so the window is a slice and finding it is
  // a walk back from the end rather than a pass over the buffer.
  let end = logs.length - 1;
  while (end >= 0 && logs[end].id > toId) end--;
  if (end < 0) return null;
  let start = end;
  while (
    start > 0 &&
    logs[start - 1].id >= fromId &&
    end - start + 1 < RATE_SAMPLE
  ) {
    start--;
  }
  if (end - start < 1) return null;
  const span = logs[end].epoch - logs[start].epoch;
  if (span <= 0) return null;
  return ((end - start) / span) * 1000;
}

/**
 * A decimal below ten, none above. A quiet pod runs at well under one line
 * a second, and rounding that to "1" or "0" is the difference between a
 * reading and a shrug.
 */
function formatRate(rate: number): string {
  return rate < 10 ? rate.toFixed(1) : formatCount(Math.round(rate));
}
