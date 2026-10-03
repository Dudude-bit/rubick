/**
 * Cilium's policy objects.
 *
 * **Only the kinds this file understands.** Cilium creates ten kinds in
 * `cilium.io`, and a vendor's columns *replace* the CRD's own printer
 * columns — so claiming the whole group and defaulting to the policy
 * columns told a `CiliumNode` that it selected every endpoint in the cluster
 * and denied them everything, while throwing away the two columns the CRD
 * itself declares. A kind this file has nothing to say about gets no columns
 * and keeps its own.
 */

import type { CrdColumn } from "../kit";
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
    // that on a list, and a rejected policy only visible once somebody
    // opens it is a rejected policy nobody sees. No `cell`, so the list
    // draws the word as a badge — `valid` and `rejected` are in
    // `statusRole`'s table, or it would be grey.
    id: "inForce",
    header: "ciliumInForce",
    accessor: (policy) => {
      const enforcement = enforcementOf(policy);
      switch (enforcement.state) {
        case "accepted":
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
          return selection.andExpressions > 0
            ? `${selection.said} ${t("readings", "ciliumAndExpressions", {
                n: selection.andExpressions,
              })}`
            : selection.said;
        case "expressions":
          return t("readings", "ciliumSelectsByExpression", {
            n: selection.count,
          });
        case "all":
          return t("readings", "ciliumSelectsAll");
        case "nodes":
          return t("readings", "ciliumSelectsNodes");
        case "notHere":
          return t("readings", "ciliumNotOnTheWire");
      }
    },
  },
  {
    id: "rules",
    header: "ciliumRules",
    accessor: (policy) => directionsOf(policy),
    cell: (value, t) => {
      const rules = value as ReturnType<typeof directionsOf>;
      if (rules === null) return t("readings", "ciliumNotOnTheWire");
      // Said as a count, never as a verdict. What Cilium does to an endpoint
      // selected by a policy with no rule in a direction depends on every
      // other policy selecting it, and this column reads one object.
      const said = `${t("readings", "ciliumIngressRules", {
        n: rules.ingress,
      })} · ${t("readings", "ciliumEgressRules", { n: rules.egress })}`;
      return rules.denies > 0
        ? `${said} · ${t("readings", "ciliumDenies", { n: rules.denies })}`
        : said;
    },
  },
  {
    id: "reach",
    header: "ciliumReach",
    accessor: (policy) => leavesTheCluster(policy),
    cell: (value, t) => {
      if (value === null) return t("readings", "ciliumNotOnTheWire");
      return value === true ? t("readings", "ciliumLeavesCluster") : "—";
    },
  },
];

/**
 * A Cilium endpoint is one per pod. The identity number is the thing worth
 * a column: it is what every policy decision is actually made against, and
 * it is nowhere else in the app.
 *
 * `cell`s on all three on purpose — without one the list draws a bare string
 * as a status badge, and a pod IP is not a status.
 */
const endpointColumns: CrdColumn[] = [
  {
    id: "identity",
    header: "identity",
    accessor: (endpoint) => getValueByPath(endpoint, "status.identity.id"),
    cell: (value) => (typeof value === "number" ? String(value) : "—"),
  },
  {
    id: "state",
    header: "state",
    accessor: (endpoint) => getValueByPath(endpoint, "status.state"),
    cell: (value) => (typeof value === "string" ? value : "—"),
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
    cell: (value) => (typeof value === "string" ? value : "—"),
  },
];

export const crd: CrdView = {
  matches: matchByGroup("cilium.io"),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "ciliumnetworkpolicy":
      case "ciliumclusterwidenetworkpolicy":
        return policyColumns;
      case "ciliumendpoint":
        return endpointColumns;
      // Everything else Cilium creates — nodes, identities, IP pools, CIDR
      // groups, BGP and L2 configuration — keeps the printer columns its own
      // CRD declares. Columns here would replace them with a policy's.
      default:
        return [];
    }
  },
  // Read by no surface in this app; the verdict is the first column instead.
};
