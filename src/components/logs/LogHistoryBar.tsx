import { Link } from "react-router-dom";

import {
  USAGE_RANGES,
  type CapabilityState,
  type UsageRange,
} from "@/integrations";
import { formatCount } from "./types";
import type { HistoryState } from "./hooks/useLogHistory";
import { useT } from "@/i18n/useT";

/**
 * The one row that says where a pane's oldest lines came from — and, on the
 * three occasions it cannot say that, what is missing instead.
 *
 * It draws only where the reader has just been told there is nothing to
 * read: a pod that is gone, a container that never started, or a workload
 * tab whose reader has asked for a range. Everywhere else it is absent, and
 * that is deliberate — a "connect a Loki" line under every healthy log pane
 * would be an advert repeated a hundred times a day, and the one place it
 * belongs is where the app has just failed to answer.
 *
 * The three states are the whole contract:
 *
 * - **not configured** — the live pane is untouched and one quiet offer sits
 *   under the sentence explaining why there is nothing to read.
 * - **configured and not answering** — the loss is *stated*, with the
 *   supplier's own words for why, and the live pane is still untouched. A
 *   silent fallback here would be indistinguishable from never having
 *   configured one, and the reader would conclude the app lost their logs.
 * - **answering** — an offer, and once taken, an honest account of what came
 *   back: how many lines, over what window, whether the limit cut it off,
 *   and whether anything matched at all.
 */
