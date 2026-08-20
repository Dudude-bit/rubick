import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";

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
import { EVENT_ROW, EventRows } from "@/components/resources/detail-blocks";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import type { EventFilters, EventInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

const TYPE_FILTERS: Array<{
  value: string;
  label: keyof typeof en.action;
}> = [
  { value: "all", label: "all" },
  { value: "Warning", label: "eventsWarnings" },
  { value: "Normal", label: "eventsNormal" },
];

const LIMITS = ["200", "500", "1000", "2000", "all"] as const;

async function read(filters: EventFilters) {
  try {
    return await commands.listEvents(filters);
  } catch (err) {
    throw normalizeTauriError(err);
  }
}

function filtersFor(
  namespace: string,
  eventType: string,
  limit: number | null
): EventFilters {
  return {
    namespace,
    event_type: eventType === "all" ? null : eventType,
    limit,
    involved_object_name: null,
    involved_object_kind: null,
    field_selector: null,
  };
}

export function Events() {
  const t = useT();
  const { isConnected, currentNamespace } = useClusterStore();
  const scope = useNamespaceScope();
  const [eventType, setEventType] = useState<string>("all");
  const [eventLimit, setEventLimit] = useState<string>("500");

  const limit = eventLimit === "all" ? null : Number(eventLimit);
  const several = scope.several;

  const single = useLiveQuery({
    queryKey: [
      toPlural(ResourceType.Event),
      currentNamespace,
      eventType,
      eventLimit,
    ],
    queryFn: () => read(filtersFor(currentNamespace, eventType, limit)),
    enabled: isConnected && !several,
    refresh: "fast",
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.fast,
    refetchOnWindowFocus: false,
  });

  // One request per selected namespace, rather than one cluster-wide request
  // narrowed afterwards.
  //
  // The limit is a sentence about what is on screen — "latest 500" — so it
  // has to be counted against the scope the reader chose, and only the API
  // server can count it per namespace. Spent cluster-wide it goes to whoever
  // is loudest: a busy kube-system fills all 500 rows and the page prints "No
  // events in 2 namespaces yet" while prod is emitting. Each namespace is
  // asked for the whole limit rather than a share of it, because a share
  // would starve the noisy namespace and go unused in the quiet one; the
  // join is cut back to the limit below. It costs one request per selected
  // namespace, which is what `SCOPE_LIMIT` bounds.
  const parts = useLiveQueries<EventInfo[]>({
    refresh: "fast",
    // `placeholderData: keepPreviousData` is not missing from these: it does
    // nothing in a fan-out. `useQueries` matches observers by query hash, so
    // changing the filter re-keys every part onto a brand-new `QueryObserver`,
    // and the previous data it would keep lives on the observer that was just
    // replaced. The feed draws its skeleton until every namespace has answered
    // the question actually being asked, which is one fast read away.
    queries: (several ? scope.scope : []).map((namespace) => ({
      queryKey: [
        toPlural(ResourceType.Event),
        namespace,
        eventType,
        eventLimit,
      ],
      queryFn: () => read(filtersFor(namespace, eventType, limit)),
      enabled: isConnected,
      staleTime: STALE_TIMES.fast,
      // The group re-reads every part on the way back on its own
      // (`useLiveQueries`), which is the promise this cannot be switched off
      // without. React Query's focus refetch on top of that is a second wave
      // of one request per namespace for an answer already on its way.
      refetchOnWindowFocus: false,
    })),
  });

  const answers = parts.data;
  const pool = useMemo(
    () =>
      several
        ? // Newest first, the order each part arrived in and the one the cut
          // below depends on. The timestamps are UTC RFC3339 from the same
          // backend, so string order is time order — and an undated event
          // sorts last rather than jumping the queue.
          answers
            .flatMap((part) => part ?? [])
            .sort((a, b) => {
              const mine = a.lastTimestamp ?? "";
              const theirs = b.lastTimestamp ?? "";
              return mine < theirs ? 1 : mine > theirs ? -1 : 0;
            })
        : (single.data ?? []),
    [several, answers, single.data]
  );

  const isLoading = several ? parts.isLoading : single.isLoading;
  const freshness = several ? parts.freshness : single.freshness;

  if (!isConnected) {
    return (
      <ConnectClusterEmptyState resourceLabel={toPlural(ResourceType.Event)} />
    );
  }

  // Everything the reader asked for exists, so anything past the limit is
  // what the limit is hiding — whether the API server cut it or the join
  // did. Saying so beats an honest-looking feed that silently ends.
  const capped = limit !== null && pool.length >= limit;
  const events = capped ? pool.slice(0, limit) : pool;
  const warningCount = events.filter((e) => e.type === "Warning").length;
  const normalCount = events.length - warningCount;
  const showSkeleton = isLoading && events.length === 0;

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <SectionHeader
        title="Events"
        count={summarise(
          t,
          warningCount,
          normalCount,
          capped ? eventLimit : null
        )}
        actions={
          <>
            <div
              className="flex items-center gap-0.5"
              role="group"
              aria-label={t("action", "eventType")}
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
                  {t("action", filter.label)}
                </button>
              ))}
            </div>
            <Select value={eventLimit} onValueChange={setEventLimit}>
              <SelectTrigger
                aria-label={t("action", "eventsFetched")}
                className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((limit) => (
                  <SelectItem key={limit} value={limit}>
                    {limit === "all"
                      ? t("action", "noLimit")
                      : t("action", "latestN", { n: limit })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DataFreshness
              dataUpdatedAt={freshness.dataUpdatedAt}
              slowed={freshness.slowed}
            />
          </>
        }
      />
      <Section>
        <SectionBody>
          {showSkeleton ? (
            <EventsSkeleton />
          ) : (
            <EventRows
              // Not narrowed here: every row came back from a request for a
              // namespace in scope, so there is nothing left to filter out.
              events={events}
              showObject
              showNamespace={!currentNamespace}
              emptyMessage={t("empty", "noEventsInScope", {
                scope: scope.inWords,
              })}
            />
          )}
        </SectionBody>
      </Section>
    </div>
  );
}

/** Worst first, and the healthy half stays a plain count. */
function summarise(
  t: ReturnType<typeof useT>,
  warnings: number,
  normal: number,
  cappedAt: string | null
): string {
  const parts: string[] = [];
  if (warnings > 0) parts.push(t("count", "warningEvents", { n: warnings }));
  if (normal > 0) parts.push(t("count", "normalEvents", { n: normal }));
  if (parts.length === 0) parts.push(t("empty", "noneInline"));
  if (cappedAt) parts.push(t("count", "latestKept", { n: cappedAt }));
  return parts.join(" · ");
}

function EventsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={EVENT_ROW}>
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
