import { useCallback } from "react";
import { Waypoints } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportStat } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { useT, type T } from "@/i18n/useT";
import { ResourceType } from "@/lib/resource-registry";
import type { EndpointAddress, EndpointsInfo } from "@/generated/types";

/** Every address in the object, flattened, carrying its readiness. */
type Backend = { address: EndpointAddress; ready: boolean };

function backendsOf(endpoints: EndpointsInfo): Backend[] {
  return endpoints.subsets.flatMap((subset) => [
    ...subset.addresses.map((address) => ({ address, ready: true })),
    ...subset.notReadyAddresses.map((address) => ({ address, ready: false })),
  ]);
}

export function endpointsStats(
  endpoints: EndpointsInfo,
  t: T,
  podsUnread: boolean
): ReportStat[] {
  const backends = backendsOf(endpoints);
  const ready = backends.filter((b) => b.ready).length;
  const notReady = backends.length - ready;
  const ports = endpoints.subsets.flatMap((s) => s.ports);
  return [
    { label: t("columns", "ready"), value: String(ready) },
    {
      label: t("columns", "notReadyCount"),
      value: String(notReady),
      role: notReady > 0 ? (podsUnread ? "neutral" : "warn") : undefined,
      unread: notReady > 0 && podsUnread,
    },
    { label: t("columns", "ports"), value: String(ports.length) },
  ];
}

export function endpointsAddressesSection(
  endpoints: EndpointsInfo,
  t: T,
  podsUnread: boolean
): PlacedSection {
  const backends = backendsOf(endpoints);
  return {
    id: "addresses",
    order: ORDER.own,
    title: t("nav", "backends"),
    icon: iconSvg(Waypoints),
    count: backends.length,
    body: {
      type: "table",
      columns: [
        t("columns", "address"),
        t("columns", "state"),
        t("columns", "target"),
        t("columns", "node"),
      ],
      rows: backends.map(({ address, ready }) => ({
        cells: [
          { text: address.ip, mono: true },
          {
            text: ready ? t("empty", "readyOne") : t("empty", "notReadyOne"),
            role: ready ? "ok" : podsUnread ? "neutral" : "err",
            unread: !ready && podsUnread,
          },
          address.targetRef
            ? {
                text: address.targetRef.name,
                ref: refOf({
                  kind: address.targetRef.kind,
                  name: address.targetRef.name,
                  namespace: address.targetRef.namespace,
                }),
              }
            : { text: t("empty", "noneLower"), quiet: true },
          address.nodeName
            ? {
                text: address.nodeName,
                ref: refOf({
                  kind: ResourceType.Node,
                  name: address.nodeName,
                  namespace: null,
                }),
              }
            : { text: t("empty", "noneLower"), quiet: true },
        ],
      })),
      more: null,
    },
  };
}

/**
 * What the Endpoints page adds to Share: how many addresses answer and how
 * many do not, and the addresses themselves with the pod each one names,
 * those not ready without a fault's colour where the Service's pods were
 * not read to say why.
 */
export function useEndpointsShare(
  endpoints: EndpointsInfo | undefined,
  podsUnread: boolean
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!endpoints) return {};
    return {
      stats: endpointsStats(endpoints, t, podsUnread),
      sections: [endpointsAddressesSection(endpoints, t, podsUnread)],
    };
  }, [endpoints, t, podsUnread]);
}