export function LogHistoryBar({
  capability,
  history,
  /** What the pane cannot answer for on its own, in words. */
  stranded,
  /** Set on a workload tab, where a range is the whole point. */
  ranged,
  held,
  keep,
  selected,
  isPaging,
  onRead,
  onReadOlder,
  onClear,
}: {
  capability: CapabilityState<"logs.history">;
  history: HistoryState;
  /**
   * What the API server has run out of answers for, named — a pod that is
   * gone, or a container that never started. `null` where the live pane is
   * reading perfectly well, which is when no offer is drawn at all.
   */
  stranded: string | null;
  ranged: boolean;
  /**
   * How many of the lines that came back the pane is actually holding.
   *
   * Not the same number as what was fetched, and the difference is the point:
   * history yields to the live stream when `Keep N` is full, so a reader who
   * asks for six hours over a busy workload can be handed a thousand lines
   * and hold none of them. A row that printed the fetched count there would
   * be describing a pane that does not exist.
   */
  held: number;
  /** The buffer's own cap, named in the sentence that says what did not fit. */
  keep: number;
  selected: UsageRange | null;
  isPaging: boolean;
  onRead: (range: UsageRange) => void;
  onReadOlder: () => void;
  onClear: () => void;
}) {
  const t = useT();
  if (stranded === null && !ranged) return null;

  if (capability.state === "absent") {
    // Only beside a real dead end. A workload tab that reads perfectly well
    // from its live pods is not missing anything a reader needs told about.
    if (stranded === null) return null;
    return (
      <Bar tone="fnt" testId="log-history-absent">
        <p>
          {t("empty", "historyApiExhausted", { target: stranded })}{" "}
          <Link to="/integrations" className="text-info hover:underline">
            {t("action", "connectOne")}
          </Link>
          .
        </p>
      </Bar>
    );
  }

  if (capability.state === "unreachable") {
    return (
      <Bar tone="warn" testId="log-history-unreachable">
        <p>
          {t("empty", "historyVendorUnreachable", {
            vendor: capability.vendor,
            reason: capability.reason,
          })}
        </p>
      </Bar>
    );
  }

  const from = capability.endpoint || capability.vendor;

  if (history.state === "loading") {
    return (
      <Bar tone="mut" testId="log-history-loading">
        <p>
          {t("empty", "historyReadingVendor", { vendor: capability.vendor })}
        </p>
      </Bar>
    );
  }

  if (history.state === "failed") {
    return (
      <Bar tone="err" testId="log-history-failed">
        <p>
          {t("empty", "historyVendorFailed", {
            vendor: capability.vendor,
            reason: history.reason,
          })}
        </p>
        {selected && (
          <Act onClick={() => onRead(selected)}>{t("action", "askAgain")}</Act>
        )}
      </Bar>
    );
  }

  if (history.state === "idle") {
    return (
      <Bar tone="mut" testId="log-history-offer">
        <p>
          {stranded !== null
            ? t("empty", "historyApiExhaustedShort", { target: stranded })
            : t("empty", "historyOlderThanPods")}{" "}
          {t("empty", "historyVendorMayHave", { vendor: capability.vendor })}
        </p>
        {stranded !== null && (
          <Act onClick={() => onRead(DEFAULT_RANGE)}>
            {t("action", "readWhatVendorKept", { vendor: capability.vendor })}
          </Act>
        )}
        {ranged && <Ranges selected={null} onSelect={onRead} />}
      </Bar>
    );
  }

  const { loaded } = history;
  const dropped = loaded.count - held;

  // Not one stream matched — which is a different fact from a quiet pod, and
  // the only one of the two the reader can do anything about. The label
  // names are the likely cause and are printed rather than described: an
  // install that relabels `pod` to `pod_name` answers every query here with
  // nothing, and an empty pane would read as "this pod never logged".
  if (loaded.unmatched) {
    return (
      <Bar tone="warn" testId="log-history-unmatched">
        <p>
          {t(
            "empty",
            ranged ? "historyUnmatchedWorkload" : "historyUnmatchedPod",
            {
              vendor: capability.vendor,
              labels: loaded.labelsTried.join("/"),
              range: loaded.range,
            }
          )}
        </p>
        {ranged && <Ranges selected={selected} onSelect={onRead} />}
      </Bar>
    );
  }

  return (
    <Bar tone="mut" testId="log-history-loaded">
      <p>
        {/* "History" first, because the single most dangerous thing this
            pane could do is let a reader take an hour-old line for a live
            one while they are watching a rollout. */}
        <span className="text-info">{t("action", "history")}</span> ·{" "}
        {formatCount(held)} {t("count", "lineNoun", { n: held })}{" "}
        {t("empty", "historyLoadedSummary", {
          from,
          range: loaded.range,
          follow: t("action", "follow"),
        })}
      </p>
      {dropped > 0 && (
        <p className="text-warn" data-testid="log-history-crowded">
          {t("count", "historyMoreNotHeld", {
            n: dropped,
            count: formatCount(dropped),
            keep: formatCount(keep),
          })}
        </p>
      )}
      {loaded.truncated && (
        <p className="text-warn" data-testid="log-history-truncated">
          {t("count", "historyTruncated", {
            n: loaded.limit,
            count: formatCount(loaded.limit),
          })}
        </p>
      )}
      {loaded.older !== null && (
        <Act onClick={onReadOlder} disabled={isPaging}>
          {isPaging ? t("action", "reading") : t("action", "loadOlder")}
        </Act>
      )}
      {ranged && <Ranges selected={selected} onSelect={onRead} />}
      <Act onClick={onClear}>{t("action", "hideHistory")}</Act>
    </Bar>
  );
}

/** The window a stranded pod is asked about without being asked which. */
const DEFAULT_RANGE: UsageRange = "1h";

/**
 * The same four words the usage chart offers, because "the last six hours"
 * must mean one thing in this app rather than one thing per pane.
 */
function Ranges({
  selected,
  onSelect,
}: {
  selected: UsageRange | null;
  onSelect: (range: UsageRange) => void;
}) {
  const t = useT();
  return (
    <span className="ml-auto flex items-center gap-0.5">
      {USAGE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={selected === range}
          onClick={() => onSelect(range)}
          title={t("action", "readTheLast", { range })}
          className={
            selected === range
              ? "rounded bg-sel px-1.5 py-0.5 text-[11px] text-fg"
              : "rounded px-1.5 py-0.5 text-[11px] text-fg-mut hover:bg-hover hover:text-fg"
          }
        >
          {range}
        </button>
      ))}
    </span>
  );
}

const TONES = {
  warn: "text-warn",
  err: "text-err",
  mut: "text-fg-mut",
  fnt: "text-fg-fnt",
} as const;

function Bar({
  tone,
  testId,
  children,
}: {
  tone: keyof typeof TONES;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid={testId ?? "log-history"}
      className={`flex flex-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair px-3 py-1.5 text-[11px] ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}

function Act({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-info hover:bg-hover disabled:opacity-50"
    >
      {children}
    </button>
  );
}
