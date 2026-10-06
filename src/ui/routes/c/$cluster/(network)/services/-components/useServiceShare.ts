import { useCallback } from "react";
import { Filter, Plug, Waypoints } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import { iconSvg } from "@/lib/icon-svg";
import {
  endpointAddress,
  endpointCount,
  endpointState,
  publishedFor,
  sourceNote,
} from "@/lib/published";
import type { ReportStat } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { useT, type T } from "@/i18n/useT";
import type { ServiceInfo, ServicePublished } from "@/generated/types";

/** A report is read, not scrolled: past this the app is the place to look. */
const MAX_ROWS = 300;

export function serviceStats(
  service: ServiceInfo,
  published: ServicePublished | undefined,
  t: T
): ReportStat[] {
  const stats: ReportStat[] = [
    { label: t("columns", "type"), value: service.type },
    { label: t("columns", "clusterIp"), value: service.clusterIp ?? "None" },
    { label: t("columns", "ports"), value: String(service.ports.length) },
  ];
  if (published) {
    const total = endpointCount(published);
    stats.push({
      label: t("nav", "published"),
      value: `${published.ready}/${total}`,
      // Nothing published is the page's red stop, not 0 of 0 done; and a
      // count deduced from pods, because neither list could be read, is not
      // one the controller wrote.
      role:
        total === 0
          ? "warn"
          : published.source === "podReadiness"
            ? "neutral"
            : published.ready === total
              ? "ok"
              : "warn",
      note:
        total === 0
          ? t("empty", "servicePublishesNothing")
          : sourceNote(published, t),
    });
  }
  return stats;
}

export function servicePortsSection(service: ServiceInfo, t: T): PlacedSection {
  return {
    id: "ports",
    order: ORDER.own,
    title: t("columns", "ports"),
    icon: iconSvg(Plug),
    count: service.ports.length,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "port"),
        t("columns", "target"),
        t("columns", "protocol"),
        t("columns", "nodePort"),
      ],
      rows: service.ports.map((port) => ({
        cells: [
          { text: port.name || t("empty", "noneLower") },
          { text: String(port.port), mono: true },
          { text: port.targetPort, mono: true },
          { text: port.protocol },
          {
            text:
              port.nodePort != null
                ? String(port.nodePort)
                : t("empty", "noneLower"),
          },
        ],
      })),
      more: null,
    },
  };
}

export function serviceSelectorSection(
  service: ServiceInfo,
  t: T
): PlacedSection {
  const entries = Object.entries(service.selector ?? {});
  return {
    id: "selector",
    order: ORDER.own,
    title: t("nav", "podSelector"),
    icon: iconSvg(Filter),
    count: entries.length,
    body: {
      type: "facts",
      rows: entries.map(([key, value]) => ({
        label: key,
        values: [{ text: value, mono: true }],
      })),
    },
  };
}

export function servicePublishedSection(
  connections: ConnectionsQuery,
  t: T
): PlacedSection {
  const unread = connections.error
    ? t("empty", "couldNotReadWhatServicePublishes")
    : connections.isPending || connections.data === undefined
      ? t("share", "stillReading")
      : null;
  const published = connections.data
    ? publishedFor(connections.data, connections.data.subject)
    : undefined;
  const all = published?.endpoints ?? [];
  const rows = all.slice(0, MAX_ROWS);
  return {
    id: "published",
    order: ORDER.own,
    title: t("nav", "published"),
    icon: iconSvg(Waypoints),
    count: published ? all.length : undefined,
    unread,
    body: {
      type: "table",
      columns: [
        t("columns", "address"),
        t("columns", "target"),
        t("columns", "state"),
      ],
      rows: rows.map((endpoint) => {
        const state = endpointState(endpoint, t);
        const address = endpointAddress(endpoint);
        return {
          cells: [
            address === null
              ? { text: t("readings", "healthNoAddressYet"), quiet: true }
              : { text: address, mono: true },
            endpoint.target
              ? {
                  text: endpoint.target.name,
                  ref: refOf(endpoint.target),
                }
              : { text: t("empty", "registeredByHand"), quiet: true },
            { text: state.text, role: state.tone },
          ],
        };
      }),
      more:
        all.length > rows.length
          ? t("share", "rowsMore", { n: all.length - rows.length })
          : null,
    },
  };
}

/**
 * What the Service page adds to Share: its type and address, its ports and
 * selector, and what it actually publishes, read from the connections query
 * the Overview and Connections tabs already asked for.
 */
export function useServiceShare(
  service: ServiceInfo | undefined,
  connections: ConnectionsQuery
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!service) return {};
    const published = connections.data
      ? publishedFor(connections.data, connections.data.subject)
      : undefined;
    return {
      stats: serviceStats(service, published, t),
      sections: [
        servicePortsSection(service, t),
        serviceSelectorSection(service, t),
        servicePublishedSection(connections, t),
      ],
    };
  }, [service, connections, t]);
}
