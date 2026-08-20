/**
 * Istio's networking, security and telemetry objects.
 *
 * The mesh's whole configuration is custom resources, so a flat list of
 * anonymous rows is the entire picture a vanilla view gives of it.
 */

import type { CrdColumn } from "../kit";
import { getValueByPath, NO_STATUS } from "../kit";
import type { CrdView } from "../registry";

/**
 * Columns for VirtualService list
 */
const virtualServiceColumns: CrdColumn[] = [
  {
    id: "hosts",
    header: "Hosts",
    accessor: (resource) => {
      const hosts = getValueByPath(resource, "spec.hosts") as
        string[] | undefined;
      return hosts ?? [];
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return String(value[0]);
      return `${value[0]} +${value.length - 1}`;
    },
  },
  {
    id: "gateways",
    header: "Gateways",
    accessor: (resource) => {
      const gateways = getValueByPath(resource, "spec.gateways") as
        string[] | undefined;
      return gateways ?? [];
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "mesh";
      return value.join(", ");
    },
  },
  {
    id: "httpRoutes",
    header: "HTTP Routes",
    accessor: (resource) => {
      const http = getValueByPath(resource, "spec.http") as
        unknown[] | undefined;
      return http?.length ?? 0;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value}` : "-",
  },
  {
    id: "tcpRoutes",
    header: "TCP Routes",
    accessor: (resource) => {
      const tcp = getValueByPath(resource, "spec.tcp") as unknown[] | undefined;
      return tcp?.length ?? 0;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value}` : "-",
  },
  {
    id: "destinations",
    header: "Destinations",
    accessor: (resource) => {
      const http = getValueByPath(resource, "spec.http") as
        | Array<{
            route?: Array<{ destination?: { host: string } }>;
          }>
        | undefined;

      if (!http) return [];

      const destinations = new Set<string>();
      for (const route of http) {
        if (route.route) {
          for (const r of route.route) {
            if (r.destination?.host) {
              destinations.add(r.destination.host);
            }
          }
        }
      }
      return Array.from(destinations);
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return String(value[0]);
      return `${value.length} services`;
    },
  },
];

/**
 * Columns for DestinationRule list
 */
