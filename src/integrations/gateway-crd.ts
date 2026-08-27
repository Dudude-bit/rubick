/**
 * Columns for the Gateway API group in the generic CRD list.
 *
 * The dedicated pages exist, and this stays beside them on purpose — the
 * Istio precedent: somebody who reached `httproutes.gateway.networking.k8s.io`
 * from the CRD list still wants columns rather than raw YAML. Not a vendor
 * facet, because Gateway API is not a vendor; the resolver checks this view
 * before asking the vendors.
 */

import type { CrdColumn } from "./kit";
import { conditionStatus, getValueByPath, matchByGroup } from "./kit";
import type { CrdView } from "./registry";

function names(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  if (value.length === 1) return String(value[0]);
  return `${value[0]} +${value.length - 1}`;
}

const routeColumns: CrdColumn[] = [
  {
    id: "hostnames",
    header: "hostnames",
    accessor: (resource) =>
      (getValueByPath(resource, "spec.hostnames") as string[] | undefined) ??
      [],
    cell: names,
  },
  {
    id: "parents",
    header: "attachesTo",
    accessor: (resource) => {
      const parents = getValueByPath(resource, "spec.parentRefs") as
        Array<{ name?: string; kind?: string }> | undefined;
      return (parents ?? []).map((parent) =>
        parent.kind && parent.kind !== "Gateway"
          ? `${parent.name} (${parent.kind})`
          : (parent.name ?? "?")
      );
    },
    cell: names,
  },
  {
    id: "rules",
    header: "rules",
    accessor: (resource) =>
      (getValueByPath(resource, "spec.rules") as unknown[] | undefined)
        ?.length ?? 0,
    cell: (value) => String(value ?? 0),
  },
];

const backendTlsPolicyColumns: CrdColumn[] = [
  {
    id: "targets",
    header: "targets",
    accessor: (resource) => {
      const targets = getValueByPath(resource, "spec.targetRefs") as
        Array<{ name?: string; kind?: string }> | undefined;
      return (targets ?? []).map((target) =>
        target.kind && target.kind !== "Service"
          ? `${target.name} (${target.kind})`
          : (target.name ?? "?")
      );
    },
    cell: names,
  },
  {
    id: "hostname",
    header: "sni",
    accessor: (resource) =>
      getValueByPath(resource, "spec.validation.hostname"),
    cell: (value) => String(value ?? "—"),
  },
  {
    id: "trust",
    header: "trusts",
    accessor: (resource) => {
      const wellKnown = getValueByPath(
        resource,
        "spec.validation.wellKnownCACertificates"
      );
      if (wellKnown) return `${wellKnown} bundle`;
      const refs = getValueByPath(
        resource,
        "spec.validation.caCertificateRefs"
      ) as Array<{ name?: string }> | undefined;
      return (refs ?? []).map((ref) => ref.name ?? "?");
    },
    cell: (value) =>
      Array.isArray(value) ? names(value) : String(value ?? "—"),
  },
];

const gatewayColumns: CrdColumn[] = [
  {
    id: "class",
    header: "class",
    accessor: (resource) => getValueByPath(resource, "spec.gatewayClassName"),
    cell: (value) => String(value ?? "—"),
  },
  {
    id: "listeners",
    header: "listeners",
    accessor: (resource) => {
      const listeners = getValueByPath(resource, "spec.listeners") as
        | Array<{ protocol?: string; port?: number; hostname?: string }>
        | undefined;
      return (listeners ?? []).map(
        (listener) =>
          `${listener.protocol ?? "?"}:${listener.port ?? "?"}${
            listener.hostname ? ` ${listener.hostname}` : ""
          }`
      );
    },
    cell: names,
  },
  {
    id: "addresses",
    header: "addresses",
    accessor: (resource) => {
      const addresses = getValueByPath(resource, "status.addresses") as
        Array<{ value?: string }> | undefined;
      return (addresses ?? []).map((address) => address.value ?? "?");
    },
    cell: names,
  },
];

const gatewayClassColumns: CrdColumn[] = [
  {
    id: "controller",
    header: "controller",
    accessor: (resource) => getValueByPath(resource, "spec.controllerName"),
    cell: (value) => String(value ?? "—"),
  },
];

const listenerSetColumns: CrdColumn[] = [
  {
    id: "gateway",
    header: "gateway",
    accessor: (resource) => getValueByPath(resource, "spec.parentRef.name"),
    cell: (value) => String(value ?? "—"),
  },
  {
    id: "listeners",
    header: "listeners",
    accessor: (resource) =>
      (getValueByPath(resource, "spec.listeners") as unknown[] | undefined)
        ?.length ?? 0,
    cell: (value) => String(value ?? 0),
  },
];

const referenceGrantColumns: CrdColumn[] = [
  {
    id: "from",
    header: "grantFrom",
    accessor: (resource) => {
      const from = getValueByPath(resource, "spec.from") as
        Array<{ kind?: string; namespace?: string }> | undefined;
      return (from ?? []).map(
        (entry) => `${entry.kind ?? "?"} in ${entry.namespace ?? "?"}`
      );
    },
    cell: names,
  },
  {
    id: "to",
    header: "grantTo",
    accessor: (resource) => {
      const to = getValueByPath(resource, "spec.to") as
        Array<{ kind?: string }> | undefined;
      return (to ?? []).map((entry) => entry.kind ?? "?");
    },
    cell: names,
  },
];

export const gatewayCrd: CrdView = {
  matches: matchByGroup("gateway.networking.k8s.io"),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "gateway":
        return gatewayColumns;
      case "gatewayclass":
        return gatewayClassColumns;
      case "listenerset":
        return listenerSetColumns;
      case "referencegrant":
        return referenceGrantColumns;
      case "backendtlspolicy":
        return backendTlsPolicyColumns;
      default:
        return routeColumns;
    }
  },
  // Every kind in the group writes Accepted — for a GatewayClass it is the
  // claim itself, for a Gateway and a route it is the controller's consent.
  status: conditionStatus("Accepted"),
};
