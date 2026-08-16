/**
 * What Traefik's own kinds say about themselves in a peek.
 *
 * The generic custom-resource peek flattens an unknown spec, and an
 * IngressRoute's whole point — the match rule, the priority, the services —
 * sits inside `spec.routes`, where a flattener can only count. This file is
 * the vendor's own reading: the same `readRule` the routing page trusts,
 * pointed at the one object under the cursor.
 */

import type { KeyValue } from "@/components/resources/key-values";
import type { CustomResourceDetailInfo } from "@/generated/types";
import { readRule } from "./rule";

export interface VendorPeekGroup {
  title: string;
  count?: number;
  items: KeyValue[];
  emptyMessage?: string;
}

export interface VendorPeekBody {
  status?: string | null;
  groups: VendorPeekGroup[];
}

interface RouteSpec {
  match?: string;
  priority?: number;
  services?: Array<{
    name?: string;
    port?: unknown;
    kind?: string;
    scheme?: string;
  }>;
  middlewares?: Array<{ name?: string; namespace?: string }>;
}

interface IngressRouteSpec {
  entryPoints?: string[];
  routes?: RouteSpec[];
  tls?: { secretName?: string } | null;
}

const join = (values: string[]) => values.join(" · ");

function tlsRow(spec: IngressRouteSpec): KeyValue {
  if (spec.tls === undefined || spec.tls === null) {
    return {
      label: "TLS",
      value: "none declared — an entry point may still carry it",
    };
  }
  if (spec.tls.secretName) {
    return { label: "TLS", value: spec.tls.secretName, mono: true };
  }
  // `tls: {}` is Traefik's "serve this over TLS with whatever you have".
  return { label: "TLS", value: "the proxy's default certificate" };
}

function routeGroup(route: RouteSpec, index: number, total: number) {
  const raw = route.match ?? "";
  const reading = readRule(raw);
  const hosts = [
    ...new Set(
      reading.clauses.flatMap((clause) => (clause.host ? [clause.host] : []))
    ),
  ];

  const items: KeyValue[] = [
    { label: "Match", value: raw || "(empty)", mono: true },
  ];
  if (reading.refused) {
    items.push({
      label: "Hosts",
      value: `not read — ${reading.refused}`,
      tone: "warn",
    });
  } else if (hosts.length > 0) {
    items.push({ label: "Hosts", value: join(hosts), mono: true });
  }
  items.push({
    label: "Priority",
    value:
      route.priority !== undefined
        ? String(route.priority)
        : `${raw.length} — the rule's length, Traefik's default`,
    mono: route.priority !== undefined,
  });
  for (const service of route.services ?? []) {
    if (!service.name) continue;
    items.push({
      label: "Service",
      value: [
        `${service.name}${service.port === undefined ? "" : ` :${service.port}`}`,
        service.kind === "TraefikService" ? "TraefikService" : null,
        service.scheme === "h2c" ? "h2c — gRPC, not a browser's way in" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    });
  }
  items.push({
    label: "Middlewares",
    value:
      (route.middlewares ?? []).flatMap((middleware) =>
        middleware.name ? [middleware.name] : []
      ).length > 0
        ? join(
            (route.middlewares ?? []).flatMap((middleware) =>
              middleware.name ? [middleware.name] : []
            )
          )
        : "none",
    mono: (route.middlewares ?? []).length > 0,
  });

  return {
    title: total > 1 ? `Route ${index + 1}` : "Route",
    items,
  };
}

export function peekIngressRoute(
  resource: CustomResourceDetailInfo
): VendorPeekBody {
  const spec = (resource.spec ?? {}) as IngressRouteSpec;
  const routes = spec.routes ?? [];

  return {
    groups: [
      {
        title: "Routing",
        items: [
          {
            label: "Entry points",
            value: spec.entryPoints?.length
              ? join(spec.entryPoints)
              : "every entry point — none named",
            mono: Boolean(spec.entryPoints?.length),
          },
          tlsRow(spec),
        ],
      },
      ...routes.map((route, index) => routeGroup(route, index, routes.length)),
    ],
  };
}

/** Scalar settings of the one key a Middleware's spec carries. */
export function peekMiddleware(
  resource: CustomResourceDetailInfo
): VendorPeekBody {
  const spec = (resource.spec ?? {}) as Record<string, unknown>;
  const groups = Object.entries(spec).map(([type, config]) => ({
    title: type,
    items:
      typeof config === "object" && config !== null
        ? Object.entries(config).map(([label, value]): KeyValue => ({
            label,
            value: Array.isArray(value) ? value.join(" · ") : String(value),
            mono: true,
          }))
        : ([{ label: type, value: String(config), mono: true }] as KeyValue[]),
    emptyMessage: "Nothing configured",
  }));
  return {
    groups: groups.length
      ? groups
      : [{ title: "Middleware", items: [], emptyMessage: "An empty spec" }],
  };
}
