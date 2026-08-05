import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Section, SectionHeader } from "@/components/ui/section";
import { useClusterStore } from "@/stores/clusterStore";
import { Badge } from "@/components/ui/badge";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { ListSkeleton } from "@/components/ui/skeleton";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { AlertTriangle, Info, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/commands";
import type { EventInfo, EventFilters } from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { DataFreshness } from "@/components/ui/realtime";

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
    refetchInterval: REFRESH_INTERVALS.fast, // Auto-refresh every 5 seconds
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
  const normalCount = events.filter((e) => e.type === "Normal").length;
  const showSkeleton = isLoading && events.length === 0;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Events</h1>
        </div>
        <div className="flex items-center gap-2">
          <Select value={eventType} onValueChange={setEventType}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="Warning">Warnings</SelectItem>
              <SelectItem value="Normal">Normal</SelectItem>
            </SelectContent>
          </Select>
          <Select value={eventLimit} onValueChange={setEventLimit}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Limit" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="200">200</SelectItem>
              <SelectItem value="500">500</SelectItem>
              <SelectItem value="1000">1000</SelectItem>
              <SelectItem value="2000">2000</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <DataFreshness dataUpdatedAt={dataUpdatedAt} />
        </div>
      </div>

      {/* Summary */}
      <div className="flex gap-4">
        <Badge variant="secondary" className="gap-1">
          <Info className="h-3 w-3" />
          {normalCount} Normal
        </Badge>
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="h-3 w-3" />
          {warningCount} Warning
        </Badge>
      </div>

      {/* Events List */}
      <Section>
        <SectionHeader
          title="Recent Events"
          description={
            <>
              Events from {currentNamespace || "all namespaces"}
              {eventLimit !== "all" && ` • Limit ${eventLimit}`}
            </>
          }
        />
        <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
          {showSkeleton ? (
            <ListSkeleton count={5} showIcon />
          ) : events.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No events found
            </div>
          ) : (
            <div className="space-y-2">
              {events.map((event) => (
                <EventItem key={event.uid} event={event} />
              ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

function EventItem({ event }: { event: EventInfo }) {
  const isWarning = event.type === "Warning";

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        isWarning ? "border-yellow-500/50 bg-yellow-500/5" : "border-border"
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {isWarning ? (
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          ) : (
            <Info className="h-4 w-4 text-blue-500" />
          )}
          <span className="font-medium">{event.reason}</span>
          <Badge variant="outline" className="text-xs">
            {event.involvedObject.kind}/{event.involvedObject.name}
          </Badge>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {event.lastTimestamp
            ? new Date(event.lastTimestamp).toLocaleString()
            : "Unknown"}
          {(event.count || 0) > 1 && (
            <Badge variant="secondary" className="ml-2">
              x{event.count}
            </Badge>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{event.message}</p>
    </div>
  );
}
