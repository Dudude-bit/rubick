/**
 * The cluster map as the canvas draws it: the backend's nodes and edges in
 * the reader's grouping, with the kinds they hid left out and words on
 * every node.
 */

import type {
  MapKindState,
  NamespaceRead,
  Relation,
  TopologyEdge,
  TopologyNode,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { MapTone } from "@/integrations";
import { describeUsages } from "@/lib/connections";
import { drawnCrd } from "@/lib/links";
import { reachWords } from "@/lib/network-policy";
import { serviceHealthWords } from "@/lib/service-health";
import { cronStatusWord, ownStatusWord } from "@/lib/status-words";
import { formatWhen } from "@/lib/utils";
import { rolloutBadge } from "../-object/rollout-badge";
import type { GraphEdge, GraphGroup, GraphNode } from "../-map/types";
import { loudest, serviceHealthOfNode } from "./tone";

export type Grouping = "namespace" | "app";

/** The kinds the map draws, in the order the rail lists them and the chain reads left to right. */
export const MAP_KINDS = [
  "Gateway",
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
  "Ingress",
  "Service",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "ReplicaSet",
  "HorizontalPodAutoscaler",
  "PodDisruptionBudget",
  "NetworkPolicy",
  "PersistentVolumeClaim",
  "ConfigMap",
  "Secret",
  "ServiceAccount",
] as const;

/** Where a kind sits left to right inside a group: a way in before what it reaches. */
const RANK: Record<string, number> = {
  Gateway: 0,
  HTTPRoute: 1,
  GRPCRoute: 1,
  TLSRoute: 1,
  TCPRoute: 1,
  UDPRoute: 1,
  Ingress: 1,
  NetworkPolicy: 2,
  HorizontalPodAutoscaler: 2,
  PodDisruptionBudget: 2,
  Service: 2,
  ConfigMap: 4,
  Secret: 4,
  ServiceAccount: 4,
  PersistentVolumeClaim: 4,
};
const WORKLOAD_RANK = 3;

/** Hidden until the reader asks for them: every pod runs as one. */
export const HIDDEN_AT_FIRST: ReadonlySet<string> = new Set(["ServiceAccount"]);

/** The name the backend gives the node every ownerless pod of a namespace folds into. */
export const OWNERLESS = "*";

export interface ModelSettings {
  grouping: Grouping;
  hidden: ReadonlySet<string>;
  policies: boolean;
  /** The groups the reader opened or closed by hand. */
  toggled: ReadonlyMap<string, boolean>;
  /** Whether a group nobody toggled starts collapsed. */
  collapsedAtFirst: boolean;
}

export interface Model {
  groups: GraphGroup[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The node a group id holds, for search to open its group. */
  groupOf: ReadonlyMap<string, string | null>;
  /** The plain words of each group's summary, for the image and Share. */
  summaries: ReadonlyMap<string, string>;
}

const VERB_KEY = {
  owns: "verbOwns",
  selects: "verbSelects",
  uses: "verbUses",
  routes: "verbRoutes",
  ruleRoutes: "verbRoutes",
  attachesTo: "verbAttaches",
  runsOn: "verbRunsOn",
  binds: "verbBinds",
  governs: "verbGoverns",
} as const satisfies Record<Relation["verb"], string>;

function relationWords(relation: Relation, t: T): string {
  const verb = t("topology", VERB_KEY[relation.verb]);
  switch (relation.verb) {
    case "selects":
      return `${verb} ${relation.selector}`;
    case "routes":
      return `${verb} ${relation.host ?? "*"}${relation.path}`;
    case "ruleRoutes":
      return `${verb} ${relation.hostnames[0] ?? "*"}${relation.paths[0] ?? "/"}`;
    case "uses":
      return `${verb} ${describeUsages(relation.usages, t)[0] ?? ""}`.trim();
    case "governs":
      return relation.selector ? `${verb} ${relation.selector}` : verb;
    case "attachesTo":
      return relation.sectionName ? `${verb} ${relation.sectionName}` : verb;
    default:
      return verb;
  }
}

/** What a node says under its name: its page's word, and its pods. */
export function subOf(node: TopologyNode, t: T): string | undefined {
  const words: (string | null | undefined)[] = [];
  const verdict = node.verdict;
  switch (verdict.says) {
    case "rollout":
      words.push(rolloutBadge(verdict.rollout, t).label);
      break;
    case "job":
      words.push(ownStatusWord(verdict.status, t) ?? verdict.status);
      break;
    case "cronJob":
      words.push(cronStatusWord(verdict.suspend, t));
      break;
    case "replicas":
      words.push(
        t("count", "readyOfTotal", {
          ready: verdict.ready,
          total: verdict.desired,
        })
      );
      break;
    case "service": {
      const health = serviceHealthOfNode(node, verdict);
      words.push(
        health.state === "unknown"
          ? t("topology", "notRead")
          : serviceHealthWords(health, t).label
      );
      break;
    }
    case "claim":
      words.push(verdict.phase ?? t("topology", "notRead"));
      break;
    case "policy":
      words.push(reachWords(verdict.selected, t).text);
      break;
    case "owner":
      words.push(t("topology", "notRead"));
      break;
    case "ownerless":
      words.push(
        verdict.statuses
          .map(({ status, total }) => `${status} ${total}`)
          .join(", ")
      );
      break;
    case "exists":
    case "ingress":
    case "route":
    case "gateway":
    case "autoscaler":
    case "budget":
      break;
  }
  if (node.ref.existence === "missing") words.push(t("topology", "missing"));
  if (node.ref.existence === "notChecked" && verdict.says !== "owner")
    words.push(t("topology", "notRead"));
  const readiness = verdict.says === "rollout" || verdict.says === "ownerless";
  if (node.pods && !readiness)
    words.push(t("count", "pods", { n: node.pods.total }));
  if (node.pods && readiness)
    words.push(
      t("count", "readyOfTotal", {
        ready: node.pods.ready,
        total: node.pods.total,
      })
    );
  const said = words.filter(Boolean);
  return said.length > 0 ? said.join(" · ") : undefined;
}

function coverBadge(node: TopologyNode, t: T): GraphNode["badge"] | undefined {
  const cover = node.cover;
  if (!cover) return undefined;
  switch (cover.says) {
    case "covered":
      return {
        text: t("count", "policiesSelecting", { n: cover.policies.length }),
        tone: "ok",
      };
    case "none":
      return { text: t("topology", "noPolicyBadge"), tone: "warn" };
    case "unknown":
    case "unread":
      return { text: t("topology", "policyUnknownBadge"), tone: "unknown" };
  }
}

function groupIdOf(node: TopologyNode, grouping: Grouping): string | null {
  if (node.home === null) return null;
  if (grouping === "namespace") return node.home;
  return node.app !== null ? `app:${node.app}` : `ns:${node.home}`;
}

function groupLabel(id: string, t: T): string {
  if (id.startsWith("app:")) return id.slice(4);
  if (id.startsWith("ns:"))
    return t("topology", "noAppLabel", { namespace: id.slice(3) });
  return id;
}

/** The kinds a namespace could not read, by name, once each. */
function unreadKinds(read: NamespaceRead | undefined): string[] {
  return [...new Set((read?.notLookedAt ?? []).map((entry) => entry.kind))];
}

/** Every kind unread and nothing counted: drawn as refused, never as empty. */
export function refusedWhole(read: NamespaceRead | undefined): boolean {
  return (
    read !== undefined &&
    read.notLookedAt.length > 0 &&
    read.counts.every((count) => count.count === null && count.used === null)
  );
}

/**
 * What was drawn of each object the stream sent, kept by the object's own
 * identity: a batch that replaced one node costs that node's words and tone,
 * and every other node keeps the drawing it had. Valid for one grouping, one
 * overlay, one language and one set of tone inputs; the caller starts a new
 * one when any of them changes.
 */
export interface ModelMemo {
  nodes: WeakMap<TopologyNode, GraphNode>;
  edges: WeakMap<TopologyEdge, { graph: GraphEdge; ends: string }>;
}

export const newMemo = (): ModelMemo => ({
  nodes: new WeakMap(),
  edges: new WeakMap(),
});

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function modelOf(
  nodes: ReadonlyMap<string, TopologyNode>,
  edges: ReadonlyMap<string, TopologyEdge>,
  reads: ReadonlyMap<string, NamespaceRead>,
  settings: ModelSettings,
  toneOf: (node: TopologyNode) => MapTone,
  t: T,
  memo: ModelMemo = newMemo()
): Model {
  const drawn: GraphNode[] = [];
  const tones = new Map<string, MapTone>();
  const groupOf = new Map<string, string | null>();
  const members = new Map<string, TopologyNode[]>();
  for (const node of nodes.values()) {
    const kind = node.ref.kind;
    if (settings.hidden.has(kind)) continue;
    if (kind === "NetworkPolicy" && !settings.policies) continue;
    let graph = memo.nodes.get(node);
    if (!graph) {
      graph = {
        id: node.id,
        group: groupIdOf(node, settings.grouping),
        kind,
        crd: drawnCrd({ kind, group: node.ref.group }),
        label:
          node.ref.name === OWNERLESS && kind === "Pod"
            ? t("topology", "ownerlessPods")
            : node.ref.name,
        sub: subOf(node, t),
        tone: toneOf(node),
        badge: settings.policies ? coverBadge(node, t) : undefined,
        rank: RANK[kind] ?? WORKLOAD_RANK,
      };
      memo.nodes.set(node, graph);
    }
    tones.set(node.id, graph.tone);
    groupOf.set(node.id, graph.group);
    if (graph.group !== null) {
      const list = members.get(graph.group);
      if (list) list.push(node);
      else members.set(graph.group, [node]);
    }
    drawn.push(graph);
  }
  drawn.sort(
    (a, b) =>
      (a.rank ?? 0) - (b.rank ?? 0) ||
      byName(a.kind, b.kind) ||
      byName(a.label, b.label)
  );

  const ids = new Set(
    settings.grouping === "namespace"
      ? [...reads.keys(), ...members.keys()]
      : members.keys()
  );
  const summaries = new Map<string, string>();
  const groups: GraphGroup[] = [...ids].sort().map((id) => {
    const held = members.get(id) ?? [];
    const read = settings.grouping === "namespace" ? reads.get(id) : undefined;
    const counts = new Map<string, number>();
    for (const node of held)
      counts.set(node.ref.kind, (counts.get(node.ref.kind) ?? 0) + 1);
    const failing = held.filter((node) => tones.get(node.id) === "err").length;
    const warning = held.filter((node) => tones.get(node.id) === "warn").length;
    const unread = unreadKinds(read);
    const refused = refusedWhole(read);
    const lines = refused
      ? [
          t("topology", "refusedWhole", {
            namespace: id,
            said:
              read?.notLookedAt[0]?.why.says === "unanswered"
                ? read.notLookedAt[0].why.said
                : "",
          }),
        ]
      : [
          MAP_KINDS.filter((kind) => counts.has(kind))
            .map((kind) => `${kind} ${counts.get(kind)}`)
            .join(" · ") || t("topology", "nothingDrawn"),
          [
            failing > 0 && t("count", "failingNodes", { n: failing }),
            warning > 0 && t("count", "warningNodes", { n: warning }),
          ]
            .filter(Boolean)
            .join(" · "),
          unread.length > 0 &&
            t("topology", "kindsNotRead", { kinds: unread.join(", ") }),
        ].filter((line): line is string => Boolean(line));
    summaries.set(id, lines.join(" · "));
    return {
      id,
      label: groupLabel(id, t),
      collapsed: settings.toggled.get(id) ?? settings.collapsedAtFirst,
      tone: refused
        ? "unknown"
        : loudest(
            [
              ...held.map((node) => tones.get(node.id) ?? "mute"),
              ...(unread.length > 0 ? ["unknown" as const] : []),
            ],
            "mute"
          ),
      summary: lines.join("\n"),
      refused,
    };
  });

  const graphEdges: GraphEdge[] = [];
  for (const edge of edges.values()) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to || !groupOf.has(edge.from) || !groupOf.has(edge.to))
      continue;
    const ends = `${from.ref.existence}>${to.ref.existence}`;
    const held = memo.edges.get(edge);
    if (held?.ends === ends) {
      graphEdges.push(held.graph);
      continue;
    }
    const existence = [from.ref.existence, to.ref.existence];
    const graph: GraphEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      tone: existence.includes("missing")
        ? "err"
        : existence.includes("notChecked")
          ? "unknown"
          : "ok",
      label: edge.relations.map((relation) => relationWords(relation, t))[0],
      sub:
        edge.relations.length > 1
          ? t("topology", "moreRelations", { n: edge.relations.length - 1 })
          : undefined,
      reversed: edge.relations[0]?.verb === "attachesTo",
    };
    memo.edges.set(edge, { graph, ends });
    graphEdges.push(graph);
  }
  return { groups, nodes: drawn, edges: graphEdges, groupOf, summaries };
}

