/**
 * What a Cilium policy says about itself, reusing `enforcementOf`,
 * `selectionOf`, `directionsOf` and `leavesTheCluster`, the same readers
 * the policy page walks.
 */

import { Network } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportSection, ReportValue } from "@/lib/report";
import { GROUP } from "./data";
import {
  directionsOf,
  enforcementOf,
  leavesTheCluster,
  selectionOf,
} from "./model";

const KINDS = new Set([
  "CiliumNetworkPolicy",
  "CiliumClusterwideNetworkPolicy",
]);

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${GROUP}/v2`,
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function selectionText(
  policy: ReturnType<typeof selectionOf>,
  t: T
): ReportValue {
  switch (policy.kind) {
    case "all":
      return { text: t("share", "ciliumEveryEndpoint") };
    case "labels":
      return {
        text:
          policy.andExpressions > 0
            ? `${policy.said} (+${policy.andExpressions})`
            : policy.said,
        mono: true,
      };
    case "expressions":
      return { text: t("share", "ciliumExpressions", { n: policy.count }) };
    case "nodes":
      return { text: t("share", "ciliumNodes") };
    case "notHere":
      return { text: t("share", "ciliumSpecNotHere"), quiet: true };
  }
}

function policySections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const resource = fakeResource(object);
  const enforcement = enforcementOf(resource);
  const selection = selectionOf(resource);
  const directions = directionsOf(resource);
  const leaves = leavesTheCluster(resource);

  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        enforcement.state === "accepted"
          ? { text: t("share", "ciliumAccepted"), role: "ok" }
          : enforcement.state === "rejected"
            ? {
                text: enforcement.why ?? t("share", "ciliumRejected"),
                role: "err",
              }
            : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
    {
      label: t("share", "ciliumSelects"),
      values: [selectionText(selection, t)],
    },
  ];
  if (directions) {
    rows.push({
      label: t("share", "ciliumRules"),
      values: [
        {
          text: t("share", "ciliumIngressEgress", {
            ingress: directions.ingress,
            egress: directions.egress,
          }),
          mono: true,
        },
      ],
    });
    if (directions.denies > 0) {
      rows.push({
        label: t("share", "ciliumDenies"),
        values: [{ text: String(directions.denies), role: "warn" }],
      });
    }
  }
  if (leaves !== null) {
    rows.push({
      label: t("share", "ciliumLeavesCluster"),
      values: [
        leaves
          ? { text: t("action", "yes"), role: "warn" }
          : { text: t("action", "no") },
      ],
    });
  }

  return [
    {
      id: "cilium-policy",
      title: object.kind,
      icon: iconSvg(Network),
      body: { type: "facts", rows },
    },
  ];
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  if (object.group !== GROUP || !KINDS.has(object.kind)) return null;
  return policySections(object, t);
}
