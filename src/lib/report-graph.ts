import { Link2, Route } from "lucide-react";

import type { ChainStop, ResourceConnections } from "@/generated/types";
import type { T } from "@/i18n/useT";
import {
  chainSilence,
  connectionGroups,
  describeExistence,
  describeStop,
  trafficChains,
  type ChainHop,
} from "./connections";
import { iconSvg } from "./icon-svg";
import type { ReportHop, ReportPath } from "./report";
import { ORDER, refOf, type PlacedSection } from "./report-parts";

function hopOf(hop: ChainHop): ReportHop {
  const plain = { ref: null, text: null, detail: null, self: false };
  switch (hop.at) {
    case "object":
      return {
        ...plain,
        ref: refOf(hop.object),
        detail:
          [hop.detail, hop.via, ...hop.urls].filter(Boolean).join(" · ") ||
          null,
        tone: hop.object.existence === "missing" ? "err" : null,
        self: hop.self,
      };
    case "published":
      return {
        ...plain,
        text: hop.summary,
        detail: hop.address,
        tone: hop.tone === "on" ? "ok" : "warn",
      };
    case "stop":
      return { ...plain, text: hop.title, detail: hop.note, tone: "err" };
    case "certificate":
      return {
        ...plain,
        ref: refOf(hop.secret),
        detail: hop.hosts.join(", ") || null,
        tone: null,
      };
    case "controller":
      return {
        ...plain,
        text: `IngressClass ${hop.binding.resolved ?? hop.binding.requested ?? "?"}`,
        detail: hop.binding.controller,
        tone: hop.binding.controller ? null : "warn",
      };
  }
}

/**
 * The object a stop is about, per reason rather than by guessing at field
 * names: the Gateway API stops carry a `route` and a `gateway`.
 */
function stopSubject(stop: ChainStop) {
  switch (stop.reason) {
    case "backendMissing":
      return stop.service;
    case "routeNotAccepted":
    case "routeRefsUnresolved":
      return stop.route;
    case "gatewayMissing":
      return stop.gateway;
    case "selectsNothing":
    case "publishesNothingYet":
    case "noneReady":
    case "publishesNothing":
      return stop.service;
  }
}

/**
 * The paths the Overview draws, plus every stop no path reached: where the
 * path stops is the sharpest thing the graph knows, and a Service that
 * publishes no endpoint must not arrive as an ordinary working hop.
 */
export function trafficOf(conns: ResourceConnections, t: T): ReportPath[] {
  const chains = trafficChains(conns, t);
  const drawn = new Set(
    chains.flatMap((path) =>
      path.hops.flatMap((hop) => (hop.at === "stop" ? [hop.title] : []))
    )
  );
  const paths: ReportPath[] = chains.map((path) => ({
    broken: path.broken,
    hops: path.hops.map(hopOf),
  }));
  for (const stop of conns.stops) {
    const said = describeStop(stop, t);
    if (drawn.has(said.title)) continue;
    paths.push({
      broken: true,
      hops: [
        {
          ref: refOf(stopSubject(stop)),
          text: null,
          detail: null,
          tone: null,
          self: false,
        },
        {
          ref: null,
          text: said.title,
          detail: said.note,
          tone: "err",
          self: false,
        },
      ],
    });
  }
  return paths;
}

/**
 * Traffic and connections from one read of the graph, with the page's own
 * sentence in both when the read failed or has not landed.
 */
export function graphSections(
  connections: {
    data: ResourceConnections | undefined;
    error: unknown;
    isPending: boolean;
  },
  t: T
): { sections: PlacedSection[]; unread: string | null } {
  const unread =
    connections.error !== null && connections.error !== undefined
      ? t("empty", "couldNotReadWhatConnects")
      : connections.isPending || connections.data === undefined
        ? t("share", "chainStillReading")
        : null;
  const data = connections.data;
  const paths = data ? trafficOf(data, t) : [];
  const groups = data
    ? connectionGroups(data, t)
        .filter((group) => group.rows.length > 0)
        .map((group) => ({
          title: group.title,
          caption: group.caption?.replace(/^[\s–-]+/, "") ?? null,
          rows: group.rows.map((row) => ({
            label: row.label,
            ref: row.object ? refOf(row.object) : null,
            name: row.outside?.name ?? null,
            detail: [...row.ways, row.detail].filter(Boolean).join(" · "),
            existence: row.object
              ? describeExistence(row.object, t, row.verifiable ?? false)
              : null,
            missing: row.object?.existence === "missing",
          })),
        }))
    : [];
  return {
    unread,
    sections: [
      {
        id: "traffic",
        order: ORDER.traffic,
        title: t("share", "sectionTraffic"),
        icon: iconSvg(Route),
        unread,
        body: {
          type: "traffic",
          paths,
          note: data ? chainSilence(data, t) : null,
        },
      },
      {
        id: "connections",
        order: ORDER.connections,
        title: t("share", "sectionConnections"),
        icon: iconSvg(Link2),
        count: groups.reduce((sum, group) => sum + group.rows.length, 0),
        unread,
        body: { type: "connections", groups },
      },
    ],
  };
}