const destinationRuleColumns: CrdColumn[] = [
  {
    id: "host",
    header: "Host",
    accessor: (resource) => getValueByPath(resource, "spec.host"),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "trafficPolicy",
    header: "Traffic Policy",
    accessor: (resource) => {
      const policy = getValueByPath(resource, "spec.trafficPolicy") as
        Record<string, unknown> | undefined;
      if (!policy) return "None";

      const features: string[] = [];
      if (policy.connectionPool) features.push("ConnectionPool");
      if (policy.loadBalancer) features.push("LoadBalancer");
      if (policy.outlierDetection) features.push("OutlierDetection");
      if (policy.tls) features.push("TLS");

      return features.length > 0 ? features.join(", ") : "Default";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "subsets",
    header: "Subsets",
    accessor: (resource) => {
      const subsets = getValueByPath(resource, "spec.subsets") as
        Array<{ name: string }> | undefined;
      return subsets?.map((s) => s.name) ?? [];
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      return value.join(", ");
    },
  },
  {
    id: "exportTo",
    header: "Export To",
    accessor: (resource) => {
      const exportTo = getValueByPath(resource, "spec.exportTo") as
        string[] | undefined;
      return exportTo ?? ["*"];
    },
    cell: (value) => {
      if (!Array.isArray(value)) return "*";
      if (value.includes("*")) return "All namespaces";
      if (value.includes(".")) return "Same namespace";
      return value.join(", ");
    },
  },
];

/**
 * Columns for Gateway list
 */
const gatewayColumns: CrdColumn[] = [
  {
    id: "selector",
    header: "Selector",
    accessor: (resource) => {
      const selector = getValueByPath(resource, "spec.selector") as
        Record<string, string> | undefined;
      if (!selector) return null;

      // Common pattern: istio: ingressgateway
      if (selector.istio) return `istio=${selector.istio}`;

      return Object.entries(selector)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "servers",
    header: "Servers",
    accessor: (resource) => {
      const servers = getValueByPath(resource, "spec.servers") as
        | Array<{
            port?: { number?: number; protocol?: string };
            hosts?: string[];
          }>
        | undefined;

      if (!servers) return [];

      return servers.map((s) => {
        const port = s.port?.number ?? "?";
        const protocol = s.port?.protocol ?? "HTTP";
        const hosts = s.hosts?.join(", ") ?? "*";
        return `${protocol}:${port} → ${hosts}`;
      });
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return String(value[0]);
      return `${value.length} servers`;
    },
  },
  {
    id: "tlsEnabled",
    header: "TLS",
    accessor: (resource) => {
      const servers = getValueByPath(resource, "spec.servers") as
        | Array<{
            tls?: { mode?: string };
          }>
        | undefined;

      if (!servers) return false;
      return servers.some((s) => s.tls && s.tls.mode !== "PASSTHROUGH");
    },
    cell: (value) => (value ? "Yes" : "No"),
  },
];

/**
 * Columns for ServiceEntry list
 */
const serviceEntryColumns: CrdColumn[] = [
  {
    id: "hosts",
    header: "Hosts",
    accessor: (resource) => {
      const hosts = getValueByPath(resource, "spec.hosts") as
        string[] | undefined;
      return hosts ?? [];
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return String(value[0]);
      return `${value[0]} +${value.length - 1}`;
    },
  },
  {
    id: "location",
    header: "Location",
    accessor: (resource) => getValueByPath(resource, "spec.location"),
    cell: (value) => String(value ?? "MESH_EXTERNAL"),
  },
  {
    id: "resolution",
    header: "Resolution",
    accessor: (resource) => getValueByPath(resource, "spec.resolution"),
    cell: (value) => String(value ?? "NONE"),
  },
  {
    id: "ports",
    header: "Ports",
    accessor: (resource) => {
      const ports = getValueByPath(resource, "spec.ports") as
        | Array<{
            number?: number;
            protocol?: string;
          }>
        | undefined;

      if (!ports) return [];
      return ports.map((p) => `${p.protocol ?? "TCP"}:${p.number ?? "?"}`);
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      return value.join(", ");
    },
  },
  {
    id: "endpoints",
    header: "Endpoints",
    accessor: (resource) => {
      const endpoints = getValueByPath(resource, "spec.endpoints") as
        unknown[] | undefined;
      return endpoints?.length ?? 0;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value}` : "-",
  },
];

/**
 * Columns for AuthorizationPolicy list
 */
const authorizationPolicyColumns: CrdColumn[] = [
  {
    id: "action",
    header: "Action",
    accessor: (resource) => getValueByPath(resource, "spec.action"),
    cell: (value) => String(value ?? "ALLOW"),
  },
  {
    id: "selector",
    header: "Selector",
    accessor: (resource) => {
      const selector = getValueByPath(resource, "spec.selector.matchLabels") as
        Record<string, string> | undefined;
      if (!selector) return "All workloads";

      return Object.entries(selector)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "rules",
    header: "Rules",
    accessor: (resource) => {
      const rules = getValueByPath(resource, "spec.rules") as
        unknown[] | undefined;
      return rules?.length ?? 0;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value} rules` : "No rules",
  },
];

/**
 * The three groups a mesh's configuration is spread across. Istio's objects
 * do not report conditions, so nothing is claimed about their health.
 */
export const crd: CrdView = {
  matches: (group) => {
    const normalizedGroup = group.toLowerCase();
    return (
      normalizedGroup === "networking.istio.io" ||
      normalizedGroup === "security.istio.io" ||
      normalizedGroup === "telemetry.istio.io"
    );
  },
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "virtualservice":
        return virtualServiceColumns;
      case "destinationrule":
        return destinationRuleColumns;
      case "gateway":
        return gatewayColumns;
      case "serviceentry":
        return serviceEntryColumns;
      case "authorizationpolicy":
      case "peerauthentication":
      case "requestauthentication":
        return authorizationPolicyColumns;
      default:
        return virtualServiceColumns;
    }
  },
  status: NO_STATUS,
};
