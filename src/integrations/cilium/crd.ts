/**
 * Cilium's own objects.
 *
 * The policy kinds carry the column the vanilla list cannot: whether the
 * agent accepted the policy. Everything else here is Cilium's runtime view
 * of the cluster — identities, endpoints, nodes — where the useful column is
 * the one that says what a number stands for.
 */

import type { CrdColumn, CrdStatus } from "../kit";
import { getValueByPath, matchByGroup } from "../kit";
import type { CrdView } from "../registry";
import {
  directionsOf,
  enforcementOf,
  leavesTheCluster,
  selectionOf,
} from "./model";

const policyColumns: CrdColumn[] = [
  {
    // First, and a column rather than the view's `status`: nothing reads
    // that on a list, and a rejected policy that is only visible once
    // somebody opens it is a rejected policy nobody sees. No `cell`, so the
    // list draws the word as a badge — `valid` and `rejected` are in
    // `statusRole`'s table, or it would be grey.
    id: "inForce",
    header: "ciliumInForce",
    accessor: (policy) => {
      const enforcement = enforcementOf(policy);
      switch (enforcement.state) {
        case "enforced":
          return "Valid";
        case "rejected":
          return "Rejected";
        case "notSaid":
          return null;
      }
    },
  },
  {
    id: "selects",
    header: "ciliumSelects",
    accessor: (policy) => selectionOf(policy),
    cell: (value, t) => {
      const selection = value as ReturnType<typeof selectionOf>;
      switch (selection.kind) {
        case "labels":
          return selection.said;
        case "expressions":
          return t("readings", "ciliumSelectsByExpression", {
            n: selection.count,
          });
        case "all":
          return t("readings", "ciliumSelectsAll");
      }
    },
  },
  {
    id: "rules",
    header: "ciliumRules",
    accessor: (policy) => directionsOf(policy),
    cell: (value, t) => {
      const rules = value as ReturnType<typeof directionsOf>;
      if (rules.ingress + rules.egress === 0)
        return t("readings", "ciliumNoRules");
      const said = t("readings", "ciliumDirections", {
        ingress: rules.ingress,
        egress: rules.egress,
      });
      return rules.denies > 0
        ? `${said} · ${t("readings", "ciliumDenies", { n: rules.denies })}`
        : said;
    },
  },
  {
    id: "reach",
    header: "ciliumReach",
    accessor: (policy) => leavesTheCluster(policy),
    cell: (value, t) =>
      value === true ? t("readings", "ciliumLeavesCluster") : "—",
  },
];

const endpointColumns: CrdColumn[] = [
  {
    id: "identity",
    header: "identity",
    accessor: (endpoint) => getValueByPath(endpoint, "status.identity.id"),
  },
  {
    id: "state",
    header: "state",
    accessor: (endpoint) => getValueByPath(endpoint, "status.state"),
  },
  {
    id: "podIp",
    header: "podIp",
    accessor: (endpoint) => {
      const addressing = getValueByPath(
        endpoint,
        "status.networking.addressing"
      ) as Array<{ ipv4?: string; ipv6?: string }> | undefined;
      const first = addressing?.[0];
      return first?.ipv4 ?? first?.ipv6 ?? null;
    },
  },
];

const identityColumns: CrdColumn[] = [
  {
    id: "namespace",
    header: "namespace",
    accessor: (identity) =>
      identity.labels["io.kubernetes.pod.namespace"] ?? null,
  },
  {
    id: "securityLabels",
    header: "ciliumSecurityLabels",
    accessor: (identity) => {
      const labels = getValueByPath(identity, "security-labels") as
        Record<string, string> | undefined;
      return Object.keys(labels ?? {}).length;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? String(value) : "—",
  },
];

/**
 * **Silence is not acceptance.** A policy the agent has not answered about
 * is drawn as unknown rather than as healthy, which is the one thing a
 * `Ready`-shaped reader of these objects would get wrong: Cilium writes the
 * `Valid` condition only once it has looked, and a policy it is not running
 * at all never gets one.
 */
const policyStatus: CrdStatus = {
  getStatus: (policy) => {
    const enforcement = enforcementOf(policy as never);
    switch (enforcement.state) {
      case "enforced":
        return "Valid";
      case "rejected":
        return "Rejected";
      case "notSaid":
        return null;
    }
  },
  getVariant: (status) =>
    status === "Valid"
      ? "default"
      : status === "Rejected"
        ? "destructive"
        : "outline",
};

export const crd: CrdView = {
  matches: matchByGroup("cilium.io"),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "ciliumnetworkpolicy":
      case "ciliumclusterwidenetworkpolicy":
        return policyColumns;
      case "ciliumendpoint":
        return endpointColumns;
      case "ciliumidentity":
        return identityColumns;
      default:
        return policyColumns;
    }
  },
  status: policyStatus,
};
