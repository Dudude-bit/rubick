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

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  /** The last read failed, and what is on screen is from the one before it. Wins over live. */
  stale?: boolean;
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
} as const;

const AGED = new Set<string>(["freshSlowed", "freshOffline", "freshStale"]);

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
  return Object.values(STATES).map(({ label }) => (
    <span
      key={label}
      aria-hidden="true"
      className="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5"
    >
      <span className="w-1.5 shrink-0" />
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
  className,
}: DataFreshnessProps) {
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);

  // Nothing has arrived yet, so there is no freshness to report — the
  // screen's own loading state is saying it.
  if (!dataUpdatedAt) return null;

  const state = !isConnected
    ? "offline"
    : stale
      ? "stale"
      : live
        ? "live"
        : slowed
          ? "slowed"
          : "polling";
  const { label, dot, note } = STATES[state];
  const stamp = new Date(dataUpdatedAt).toISOString();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-grid shrink-0 justify-items-end whitespace-nowrap text-[11px] text-fg-fnt",
            className
          )}
        >
          <Reserve />
          <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
            <span className={cn(state === "stale" && "text-warn")}>
              {t("cluster", label)}
            </span>
            {/* The readings where how old the data is changes what the
                reader should do with it carry the age on their face. */}
            {AGED.has(label) && (
              <>
                <span aria-hidden="true">·</span>
                <AgeOnFace stamp={stamp} />
              </>
            )}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t("cluster", note)}
        {state !== "offline" && (
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
