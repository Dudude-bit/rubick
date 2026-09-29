import { useCallback } from "react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { iconSvg } from "@/lib/icon-svg";
import { namespacesOf, podsOf, portText } from "@/lib/network-policy";
import type { ReportFinding, ReportStat } from "@/lib/report";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import { useT, type T } from "@/i18n/useT";
import type {
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyPeer,
} from "@/generated/types";

function peerText(peer: PolicyPeer, t: T): string {
  if (peer.ipBlock) {
    const except =
      peer.ipBlock.except.length > 0
        ? ` ${t("empty", "exceptRanges", { ranges: peer.ipBlock.except.join(", ") })}`
        : "";
    return `${peer.ipBlock.cidr}${except}`;
  }
  const pods = podsOf(peer.pods);
  const namespaces = namespacesOf(peer.namespaces);
  const podsText =
    pods.kind === "written" ? pods.query : t("empty", "everyPodThere");
  const namespacesText =
    namespaces.kind === "written"
      ? namespaces.query
      : namespaces.kind === "everyNamespace"
        ? t("empty", "inEveryNamespace")
        : t("empty", "inThisNamespace");
  return t("empty", "podsInNamespaces", {
    pods: podsText,
    namespaces: namespacesText,
  });
}

export function networkPolicyStats(
  policy: NetworkPolicyInfo,
  t: T
): ReportStat[] {
  const types = [
    policy.ingress.governed ? "Ingress" : null,
    policy.egress.governed ? "Egress" : null,
  ].filter((type): type is string => type !== null);
  return [
    {
      label: t("columns", "selector"),
      value:
        policy.selects.kind === "written"
          ? policy.selects.query
          : policy.selects.kind === "everything"
            ? t("empty", "everyPodHere")
            : t("empty", "noSelectorOnPolicy"),
    },
    {
      label: t("share", "netPolicyTypes"),
      value: types.length > 0 ? types.join(", ") : "–",
    },
  ];
}

function directionFindings(
  direction: PolicyDirection,
  outbound: boolean,
  t: T
): ReportFinding[] {
  if (direction.rules.length === 0)
    return [{ title: t("empty", "deniesAll"), detail: null, role: "ok" }];
  return direction.rules.map((rule) => ({
    title:
      rule.peers.length === 0
        ? t("empty", outbound ? "toAnywhere" : "fromAnywhere")
        : rule.peers.map((peer) => peerText(peer, t)).join("; "),
    detail:
      rule.ports.length === 0
        ? t("empty", "everyPort")
        : rule.ports.map((port) => portText(port, t)).join(", "),
    role: rule.peers.length === 0 ? ("warn" as const) : ("neutral" as const),
  }));
}

export function networkPolicyDirectionSection(
  direction: PolicyDirection,
  outbound: boolean,
  t: T
): PlacedSection | null {
  if (!direction.governed) return null;
  return {
    id: outbound ? "egress" : "ingress",
    order: ORDER.own,
    title: outbound ? "Egress" : "Ingress",
    icon: iconSvg(outbound ? ArrowUpFromLine : ArrowDownToLine),
    count: direction.rules.length,
    body: {
      type: "findings",
      items: directionFindings(direction, outbound, t),
    },
  };
}

/**
 * What the NetworkPolicy page adds to Share: what it selects, which
 * directions it governs, and each direction's rules as peer/port findings.
 */
export function useNetworkPolicyShare(
  policy: NetworkPolicyInfo | undefined
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!policy) return {};
    const sections = [
      networkPolicyDirectionSection(policy.ingress, false, t),
      networkPolicyDirectionSection(policy.egress, true, t),
    ].filter((section): section is PlacedSection => section !== null);
    return { stats: networkPolicyStats(policy, t), sections };
  }, [policy, t]);
}
