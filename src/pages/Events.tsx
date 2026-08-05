import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DataFreshness } from "@/components/ui/realtime";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { cn, formatDate } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { EventFilters, EventInfo } from "@/generated/types";

const TYPE_FILTERS = [
  { value: "all", label: "All" },
  { value: "Warning", label: "Warnings" },
  { value: "Normal", label: "Normal" },
] as const;

const LIMITS = ["200", "500", "1000", "2000", "all"] as const;

/**
 * One event, one line — same column rhythm as the overview's problem feed:
 * severity, reason, who it happened to, how often, how long ago.
 */
const ROW =
  "grid grid-cols-[10px_minmax(0,168px)_minmax(0,1fr)_54px_44px] items-center gap-2.5 px-1.5 py-[3px] text-xs";

export function Events() {
  const { isConnected, currentNamespace } = useClusterStore();
  const [eventType, setEventType] = useState<string>("all");
  const [eventLimit, setEventLimit] = useState<string>("500");

  const {
    data: events = [],
    isLoading,
    dataUpdatedAt,
  } = useQuery({
    queryKey: [
      toPlural(ResourceType.Event),
      currentNamespace,
      eventType,
      eventLimit,
    ],
    queryFn: async () => {
      const limit = eventLimit === "all" ? null : Number(eventLimit);
      const filters: EventFilters = {
        namespace: currentNamespace,
        event_type: eventType === "all" ? null : eventType,
        limit,
        involved_object_name: null,
        involved_object_kind: null,
        field_selector: null,
      };
      try {
        return await commands.listEvents(filters);
      } catch (err) {
        throw normalizeTauriError(err);
      }
    },
    enabled: isConnected,
    refetchInterval: REFRESH_INTERVALS.fast,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.fast,
    refetchOnWindowFocus: false,
  });

  if (!isConnected) {
    return (
      <ConnectClusterEmptyState resourceLabel={toPlural(ResourceType.Event)} />
    );
  }

  const warningCount = events.filter((e) => e.type === "Warning").length;
  const normalCount = events.length - warningCount;
  const showSkeleton = isLoading && events.length === 0;
  // The API returns the newest slice, so hitting the limit means older
  // events exist and are not on screen. Saying so beats an honest-looking
  // feed that silently ends.
  const capped = eventLimit !== "all" && events.length >= Number(eventLimit);

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <SectionHeader
        title="Events"
        count={summarise(warningCount, normalCount, capped ? eventLimit : null)}
        actions={
          <>
            <div
              className="flex items-center gap-0.5"
              role="group"
              aria-label="Event type"
            >
              {TYPE_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={eventType === filter.value}
                  onClick={() => setEventType(filter.value)}
                  className={cn(
                    "h-6 rounded px-1.5 text-[11px] transition-colors hover:bg-hover",
                    eventType === filter.value
                      ? "bg-sel text-fg"
                      : "text-fg-mut"
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <Select value={eventLimit} onValueChange={setEventLimit}>
              <SelectTrigger
                aria-label="Events fetched"
                className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((limit) => (
                  <SelectItem key={limit} value={limit}>
                    {limit === "all" ? "No limit" : `Latest ${limit}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DataFreshness dataUpdatedAt={dataUpdatedAt} />
          </>
        }
      />
      <Section>
        <SectionBody>
          {showSkeleton ? (
            <EventsSkeleton />
          ) : events.length === 0 ? (
            <p className="px-1.5 py-8 text-center text-xs text-fg-mut">
              No events in {currentNamespace || "any namespace"} yet.
            </p>
          ) : (
            events.map((event) => (
              <EventRow
                key={event.uid}
                event={event}
                showNamespace={!currentNamespace}
              />
            ))
          )}
        </SectionBody>
      </Section>
    </div>
  );
}

/** Worst first, and the healthy half stays a plain count. */
function summarise(
  warnings: number,
  normal: number,
  cappedAt: string | null
): string {
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} warning`);
  if (normal > 0) parts.push(`${normal} normal`);
  if (parts.length === 0) parts.push("none");
  if (cappedAt) parts.push(`latest ${cappedAt}`);
  return parts.join(" · ");
}

function EventRow({
  event,
  showNamespace,
}: {
  event: EventInfo;
  showNamespace: boolean;
}) {
  const isWarning = event.type === "Warning";
  const age = useRealtimeAge(event.lastTimestamp ?? null);
  const count = event.count ?? 0;

  return (
    <div className={ROW}>
      {/* Shape carries the severity alongside the colour — the feed has to
       *  stay readable without hue. */}
      <span
        className={cn(
          "justify-self-center text-[9px]",
          isWarning ? "text-warn" : "text-fg-fnt"
        )}
        aria-hidden="true"
      >
        {isWarning ? "▲" : "●"}
      </span>
      <span
        className={cn(
          "truncate font-mono font-medium",
          isWarning ? "text-warn" : "text-fg-mut"
        )}
      >
        <span className="sr-only">{event.type}: </span>
        {event.reason ?? "—"}
      </span>
      <span className="truncate text-fg-mid">
        <span className="font-mono">
          {event.involvedObject.kind}/{event.involvedObject.name}
        </span>
        {showNamespace && event.namespace && (
          <span className="text-fg-fnt"> · {event.namespace}</span>
        )}
        {event.message && (
          <span className="text-fg-fnt"> — {event.message}</span>
        )}
      </span>
      <span className="text-right font-mono text-[11px] text-fg-fnt">
        {count > 1 ? `×${count}` : ""}
      </span>
      <span
        className="text-right text-[11px] text-fg-fnt"
        title={formatDate(event.lastTimestamp) ?? undefined}
      >
        {event.lastTimestamp ? age : "—"}
      </span>
    </div>
  );
}

function EventsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={ROW}>
          <span />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
          <span />
          <Skeleton className="h-3 w-6 justify-self-end" />
        </div>
      ))}
    </div>
  );
}
