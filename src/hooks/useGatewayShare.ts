import { useCallback } from "react";
import { BadgeCheck, RadioTower } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { conditionRole, failingCondition } from "@/lib/condition-health";
import { iconSvg } from "@/lib/icon-svg";
import { gatewayProgrammed } from "@/lib/route-trace";
import type { ReportStat } from "@/lib/report";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import { useT, type T } from "@/i18n/useT";
import type { GatewayInfo, ListenerInfo } from "@/generated/types";

export function gatewayStats(gateway: GatewayInfo, t: T): ReportStat[] {
  const programmed = gatewayProgrammed(gateway);
  return [
    { label: t("columns", "class"), value: gateway.className || "–" },
    programmed
      ? {
          label: t("columns", "programmed"),
          value:
            programmed.status === "True"
              ? t("columns", "programmed")
              : (programmed.reason ?? programmed.status),
          role:
            programmed.status === "True"
              ? "ok"
              : programmed.status === "False"
                ? "err"
                : "warn",
        }
      : {
          label: t("columns", "programmed"),
          value: t("empty", "gwNoControllerShort"),
          role: "warn",
        },
    {
      label: t("columns", "addresses"),
      value:
        gateway.addresses.length > 0
          ? gateway.addresses.join(", ")
          : t("empty", "nonePublished"),
      role: gateway.addresses.length > 0 ? undefined : "warn",
    },
  ];
}

function listenerRole(listener: ListenerInfo): {
  role: "ok" | "warn" | "err";
  text: string;
} {
  const broken = failingCondition(listener.conditions);
  if (broken) return { role: "err", text: broken.reason ?? broken.type };
  const caution = listener.conditions.find((c) => conditionRole(c) === "warn");
  if (caution) return { role: "warn", text: caution.reason ?? caution.type };
  return { role: "ok", text: "" };
}

export function gatewayListenersSection(
  gateway: GatewayInfo,
  t: T
): PlacedSection {
  return {
    id: "listeners",
    order: ORDER.own,
    title: t("columns", "listeners"),
    icon: iconSvg(RadioTower),
    count: gateway.listeners.length,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "port"),
        t("columns", "protocol"),
        t("columns", "hostname"),
        t("columns", "attached"),
        t("columns", "status"),
      ],
      rows: gateway.listeners.map((listener) => {
        const state = listenerRole(listener);
        return {
          cells: [
            { text: listener.name },
            { text: String(listener.port), mono: true },
            { text: listener.protocol },
            { text: listener.hostname ?? t("empty", "gwAllHosts") },
            {
              text:
                listener.attachedRoutes != null
                  ? String(listener.attachedRoutes)
                  : "–",
            },
            { text: state.text, role: state.role },
          ],
        };
      }),
      more: null,
    },
  };
}

export function gatewayListenerConditionsSection(
  gateway: GatewayInfo,
  t: T
): PlacedSection {
  const rows = gateway.listeners.flatMap((listener) =>
    listener.conditions.map((condition) => ({
      cells: [
        { text: listener.name },
        { text: condition.type, mono: true },
        { text: condition.status, role: conditionRole(condition) },
        { text: condition.reason ?? "–" },
      ],
    }))
  );
  return {
    id: "listener-conditions",
    order: ORDER.own,
    title: t("share", "netListenerConditions"),
    icon: iconSvg(BadgeCheck),
    count: rows.length,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "type"),
        t("columns", "status"),
        t("columns", "reason"),
      ],
      rows,
      more: null,
    },
  };
}

/**
 * What the Gateway page adds to Share: its class and address, its listeners
 * and each one's own conditions. The gateway-level conditions are the
 * frame's own, read off the top-level `conditions` the object already has.
 */
export function useGatewayShare(
  gateway: GatewayInfo | undefined
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!gateway) return {};
    return {
      stats: gatewayStats(gateway, t),
      sections: [
        gatewayListenersSection(gateway, t),
        gatewayListenerConditionsSection(gateway, t),
      ],
    };
  }, [gateway, t]);
}
