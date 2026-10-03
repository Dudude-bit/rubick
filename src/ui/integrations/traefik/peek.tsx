/**
 * What Traefik's own kinds say about themselves in a peek.
 *
 * The generic custom-resource peek flattens an unknown spec, and an
 * IngressRoute's whole point — the match rule, the priority, the services —
 * sits inside `spec.routes`, where a flattener can only count. This file is
 * the vendor's own reading: the same `readRule` the routing page trusts,
 * pointed at the one object under the cursor.
 */

import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { ResourceRef } from "@/components/resources/ResourceRef";
import type { KeyValue } from "@/components/resources/key-values";
import type { CustomResourceDetailInfo } from "@/generated/types";
import { servedGroupName } from "./data";
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

function tlsRow(spec: IngressRouteSpec, t: T): KeyValue {
  if (spec.tls === undefined || spec.tls === null) {
    return {
      label: "TLS",
      value: t("readings", "traefikNoTlsDeclared"),
    };
  }
  if (spec.tls.secretName) {
    return { label: "TLS", value: spec.tls.secretName, mono: true };
  }
  // `tls: {}` is Traefik's "serve this over TLS with whatever you have".
  return { label: "TLS", value: t("readings", "traefikDefaultCertificate") };
}

function routeGroup(
  route: RouteSpec,
  index: number,
  total: number,
  namespace: string | null,
  t: T
) {
  const raw = route.match ?? "";
  const reading = readRule(raw);
  const hosts = [
    ...new Set(
      reading.clauses.flatMap((clause) => (clause.host ? [clause.host] : []))
    ),
  ];

  const items: KeyValue[] = [
    {
      label: t("columns", "match"),
      value: raw || t("empty", "emptyParens"),
      mono: true,
    },
  ];
  if (reading.refused) {
    items.push({
      label: t("columns", "hosts"),
      value: t("readings", "traefikNotRead", {
        why: sayWords(reading.refused, t),
      }),
      tone: "warn",
    });
  } else if (hosts.length > 0) {
    items.push({
      label: t("columns", "hosts"),
      value: join(hosts),
      mono: true,
    });
  }
  items.push({
    label: t("columns", "priority"),
    value:
      route.priority !== undefined
        ? String(route.priority)
        : t("readings", "traefikPriorityDefault", { n: raw.length }),
    mono: route.priority !== undefined,
  });
  for (const service of route.services ?? []) {
    if (!service.name) continue;
    // A real Service is the next hop down and links to its own peek;
    // Traefik's internals have nowhere to go and stay words.
    const kubernetes =
      service.kind !== "TraefikService" && !service.name.includes("@");
    const detail = [
      service.port === undefined ? null : `:${service.port}`,
      service.kind === "TraefikService" ? "TraefikService" : null,
      service.scheme === "h2c" ? t("readings", "traefikH2c") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push({
      label: t("columns", "service"),
      value: kubernetes ? (
        <>
          <ResourceRef
            kind="Service"
            name={service.name}
            namespace={namespace}
            showKind={false}
          />
          {detail && <span className="ml-1.5 text-fg-fnt">{detail}</span>}
        </>
      ) : (
        [service.name, detail].filter(Boolean).join(" ")
      ),
      mono: true,
    });
  }
  const middlewares = (route.middlewares ?? []).flatMap((middleware) =>
    middleware.name
      ? [{ name: middleware.name, namespace: middleware.namespace ?? null }]
      : []
  );
  items.push({
    label: t("columns", "middlewares"),
    value:
      middlewares.length > 0 ? (
        <span className="flex flex-wrap gap-x-1.5">
          {middlewares.map((middleware, at) => (
            <span key={`${middleware.namespace}/${middleware.name}`}>
              {at > 0 && <span className="text-fg-fnt">· </span>}
              <ResourceRef
                kind="Middleware"
                name={middleware.name}
                namespace={middleware.namespace ?? namespace}
                crd={`middlewares.${servedGroupName()}`}
                showKind={false}
              />
            </span>
          ))}
        </span>
      ) : (
        t("empty", "none")
      ),
    mono: middlewares.length > 0,
  });

  return {
    title:
      total > 1
        ? t("readings", "traefikRouteNumber", { n: index + 1 })
        : t("readings", "traefikRoute"),
    items,
  };
}

export function peekIngressRoute(
  resource: CustomResourceDetailInfo,
  t: T
): VendorPeekBody {
  const spec = (resource.spec ?? {}) as IngressRouteSpec;
  const routes = spec.routes ?? [];

  return {
    groups: [
      {
        title: t("readings", "traefikRouting"),
        items: [
          {
            label: t("nav", "entryPoints"),
            value: spec.entryPoints?.length
              ? join(spec.entryPoints)
              : t("readings", "traefikEveryEntryPoint"),
            mono: Boolean(spec.entryPoints?.length),
          },
          tlsRow(spec, t),
        ],
      },
      ...routes.map((route, index) =>
        routeGroup(route, index, routes.length, resource.namespace, t)
      ),
    ],
  };
}

/** Scalar settings of the one key a Middleware's spec carries. */
export function peekMiddleware(
  resource: CustomResourceDetailInfo,
  t: T
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
    emptyMessage: t("empty", "nothingConfigured"),
  }));
  return {
    groups: groups.length
      ? groups
      : [
          {
            title: "Middleware",
            items: [],
            emptyMessage: t("empty", "anEmptySpec"),
          },
        ],
  };
}
