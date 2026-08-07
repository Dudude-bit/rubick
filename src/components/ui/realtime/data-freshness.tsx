/**
 * What the numbers on this screen are worth right now.
 *
 * This used to render a green "Live" the moment any data existed, which
 * made it a decoration rather than a reading: it said "Live" over a
 * disconnected cluster and over screens that have no watch at all and
 * merely re-read on a timer. Three states, three words, and a shape as
 * well as a colour — a reader who cannot see the hue still gets the
 * answer from the ring and the label.
 *
 * @module components/ui/realtime/data-freshness
 */

import { memo } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { RealtimeAge } from "./realtime-age";

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
  className?: string;
}

const STATES = {
  live: {
    label: "live",
    dot: "bg-ok",
    note: "The cluster is pushing changes to this view as they happen.",
  },
  polling: {
    label: "polling",
    dot: "bg-fg-fnt",
    note: "No watch on this view — it re-reads the cluster on a timer.",
  },
  offline: {
    // A ring, not a fill: offline is the one state a reader must not miss,
    // and it is the one that cannot rely on a hue to say so.
    label: "offline",
    dot: "border border-fg-fnt",
    note: "Not connected. Nothing on this screen is updating.",
  },
} as const;

export const DataFreshness = memo(function DataFreshness({
  dataUpdatedAt,
  live = false,
  className,
}: DataFreshnessProps) {
  const isConnected = useClusterStore((s) => s.isConnected);

  // Nothing has arrived yet, so there is no freshness to report — the
  // screen's own loading state is saying it.
  if (!dataUpdatedAt) return null;

  const state = !isConnected ? "offline" : live ? "live" : "polling";
  const { label, dot, note } = STATES[state];
  const stamp = new Date(dataUpdatedAt).toISOString();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center gap-1.5 text-[11px] text-fg-fnt",
            className
          )}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
          <span>{label}</span>
          {/* Only the offline reading needs an age on the face of it: it is
              the one state where how old the data is changes what the
              reader should do with it. */}
          {state === "offline" && (
            <>
              <span aria-hidden="true">·</span>
              <RealtimeAge timestamp={stamp} fallback="" />
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {note}
        {state !== "offline" && (
          <>
            {" "}
            Last read <RealtimeAge timestamp={stamp} fallback="just now" /> ago.
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
});
