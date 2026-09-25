import { Globe, Plug } from "lucide-react";

import { sayWords } from "@/i18n/say";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { T } from "@/i18n/useT";
import { hostRole } from "../ingress";
import type { ControllerInfo } from "./data";
import { type HostGroup, UNNAMED_TARGET } from "./model";
import { describePath } from "./rule";

/**
 * Every router, one row: the rule that binds it, its entry points and
 * middlewares, the TLS Secret it is served under and the object it lands on.
 * The trouble list above says which host is broken; this says how every one
 * of them, broken or not, is actually wired.
 */
export function routesTableSection(groups: HostGroup[], t: T): PlacedSection {
  const rows = groups.flatMap((group) =>
    group.routes.map((route) => ({
      cells: [
        {
          text: group.host ?? t("empty", "anyHost"),
          role: hostRole(group) ?? ("ok" as const),
        },
        {
          text:
            route.rule.raw ??
            `${group.host ?? "*"} ${describePath(route.clause.path, t)}`,
          mono: true,
        },
        {
          text: route.entryPoints
            ? route.entryPoints.join(", ")
            : t("empty", "everyEntryPoint"),
        },
        {
          text:
            route.middlewares.map((middleware) => middleware.name).join(", ") ||
            "–",
        },
        { text: route.tlsSecret ?? "–" },
        route.service
          ? {
              text: route.service.name,
              ref: refOf({
                kind: "Service",
                name: route.service.name,
                namespace: route.service.namespace,
              }),
            }
          : { text: route.resourceBackend ?? "–" },
      ],
    }))
  );
  return {
    id: "traefik-routes-table",
    order: ORDER.own,
    title: t("nav", "routes"),
    icon: iconSvg(Globe),
    count: rows.length,
    body: {
      type: "table",
      columns: [
        t("columns", "host"),
        t("columns", "rule"),
        t("nav", "entryPoints"),
        t("columns", "middlewares"),
        t("columns", "tls"),
        t("columns", "service"),
      ],
      rows,
      more: null,
    },
  };
}

/**
 * The one statement that is about the proxy rather than about a host.
 *
 * A router that names no entry point is bound to every one of them, so a
 * plain entry point with no redirection makes *every* host in the cluster
 * reachable unencrypted, including the ones with a perfectly good
 * certificate. Said once, here, rather than eighty times on the Routes tab.
 */
/**
 * Every entry point Traefik listens on: its address, whether it is TLS, and
 * where it lands or redirects. None read is unread: Traefik always listens
 * somewhere, so an empty list is the app not knowing where.
 */
export function entryPointsSection(
  controller: ControllerInfo | undefined,
  groups: HostGroup[],
  t: T
): PlacedSection {
  const shell = {
    id: "traefik-entry-points",
    order: ORDER.own,
    title: t("nav", "entryPoints"),
    icon: iconSvg(Plug),
  };
  if (!controller || controller.entryPoints.length === 0)
    return {
      ...shell,
      count: null,
      unread: !controller
        ? t("share", "stillReading")
        : controller.problem
          ? sayWords(controller.problem, t)
          : t("empty", "cannotSayWhatTraefikListensOn"),
      body: { type: "table", columns: [], rows: [], more: null },
    };
  const rows = controller.entryPoints.map((entry) => {
    const landing = groups.filter((group) =>
      group.routes.some(
        (route) => !route.entryPoints || route.entryPoints.includes(entry.name)
      )
    );
    return {
      cells: [
        { text: entry.name, mono: true },
        { text: entry.address ?? "–" },
        {
          text: entry.tls ? "TLS" : t("empty", "plainLower"),
          role: (entry.tls ? "ok" : "warn") as "ok" | "warn",
        },
        {
          text: entry.redirectTo
            ? t("empty", "redirectsTo", {
                target:
                  entry.redirectTo === UNNAMED_TARGET
                    ? t("readings", "traefikAnotherEntryPoint")
                    : entry.redirectTo,
              })
            : t("count", "hostsLandHere", { n: landing.length }),
        },
      ],
    };
  });
  return {
    ...shell,
    count: rows.length,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "address"),
        t("columns", "tls"),
        t("columns", "destination"),
      ],
      rows,
      more: null,
    },
  };
}