/** How a kind was read, across the scope, for the rail. */
export function readingOf(
  kind: string,
  kinds: readonly MapKindState[]
): MapKindState["reading"] | null {
  return kinds.find((state) => state.kind === kind)?.reading ?? null;
}

/** A kind's count across the scope: `null` where some namespace did not count it. */
export function countOf(
  kind: string,
  reads: ReadonlyMap<string, NamespaceRead>,
  nodes: ReadonlyMap<string, TopologyNode>
): { count: number | null; used: number | null; drawn: number } {
  let count: number | null = 0;
  let used: number | null = 0;
  for (const read of reads.values()) {
    const entry = read.counts.find((each) => each.kind === kind);
    count = entry?.count == null || count === null ? null : count + entry.count;
    used = entry?.used == null || used === null ? null : used + entry.used;
  }
  let drawn = 0;
  for (const node of nodes.values()) if (node.ref.kind === kind) drawn += 1;
  return {
    count: reads.size === 0 ? null : count,
    used: reads.size === 0 ? null : used,
    drawn,
  };
}

/** How a kind was read, in a few words; `null` for one read live. */
export function readingWords(
  reading: MapKindState["reading"] | null,
  t: T
): string | null {
  if (reading === null) return null;
  switch (reading.says) {
    case "live":
      return null;
    case "syncing":
      return t("topology", "readingSyncing");
    case "queued":
      return t("topology", "readingQueued");
    case "unserved":
      return t("topology", "readingUnserved");
    case "namespacesOnly":
      return t("topology", "readingOnlyIn", {
        namespaces: reading.namespaces.join(", "),
      });
    case "refused":
      return t("topology", "readingRefused");
    case "failed":
      return t("topology", "readingFailed");
    case "stale":
      return t("topology", "readingStale", {
        time: formatWhen(reading.since, "clock"),
      });
    case "notServed":
      return t("topology", "readingNotServed");
  }
}

