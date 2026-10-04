import { useCallback } from "react";
import { BadgeCheck, Route } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { conditionRole } from "@/lib/condition-health";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportFinding, ReportStat } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { useT, type T } from "@/i18n/useT";
import { ResourceType } from "@/lib/resource-registry";
import { sayMatch } from "@/lib/route-match";
import type { RouteInfo } from "@/generated/types";

export function gatewayRouteStats(route: RouteInfo, t: T): ReportStat[] {
  return [
    {
      label: t("columns", "hostnames"),
      value:
        route.hostnames.length > 0
          ? route.hostnames.join(", ")
          : t("empty", "gwAllHostsListenerServes"),
    },
  ];
}

/**
 * The route's status, read the way every screen in this app reads it: by
 * parent, from `parents[].conditions`. `RouteInfo` carries no top-level
 * `conditions`, so the frame's own auto-detection finds nothing here, this
 * is the override the frame's `ShareContribution.conditions` slot exists for.
 */
export function gatewayRouteConditionsSection(
  route: RouteInfo,
  t: T
): PlacedSection {
  const items: ReportFinding[] = route.parents.flatMap((parent) =>
    parent.conditions.map((condition) => ({
      title: condition.type,
      detail: [condition.status, condition.reason, condition.message]
        .filter(Boolean)
        .join(" · "),
      role: conditionRole(condition),
      ref: refOf({
        kind: parent.parent.kind,
        name: parent.parent.name,
        namespace: parent.parent.namespace ?? route.namespace,
      }),
    }))
  );
  return {
    id: "conditions",
    order: ORDER.conditions,
    title: t("columns", "conditions"),
    icon: iconSvg(BadgeCheck),
    count: items.length,
    body: { type: "findings", items },
  };
}

export function gatewayRouteRulesSection(
  route: RouteInfo,
  t: T
): PlacedSection {
  const rows = route.rules.flatMap((rule) => {
    const match =
      rule.matches.length === 0
        ? t("empty", "matchesEverythingWord")
        : rule.matches.map((m) => sayMatch(m, t)).join(" · ");
    if (rule.backendRefs.length === 0) {
      return [
        {
          cells: [
            { text: match },
            { text: "–", quiet: true },
            { text: "–" },
            { text: "–" },
          ],
        },
      ];
    }
    return rule.backendRefs.map((backend) => ({
      cells: [
        { text: match },
        backend.kind === "Service"
          ? {
              text: backend.name,
              ref: refOf({
                kind: ResourceType.Service,
                name: backend.name,
                namespace: backend.namespace ?? route.namespace,
              }),
            }
          : { text: `${backend.kind} ${backend.name}` },
        { text: backend.port != null ? String(backend.port) : "–" },
        {
          text:
            backend.weight === 0
              ? t("empty", "zeroWeight")
              : backend.weight != null
                ? String(backend.weight)
                : "–",
        },
      ],
    }));
  });
  return {
    id: "rules",
    order: ORDER.own,
    title: t("columns", "rules"),
    icon: iconSvg(Route),
    count: route.rules.length,
    body: {
      type: "table",
      columns: [
        t("columns", "match"),
        t("columns", "backend"),
        t("columns", "port"),
        t("columns", "weight"),
      ],
      rows,
      more: null,
    },
  };
}

/**
 * What a route detail page adds to Share: its hostnames, its per-parent
 * status (there is no object-level `conditions` for the frame to find on its
 * own) and its rules with the backends they weight traffic to.
 */
export function useGatewayRouteShare(
  route: RouteInfo | undefined
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!route) return {};
    return {
      stats: gatewayRouteStats(route, t),
      conditions: gatewayRouteConditionsSection(route, t),
      sections: [gatewayRouteRulesSection(route, t)],
    };
  }, [route, t]);
}
