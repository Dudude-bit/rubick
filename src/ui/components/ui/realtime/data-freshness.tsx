/**
 * What the numbers on this screen are worth right now.
 *
 * This used to render a green "Live" the moment any data existed, which
 * made it a decoration rather than a reading: it said "Live" over a
 * disconnected cluster and over screens that have no watch at all and
 * merely re-read on a timer. Five states, five words, and a shape as
 * well as a colour — a reader who cannot see the hue still gets the
 * answer from the ring and the label.
 *
 * The fourth word is "slowed", and it is the reason this component was
 * touched at all. Screens that have stopped changing now re-read less
 * often (see `lib/refresh`), which is only allowed because the badge says
 * so: a backed-off screen under a word that means "as it happens" is the
 * exact class of lie this indicator was written to remove. So the age
 * comes onto the face of it, the way it does when offline — those are the
 * two states where how old the number is changes what to do with it.
 *
 * @module components/ui/realtime/data-freshness
 */

import { memo } from "react";
import { Lock } from "lucide-react";

import { useHeaderFolded } from "@/components/ui/header-folded";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LIST_DEADLINE_SECONDS, SLOW_READ_MS } from "@/lib/read-deadline";
import { cn, formatTimeUnit } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { RealtimeAge } from "./realtime-age";
import { useT } from "@/i18n/useT";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";

export interface DataFreshnessProps {
  /** Timestamp of the last successful fetch, from React Query. */
  dataUpdatedAt?: number;
  /**
   * A watch stream is feeding this view and has not failed.
   *
   * Defaults to false, and the default is the point: most screens in this
   * app are polled, so a surface that has not proved it is streaming does
   * not get to claim it.
   */
  live?: boolean;
  /**
   * This view is polled, and has backed off past its normal rate because
   * nothing has changed for a while.
   *
   * Ignored while {@link DataFreshnessProps.live} is set, and that is not a
   * precedence trick: a connected watch keeps the view up to date whatever
   * a poll beside it is doing, so there is nothing slowed about it.
   */
  slowed?: boolean;
  /** The last read failed: what is on screen, if anything, is from one before it. Wins over live. */
  stale?: boolean;
  /**
   * A re-read has waited on the cluster past the slow-read grace. Wins over
   * live: a watch beside the poll does not make the polled half current.
   */
  slowRead?: boolean;
  /**
   * The cluster refused the last read: when, or `null` where that is not
   * known. Nothing asks a refused read again on its own, so it is neither
   * live nor polled, and its age is the refusal's, not the last answer's.
   */
  refusedAt?: number | null;
  /** Hold the widest reading's width; off where nothing sits after the mark. */
  reserve?: boolean;
  className?: string;
}

const STATES = {
  live: {
    label: "freshLive",
    dot: "bg-ok",
    note: "freshLiveNote",
  },
  polling: {
    label: "freshPolling",
    dot: "bg-fg-fnt",
    note: "freshPollingNote",
  },
  slowed: {
    label: "freshSlowed",
    // Hollow, like offline: both are states where the number on screen may
    // no longer be the cluster's, and neither may rely on a hue to say so.
    dot: "border border-fg-fnt",
    note: "freshSlowedNote",
  },
  offline: {
    // A ring, not a fill: offline is the one state a reader must not miss,
    // and it is the one that cannot rely on a hue to say so.
    label: "freshOffline",
    dot: "border border-fg-fnt",
    note: "freshOfflineNote",
  },
  stale: {
    label: "freshStale",
    dot: "border border-warn",
    note: "freshStaleNote",
  },
  behind: {
    label: "freshBehind",
    dot: "border border-warn",
    note: "freshBehindNote",
  },
  refused: {
    label: "freshRefused",
    dot: null,
    note: "freshRefusedNote",
  },
} as const;

const AGED = new Set<string>([
  "freshSlowed",
  "freshOffline",
  "freshStale",
  "freshBehind",
  "freshRefused",
]);

/** "5 с назад", not a bare "5 с" a reader has to guess the meaning of. */
function AgeOnFace({ stamp }: { stamp: string }) {
  const t = useT();
  return (
    <span>{t("action", "agoSuffix", { age: useRealtimeAge(stamp) })}</span>
  );
}

/** Text drawn by CSS, so a reserve takes room without being read or found. */
function Ghost({ text }: { text: string }) {
  return <span data-text={text} className="before:content-[attr(data-text)]" />;
}

/** Every reading the face can take, hidden in one cell: a flip never moves its neighbours. */
function Reserve() {
  const t = useT();
  const age = t("action", "agoSuffix", { age: formatTimeUnit(59, "minute") });
  return Object.values(STATES).map(({ label, dot }) => (
    <span
      key={label}
      aria-hidden="true"
      className="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5"
    >
      <span className={cn("shrink-0", dot === null ? "w-2.5" : "w-1.5")} />
      <Ghost text={t("cluster", label)} />
      {AGED.has(label) && (
        <>
          <Ghost text="·" />
          <Ghost text={age} />
        </>
      )}
    </span>
  ));
}

export const DataFreshness = memo(function DataFreshness({
  dataUpdatedAt,
  live = false,
  slowed = false,
  stale = false,
  slowRead = false,
  refusedAt,
  reserve = true,
  className,
}: DataFreshnessProps) {
  const t = useT();
  const folded = useHeaderFolded();
  const isConnected = useClusterStore((s) => s.isConnected);
  const refused = refusedAt !== undefined;

  // Nothing has arrived yet, so there is no freshness to report — the
  // screen's own loading state is saying it, unless the read already failed.
  const neverRead = !dataUpdatedAt;
  if (neverRead && (!(stale || refused) || !isConnected)) return null;

  const state = !isConnected
    ? "offline"
    : refused
      ? "refused"
      : stale
        ? "stale"
        : slowRead
          ? "behind"
          : live
            ? "live"
            : slowed
              ? "slowed"
              : "polling";
  const { label, dot, note } = STATES[state];
  const warned = state === "stale" || state === "behind" || state === "refused";
  const at = state === "refused" ? refusedAt : neverRead ? null : dataUpdatedAt;
  const stamp = at ? new Date(at).toISOString() : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-grid shrink-0 justify-items-end whitespace-nowrap text-[11px] text-fg-fnt",
            className
          )}
        >
          {reserve && !folded && <Reserve />}
          <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">
            {dot === null ? (
              <Lock
                className="h-2.5 w-2.5 shrink-0 text-warn"
                aria-hidden="true"
              />
            ) : (
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
            )}
            <span className={cn(warned && "text-warn", folded && "sr-only")}>
              {t("cluster", label)}
            </span>
            {/* The readings where how old the data is changes what the
                reader should do with it carry the age on their face. */}
            {AGED.has(label) && stamp !== "" && !folded && (
              <>
                <span aria-hidden="true">·</span>
                <AgeOnFace stamp={stamp} />
              </>
            )}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {folded && (
          <span className={cn("block font-medium", warned && "text-warn")}>
            {t("cluster", label)}
          </span>
        )}
        {t(
          "cluster",
          neverRead && state !== "refused" ? "freshNeverReadNote" : note,
          { slow: SLOW_READ_MS / 1000, deadline: LIST_DEADLINE_SECONDS }
        )}
        {state !== "offline" && state !== "refused" && !neverRead && (
          <>
            {" "}
            {t("cluster", "lastRead")}{" "}
            <RealtimeAge timestamp={stamp} fallback={t("cluster", "justNow")} />{" "}
            {t("cluster", "agoSuffix")}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
});
