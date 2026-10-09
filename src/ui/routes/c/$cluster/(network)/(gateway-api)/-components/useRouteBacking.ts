import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

import type { RouteInfo, ServiceInfo } from "@/generated/types";
import {
  chainServices,
  useServicesSeen,
  type ChainService,
} from "@/hooks/useChainAnswer";
import {
  backingFrom,
  backingListsKey,
  useBackingLists,
  type BackingSources,
} from "@/integrations";
import { publishedSpeaks, waitsOnList } from "@/lib/service-health";
import { useClusterStore } from "@/stores/clusterStore";

/** How long after a read a second one is fresh rather than shared with it. */
const FRESH_READ_MS = 300;

const selectorText = (selector: Record<string, string>) =>
  Object.entries(selector)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(",") || null;

export interface RouteBacking {
  sources: BackingSources;
  /** The Services its rules send to, for `ChainWatches` to follow. */
  services: ChainService[];
  key: QueryKey;
}

/**
 * What a route's backends publish, held to what the watches under each of
 * them have seen, as a Service's own page holds its answer: a read older
 * than they know is one still being read, and where `follow` is set it is
 * read again. The lists are a minute stale by design; under a route on
 * screen its Services' pods and slices say when they are not.
 */
export function useRouteBacking(
  route: RouteInfo | undefined,
  follow: boolean
): RouteBacking {
  const client = useQueryClient();
  const context = useClusterStore((state) => state.currentContext);
  const backing = useBackingLists();
  const { data, error, dataUpdatedAt } = backing;
  const key = backingListsKey(context);
  const backends = new Set(
    (route?.rules ?? []).flatMap((rule) =>
      rule.backendRefs
        .filter((ref) => ref.kind === "Service")
        .map((ref) => `${ref.namespace ?? route?.namespace}/${ref.name}`)
    )
  );
  const published = (data?.published ?? []).filter((entry) =>
    backends.has(`${entry.service.namespace ?? ""}/${entry.service.name}`)
  );
  const byName = new Map<string, ServiceInfo>(
    (data?.services ?? []).map((service) => [
      `${service.namespace}/${service.name}`,
      service,
    ])
  );
  const services = chainServices(published, (namespace, name) => {
    const service = byName.get(`${namespace}/${name}`);
    return service ? selectorText(service.selector) : null;
  });
  const seen = useServicesSeen(services, true);
  const read = data?.readAt ? Date.parse(data.readAt) : dataUpdatedAt;
  const speaks = !data || publishedSpeaks(published, read, seen);
  const listing = !!data && waitsOnList({ published }, seen);

  const asked = useRef<unknown>(null);
  useEffect(() => {
    if (!follow || speaks || listing || asked.current === data) return;
    asked.current = data;
    setTimeout(
      () => void client.invalidateQueries({ queryKey: key, exact: true }),
      FRESH_READ_MS
    );
  });

  const sources = useMemo(
    () => (speaks ? backingFrom(data, error) : backingFrom(undefined, null)),
    [speaks, data, error]
  );
  return { sources, services, key };
}
