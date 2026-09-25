/**
 * What Traefik's own kinds tell a colleague with no cluster access: the same
 * `readRule` the routing page and the peek trust, pointed at one object.
 */

import { Route, Waypoints } from "lucide-react";

import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { readRule } from "./rule";

const GROUPS = /^traefik\.(io|containo\.us)$/;

interface RouteSpec {
  match?: string;
  priority?: number;
  services?: Array<{
    name?: string;
    namespace?: string;
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

function tlsValue(spec: IngressRouteSpec, t: T): ReportValue {
  if (spec.tls === undefined || spec.tls === null) {
    return { text: t("readings", "traefikNoTlsDeclared"), quiet: true };
  }
  if (spec.tls.secretName) return { text: spec.tls.secretName, mono: true };
  return { text: t("readings", "traefikDefaultCertificate"), quiet: true };
}

function serviceValue(
  route: RouteSpec,
  namespace: string | null,
  t: T
): ReportValue {
  const services = (route.services ?? []).filter((service) => service.name);
  if (services.length === 0) return { text: t("empty", "none"), quiet: true };
  if (services.length === 1) {
    const service = services[0]!;
    const kubernetes =
      service.kind !== "TraefikService" && !service.name!.includes("@");
    const detail = service.port === undefined ? "" : `:${service.port}`;
    if (kubernetes) {
      return {
        text: `${service.name}${detail}`,
        mono: true,
        ref: refOf({
          kind: "Service",
          name: service.name!,
          namespace: service.namespace ?? namespace,
        }),
      };
    }
    return { text: `${service.name}${detail}`, mono: true };
  }
  return {
    text: services
      .map((service) =>
        service.port === undefined
          ? service.name
          : `${service.name}:${service.port}`
      )
      .join(", "),
    mono: true,
  };
}

function middlewaresValue(route: RouteSpec, t: T): ReportValue {
  const names = (route.middlewares ?? [])
    .filter((middleware) => middleware.name)
    .map((middleware) => middleware.name!);
  return names.length > 0
    ? { text: names.join(", "), mono: true }
    : { text: t("empty", "none"), quiet: true };
}

function matchValue(route: RouteSpec, t: T): ReportValue {
  const raw = route.match ?? "";
  const reading = readRule(raw);
  if (reading.refused) {
    return {
      text: `${raw || t("empty", "emptyParens")} (${sayWords(reading.refused, t)})`,
      mono: true,
    };
  }
  return { text: raw || t("empty", "emptyParens"), mono: true };
}

function priorityValue(route: RouteSpec): ReportValue {
  return {
    text: route.priority !== undefined ? String(route.priority) : "-",
    mono: route.priority !== undefined,
  };
}

function ingressRouteSections(
  spec: IngressRouteSpec,
  namespace: string | null,
  t: T
): ReportSection[] {
  const routes = spec.routes ?? [];
  return [
    {
      id: "traefik-routing",
      title: t("readings", "traefikRouting"),
      icon: iconSvg(Waypoints),
      body: {
        type: "facts",
        rows: [
          {
            label: t("nav", "entryPoints"),
            values: [
              spec.entryPoints?.length
                ? { text: spec.entryPoints.join(", "), mono: true }
                : {
                    text: t("readings", "traefikEveryEntryPoint"),
                    quiet: true,
                  },
            ],
          },
          { label: "TLS", values: [tlsValue(spec, t)] },
        ],
      },
    },
    {
      id: "traefik-routes",
      title: t("share", "trfSectionRoutes"),
      icon: iconSvg(Route),
      count: routes.length,
      body: {
        type: "table",
        columns: [
          t("columns", "match"),
          t("columns", "priority"),
          t("columns", "service"),
          t("columns", "middlewares"),
        ],
        rows: routes.map((route) => ({
          cells: [
            matchValue(route, t),
            priorityValue(route),
            serviceValue(route, namespace, t),
            middlewaresValue(route, t),
          ],
        })),
        more: null,
      },
    },
  ];
}

function middlewareSections(spec: unknown, t: T): ReportSection[] {
  const entries = Object.entries((spec ?? {}) as Record<string, unknown>);
  return [
    {
      id: "traefik-middleware",
      title: "Middleware",
      icon: iconSvg(Waypoints),
      count: entries.length,
      body: {
        type: "facts",
        rows:
          entries.length > 0
            ? entries.map(([type, config]) => ({
                label: type,
                values: [
                  typeof config === "object" && config !== null
                    ? {
                        text: Object.entries(config as Record<string, unknown>)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(", "),
                        mono: true,
                      }
                    : { text: String(config), mono: true },
                ],
              }))
            : [{ label: t("empty", "anEmptySpec"), values: [] }],
      },
    },
  ];
}

function scalarFactsSection(
  id: string,
  title: string,
  spec: unknown,
  t: T
): ReportSection[] {
  const fields = Object.entries((spec ?? {}) as Record<string, unknown>).filter(
    ([, value]) => typeof value !== "object" || value === null
  );
  return [
    {
      id,
      title,
      icon: iconSvg(Waypoints),
      count: fields.length,
      body: {
        type: "facts",
        rows:
          fields.length > 0
            ? fields.map(([key, value]) => ({
                label: key,
                values: [{ text: String(value), mono: true }],
              }))
            : [{ label: t("empty", "anEmptySpec"), values: [] }],
      },
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
  if (!GROUPS.test(object.group)) return null;
  switch (object.kind) {
    case "IngressRoute":
      return ingressRouteSections(
        (object.spec ?? {}) as IngressRouteSpec,
        object.namespace,
        t
      );
    case "Middleware":
      return middlewareSections(object.spec, t);
    case "TraefikService":
      return scalarFactsSection(
        "traefik-service",
        "TraefikService",
        object.spec,
        t
      );
    case "ServersTransport":
      return scalarFactsSection(
        "traefik-servers-transport",
        "ServersTransport",
        object.spec,
        t
      );
    case "TLSOption":
      return scalarFactsSection(
        "traefik-tls-option",
        "TLSOption",
        object.spec,
        t
      );
    default:
      return null;
  }
}
