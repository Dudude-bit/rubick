/**
 * What Istio's own kinds say about one object, read from its spec alone: the
 * full picture in `./model.ts` needs the mesh's other objects to resolve a
 * host to a Service or a subset to a DestinationRule, which `object.report`
 * does not have. `resolveHost` is still reused, with `servicesKnown: false`,
 * so an ambiguous host reads as unconfirmed rather than as a claim either way.
 */

import { Waypoints } from "lucide-react";

import type { T } from "@/i18n/useT";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { describeMatch, readMatches } from "./match";
import { resolveHost } from "./model";
import { iconSvg } from "@/lib/icon-svg";

const GROUPS = /\.istio\.io$/;

function at(object: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    object
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface RouteSpec {
  name?: string;
  match?: unknown;
  route?: Array<{
    destination?: {
      host?: string;
      subset?: string;
      port?: { number?: number };
    };
    weight?: number;
  }>;
}

function destinationText(
  leg: NonNullable<RouteSpec["route"]>[number],
  namespace: string
): ReportValue {
  const host = leg.destination?.host ?? "";
  const subset = leg.destination?.subset ? `[${leg.destination.subset}]` : "";
  const port = leg.destination?.port?.number
    ? `:${leg.destination.port.number}`
    : "";
  const weight = leg.weight !== undefined ? ` ${leg.weight}%` : "";
  const resolved = resolveHost(host, namespace, [], false);
  return {
    text: `${host}${subset}${port}${weight}`,
    mono: true,
    ref:
      resolved.service && resolved.external !== true
        ? refOf({
            kind: "Service",
            name: resolved.service.name,
            namespace: resolved.service.namespace,
          })
        : undefined,
  };
}

function virtualServiceSections(
  spec: unknown,
  namespace: string,
  t: T
): ReportSection[] {
  const hosts = ((at(spec, "hosts") as unknown[] | undefined) ?? []).filter(
    (h): h is string => typeof h === "string"
  );
  const gateways = (
    (at(spec, "gateways") as unknown[] | undefined) ?? []
  ).filter((g): g is string => typeof g === "string");
  const facts: ReportSection = {
    id: "istio-virtualservice",
    title: "VirtualService",
    icon: iconSvg(Waypoints),
    body: {
      type: "facts",
      rows: [
        {
          label: t("columns", "hosts"),
          values: [{ text: hosts.join(", ") || "-", mono: true }],
        },
        {
          label: t("share", "istioGateways"),
          values: [
            {
              text:
                gateways.length > 0
                  ? gateways.join(", ")
                  : t("readings", "istioMeshOnly"),
              mono: true,
            },
          ],
        },
      ],
    },
  };

  const rows: { cells: ReportValue[] }[] = [];
  for (const protocol of ["http", "tls", "tcp"] as const) {
    const entries = ((at(spec, protocol) as unknown[] | undefined) ??
      []) as RouteSpec[];
    for (const entry of entries) {
      const matches = readMatches(entry.match, t);
      const matchText =
        matches.length > 0
          ? matches.map((m) => describeMatch(m, t)).join(" or ")
          : t("share", "istioEveryRequest");
      const destinations = entry.route ?? [];
      if (destinations.length === 0) {
        rows.push({
          cells: [{ text: protocol }, { text: matchText }, { text: "-" }],
        });
        continue;
      }
      for (const leg of destinations) {
        rows.push({
          cells: [
            { text: protocol },
            { text: matchText },
            destinationText(leg, namespace),
          ],
        });
      }
    }
  }
  const table: ReportSection = {
    id: "istio-virtualservice-routes",
    title: t("share", "istioSectionRoutes"),
    icon: iconSvg(Waypoints),
    count: rows.length,
    body: {
      type: "table",
      columns: [
        t("share", "istioProtocol"),
        t("columns", "match"),
        t("share", "istioDestination"),
      ],
      rows,
      more: null,
    },
  };
  return [facts, table];
}

interface DestinationRuleSpec {
  host?: string;
  subsets?: Array<{ name?: string; labels?: Record<string, string> }>;
}

function destinationRuleSections(spec: unknown, t: T): ReportSection[] {
  const fields = (spec ?? {}) as DestinationRuleSpec;
  const subsets = fields.subsets ?? [];
  return [
    {
      id: "istio-destinationrule",
      title: "DestinationRule",
      icon: iconSvg(Waypoints),
      count: subsets.length,
      body: {
        type: "facts",
        rows: [
          {
            label: t("columns", "hosts"),
            values: [{ text: fields.host ?? "-", mono: true }],
          },
          {
            label: t("share", "istioSubsets"),
            values: [
              subsets.length > 0
                ? {
                    text: subsets
                      .map((s) => s.name)
                      .filter(Boolean)
                      .join(", "),
                    mono: true,
                  }
                : { text: t("empty", "none"), quiet: true },
            ],
          },
        ],
      },
    },
  ];
}

interface GatewaySpec {
  servers?: Array<{
    hosts?: string[];
    port?: { number?: number; protocol?: string; name?: string };
    tls?: { mode?: string };
  }>;
}

function gatewaySections(spec: unknown, t: T): ReportSection[] {
  const servers = ((spec ?? {}) as GatewaySpec).servers ?? [];
  return [
    {
      id: "istio-gateway",
      title: "Gateway",
      icon: iconSvg(Waypoints),
      count: servers.length,
      body: {
        type: "table",
        columns: [t("columns", "port"), t("columns", "hosts"), "TLS"],
        rows: servers.map((server) => ({
          cells: [
            {
              text: `${server.port?.protocol ?? "?"}:${server.port?.number ?? "?"}`,
              mono: true,
            },
            { text: (server.hosts ?? []).join(", ") || "-", mono: true },
            { text: server.tls?.mode ?? "-" },
          ],
        })),
        more: null,
      },
    },
  ];
}

function peerAuthenticationSections(spec: unknown, t: T): ReportSection[] {
  const mode = text(at(spec, "mtls", "mode")) ?? t("share", "istioModeUnset");
  return [
    {
      id: "istio-peerauthentication",
      title: "PeerAuthentication",
      icon: iconSvg(Waypoints),
      body: {
        type: "facts",
        rows: [
          {
            label: t("share", "istioMtlsMode"),
            values: [{ text: mode, mono: true }],
          },
        ],
      },
    },
  ];
}

function authorizationPolicySections(spec: unknown, t: T): ReportSection[] {
  const action = text(at(spec, "action")) ?? "ALLOW";
  const rules = (at(spec, "rules") as unknown[] | undefined) ?? [];
  return [
    {
      id: "istio-authorizationpolicy",
      title: "AuthorizationPolicy",
      icon: iconSvg(Waypoints),
      count: rules.length,
      body: {
        type: "facts",
        rows: [
          {
            label: t("share", "istioAction"),
            values: [
              { text: action, role: action === "DENY" ? "warn" : undefined },
            ],
          },
          {
            label: t("share", "istioRuleCount"),
            values: [{ text: String(rules.length) }],
          },
        ],
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
    case "VirtualService":
      return virtualServiceSections(object.spec, object.namespace ?? "", t);
    case "DestinationRule":
      return destinationRuleSections(object.spec, t);
    case "Gateway":
      return gatewaySections(object.spec, t);
    case "PeerAuthentication":
      return peerAuthenticationSections(object.spec, t);
    case "AuthorizationPolicy":
      return authorizationPolicySections(object.spec, t);
    default:
      return null;
  }
}
