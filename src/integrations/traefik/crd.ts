/**
 * Traefik's own custom resources: IngressRoute, Middleware, TLSOption and
 * the rest of the routing objects it configures itself with.
 *
 * A Traefik cluster does not use Ingress; it uses IngressRoute, and a
 * printer column shows neither the hosts it serves nor the services it
 * sends them to.
 */

import type { CrdColumn } from "../kit";
import { getValueByPath, matchByPattern, NO_STATUS } from "../kit";
import type { CrdView } from "../registry";

/**
 * Columns for IngressRoute list
 */
const ingressRouteColumns: CrdColumn[] = [
  {
    id: "entryPoints",
    header: "entryPoints",
    accessor: (resource) => {
      const entryPoints = getValueByPath(resource, "spec.entryPoints") as
        string[] | undefined;
      return entryPoints ?? [];
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      return value.join(", ");
    },
  },
  {
    id: "hosts",
    header: "hosts",
    accessor: (resource) => {
      const routes = getValueByPath(resource, "spec.routes") as
        Array<{ match?: string }> | undefined;
      if (!routes) return [];

      // Extract hosts from match rules like "Host(`example.com`)"
      const hosts = new Set<string>();
      for (const route of routes) {
        if (route.match) {
          const hostMatches = route.match.matchAll(/Host\(`([^`]+)`\)/g);
          for (const match of hostMatches) {
            hosts.add(match[1]);
          }
        }
      }
      return Array.from(hosts);
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return value[0];
      return `${value[0]} +${value.length - 1}`;
    },
  },
  {
    id: "services",
    header: "services",
    accessor: (resource) => {
      const routes = getValueByPath(resource, "spec.routes") as
        | Array<{
            services?: Array<{ name: string; port?: number }>;
          }>
        | undefined;

      if (!routes) return [];

      const services = new Set<string>();
      for (const route of routes) {
        if (route.services) {
          for (const svc of route.services) {
            services.add(svc.port ? `${svc.name}:${svc.port}` : svc.name);
          }
        }
      }
      return Array.from(services);
    },
    cell: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "-";
      if (value.length === 1) return value[0];
      return `${value.length} services`;
    },
  },
  {
    id: "middlewares",
    header: "middlewares",
    accessor: (resource) => {
      const routes = getValueByPath(resource, "spec.routes") as
        | Array<{
            middlewares?: Array<{ name: string }>;
          }>
        | undefined;

      if (!routes) return 0;

      const middlewares = new Set<string>();
      for (const route of routes) {
        if (route.middlewares) {
          for (const mw of route.middlewares) {
            middlewares.add(mw.name);
          }
        }
      }
      return middlewares.size;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value}` : "-",
  },
  {
    id: "tls",
    header: "tls",
    accessor: (resource) => {
      const tls = getValueByPath(resource, "spec.tls") as
        | {
            secretName?: string;
            certResolver?: string;
          }
        | undefined;

      if (!tls) return "No";
      if (tls.certResolver) return `Resolver: ${tls.certResolver}`;
      if (tls.secretName) return `Secret: ${tls.secretName}`;
      return "Yes";
    },
    cell: (value) => String(value ?? "-"),
  },
];

/**
 * Columns for Middleware list
 */
const middlewareColumns: CrdColumn[] = [
  {
    id: "type",
    header: "type",
    accessor: (resource) => {
      const spec = getValueByPath(resource, "spec") as
        Record<string, unknown> | undefined;
      if (!spec) return "Unknown";

      // Detect middleware type based on spec fields
      const types = [
        "addPrefix",
        "basicAuth",
        "buffering",
        "chain",
        "circuitBreaker",
        "compress",
        "contentType",
        "digestAuth",
        "errors",
        "forwardAuth",
        "headers",
        "inFlightReq",
        "ipWhiteList",
        "ipAllowList",
        "passTLSClientCert",
        "plugin",
        "rateLimit",
        "redirectRegex",
        "redirectScheme",
        "replacePath",
        "replacePathRegex",
        "retry",
        "stripPrefix",
        "stripPrefixRegex",
      ];

      for (const type of types) {
        if (spec[type]) return type;
      }
      return "Unknown";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "details",
    header: "details",
    accessor: (resource, t) => {
      const spec = getValueByPath(resource, "spec") as
        Record<string, unknown> | undefined;
      if (!spec) return null;

      // Extract relevant details based on type
      if (spec.stripPrefix) {
        const stripPrefix = spec.stripPrefix as { prefixes?: string[] };
        return stripPrefix.prefixes?.join(", ");
      }
      if (spec.addPrefix) {
        const addPrefix = spec.addPrefix as { prefix?: string };
        return addPrefix.prefix;
      }
      if (spec.rateLimit) {
        const rateLimit = spec.rateLimit as {
          average?: number;
          burst?: number;
        };
        return `${rateLimit.average ?? 0}/s, burst: ${rateLimit.burst ?? 0}`;
      }
      if (spec.redirectScheme) {
        const redirect = spec.redirectScheme as {
          scheme?: string;
          permanent?: boolean;
        };
        return `→ ${redirect.scheme ?? "https"}${redirect.permanent ? " (301)" : " (302)"}`;
      }
      if (spec.basicAuth || spec.digestAuth || spec.forwardAuth) {
        return t("readings", "traefikAuthEnabled");
      }
      if (spec.headers) {
        return t("readings", "traefikCustomHeaders");
      }
      if (spec.chain) {
        const chain = spec.chain as { middlewares?: Array<{ name: string }> };
        return chain.middlewares?.map((m) => m.name).join(" → ");
      }

      return null;
    },
    cell: (value) => String(value ?? "-"),
  },
];

/**
 * Columns for TLSOption list
 */
const tlsOptionColumns: CrdColumn[] = [
  {
    id: "minVersion",
    header: "minVersion",
    accessor: (resource) => getValueByPath(resource, "spec.minVersion"),
    cell: (value) => String(value ?? "Default"),
  },
  {
    id: "maxVersion",
    header: "maxVersion",
    accessor: (resource) => getValueByPath(resource, "spec.maxVersion"),
    cell: (value) => String(value ?? "Default"),
  },
  {
    id: "cipherSuites",
    header: "cipherSuites",
    accessor: (resource) => {
      const cipherSuites = getValueByPath(resource, "spec.cipherSuites") as
        string[] | undefined;
      return cipherSuites?.length ?? 0;
    },
    cell: (value) =>
      typeof value === "number" && value > 0 ? `${value} suites` : "Default",
  },
  {
    id: "sniStrict",
    header: "sniStrict",
    accessor: (resource) => getValueByPath(resource, "spec.sniStrict"),
    cell: (value) => (value === true ? "Yes" : "No"),
  },
];

/**
 * Both API groups: `traefik.containo.us` is what a cluster that has not
 * been through the v3 migration still serves.
 *
 * Traefik's objects carry no status at all — the proxy's opinion of a route
 * lives in its own dashboard, not on the resource — so nothing is claimed
 * about their health.
 */
export const crd: CrdView = {
  matches: matchByPattern(/^traefik\.(io|containo\.us)$/),
  columnsFor: (kind) => {
    const kindLower = kind.toLowerCase();
    if (kindLower.includes("ingressroute")) return ingressRouteColumns;
    if (kindLower.includes("middleware")) return middlewareColumns;
    if (kindLower.includes("tlsoption")) return tlsOptionColumns;
    return ingressRouteColumns;
  },
  status: NO_STATUS,
};