/** The kinds whose absence takes edges with it, which the map says. */
const EDGE_KINDS: ReadonlySet<string> = new Set([
  "Service",
  "Ingress",
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
  "Gateway",
  "HorizontalPodAutoscaler",
  "PodDisruptionBudget",
  "NetworkPolicy",
]);

export interface NotLooked {
  kind: string;
  /** The kind, how it was read, and the cluster's words. */
  line: string;
  /** Whether edges the map would draw from it are absent because of it. */
  edges: boolean;
}

/**
 * Every kind the map could not read whole, in the cluster's words. A kind
 * still listing is said apart, and a kind the cluster does not serve is not
 * a gap.
 */
export function notLookedAt(kinds: readonly MapKindState[], t: T): NotLooked[] {
  return kinds.flatMap((state) => {
    const reading = state.reading;
    const words = readingWords(reading, t);
    if (
      !words ||
      reading.says === "live" ||
      reading.says === "notServed" ||
      reading.says === "syncing" ||
      reading.says === "queued"
    )
      return [];
    const said = "said" in reading && reading.said ? `: ${reading.said}` : "";
    return [
      {
        kind: state.kind,
        line: `${state.kind} (${words})${said}`,
        edges:
          EDGE_KINDS.has(state.kind) &&
          (reading.says === "refused" || reading.says === "failed"),
      },
    ];
  });
}
