import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { errorToShow } from "@/lib/error-utils";

import { useT } from "@/i18n/useT";
import { formatCount } from "./types";

/** Ragged bars at log-line rhythm — the shape the output will land in. */
const SKELETON_WIDTHS = [
  "w-[78%]",
  "w-[54%]",
  "w-[88%]",
  "w-[41%]",
  "w-[70%]",
  "w-[62%]",
  "w-[84%]",
  "w-[48%]",
];

function LogSkeleton() {
  return (
    <div
      className="space-y-1.5 p-2"
      aria-hidden="true"
      data-testid="log-skeleton"
    >
      {SKELETON_WIDTHS.map((width, index) => (
        <Skeleton key={index} className={`h-2.5 ${width}`} />
      ))}
    </div>
  );
}

/** Why there is nothing to read: five different silences, said apart. */
export function EmptyState({
  failed,
  connecting,
  streaming,
  retained,
  filtered,
  settling,
  intake,
  allHidden,
  noPods = false,
  podsUnread,
  lanes = false,
  onClearQuery,
  onShowAll,
}: {
  failed: boolean;
  connecting: boolean;
  streaming: boolean;
  retained: number;
  filtered: boolean;
  /** The query is still being walked over the buffer: no verdict yet. */
  settling: boolean;
  /** Set, so "received" and "kept" are no longer the same number. */
  intake: boolean;
  allHidden: boolean;
  /** A workload pane with nothing to read from yet. */
  noPods?: boolean;
  /** The pod list failed to read, so `noPods` says nothing about the cluster. */
  podsUnread?: unknown;
  /** A workload pane: what is hidden is a pod, not a container. */
  lanes?: boolean;
  onClearQuery: () => void;
  onShowAll: () => void;
}) {
  const t = useT();

  if (podsUnread)
    return (
      <Note>
        {t("empty", "podsUnread", { reason: errorToShow(podsUnread) })}
      </Note>
    );

  if (noPods) return <Note>{t("empty", "noPodsToStream")}</Note>;

  // The failure notice above already said what happened; a second verdict
  // under it would only compete with it. `failed` is whether a notice is
  // being drawn, not whether anything failed: a workload pane draws no
  // notice for a lane that ended, and would otherwise leave a scroll area
  // with no words in it at all.
  if (failed && retained === 0) return null;

  // Lines, not a spinner: the shape the output will take says "this is a
  // log about to arrive" where a spinner says only "wait".
  if (connecting && retained === 0) return <LogSkeleton />;

  if (allHidden) {
    return (
      <Note>
        {lanes
          ? t("empty", "everyLaneHidden")
          : t("empty", "everyContainerHidden")}
        <span className="text-fg-fnt">
          {" "}
          {t("count", "linesBufferedBehindLegend", {
            n: retained,
            count: formatCount(retained),
          })}
        </span>
        <Action onClick={onShowAll}>
          {lanes
            ? t("action", "showAllLanes")
            : t("action", "showAllContainers")}
        </Action>
      </Note>
    );
  }

  // An empty view mid-walk is "not looked yet", and drawing it as "no line
  // matches" would be the verdict before the evidence.
  if (settling && retained > 0) {
    return (
      <Note>
        {t("empty", "filteringLines", {
          n: retained,
          count: formatCount(retained),
        })}
      </Note>
    );
  }

  if (retained > 0) {
    return (
      <Note>
        {filtered
          ? t("empty", "noLineMatchesQuery")
          : t("empty", "nothingLeftToShow")}
        <span className="text-fg-fnt">
          {" "}
          {/* Under intake these are not the lines the container wrote:
              the rest were discarded before they got here, and clearing
              the query cannot bring them back. */}
          {intake
            ? t("count", "linesKept", {
                n: retained,
                count: formatCount(retained),
              })
            : t("count", "linesReceived", {
                n: retained,
                count: formatCount(retained),
              })}
        </span>
        {filtered && (
          <Action onClick={onClearQuery}>{t("action", "clearQuery")}</Action>
        )}
      </Note>
    );
  }

  if (streaming) {
    return (
      <Note>
        {t("empty", "noOutputYet")}
        {/* Safe to claim the stream is attached: a stream that dies emits
            `stream-failed`, which replaces this with the notice above. */}
        <span className="text-fg-fnt">
          {" "}
          {t("empty", "streamAttachedNothingWritten")}
        </span>
      </Note>
    );
  }

  return (
    <Note>
      {t("empty", "notStreaming")}
      <span className="text-fg-fnt"> {t("empty", "useStreamControl")}</span>
    </Note>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-xs text-fg-mut">{children}</div>;
}

function Action({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 block w-full text-center text-xs text-info hover:underline"
    >
      {children}
    </button>
  );
}
