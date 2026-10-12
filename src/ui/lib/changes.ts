/**
 * What changed on a workload, from four records that never agree on shape:
 * the controller's revisions, the delivery owner's history, plain Helm's
 * history, and this app's own journal of what it watched. Laid on one clock,
 * with the stretches it was not watching drawn as gaps rather than as calm.
 *
 * Nothing here says why. Two entries close in time are two entries close in
 * time, and the copy that draws them is held to that by a test.
 */

import type {
  ContainerImage,
  ControllerRevisionInfo,
  DaemonSetInfo,
  DeploymentContainerInfo,
  DeploymentInfo,
  EnvVarInfo,
  HelmRevision,
  ReplicaSetInfo,
  StatefulSetInfo,
} from "@/generated/types";
import type { DeliveryRevision } from "@/integrations";
import { probeFields } from "./probe-words";
import type { T } from "@/i18n/useT";
import { namespacesWhere } from "./namespace-scope";
import { listWords } from "@/i18n/say";

/**
 * The kinds whose history the Changes tab can draw, as a value as well as a
 * type.
 *
 * A link may carry `?tab=changes&since=…`, and a tab id the page does not
 * have leaves the reader on a detail page with no panel open at all — so
 * whoever builds such a link asks here rather than keeping its own list of
 * three kinds.
 */
export const CHANGES_KINDS = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
] as const;

/** Whether `?tab=changes` means anything on this kind's page. */
export function hasChangesTab(kind: string): boolean {
  return (CHANGES_KINDS as readonly string[]).includes(kind);
}

export const HELM_RELEASE_NAME = "meta.helm.sh/release-name";
export const HELM_RELEASE_NAMESPACE = "meta.helm.sh/release-namespace";
const CHANGE_CAUSE = "kubernetes.io/change-cause";

/** One revision of a workload's template, whichever kind recorded it. */
export interface Revision {
  id: string;
  /** The controller's counter; `null` on a hand-made ReplicaSet. */
  number: number | null;
  name: string;
  current: boolean;
  at: string | null;
  changeCause: string | null;
  containers: DeploymentContainerInfo[];
  initContainers: DeploymentContainerInfo[];
  templateAnnotations: Record<string, string>;
  /** Whether the template below was read at all. False leaves every field
   * above empty because nothing was read, not because nothing was there. */
  templateKnown: boolean;
  /** The whole template, for the fields the ones above do not carry. */
  template: unknown;
}

export function revisionOfReplicaSet(rs: ReplicaSetInfo): Revision {
  const number = rs.revision === null ? null : Number(rs.revision);
  return {
    id: rs.uid,
    number: number !== null && Number.isFinite(number) ? number : null,
    name: rs.name,
    current: rs.revision !== null && rs.revision === rs.currentRevision,
    at: rs.createdAt,
    changeCause: rs.annotations[CHANGE_CAUSE] ?? null,
    containers: rs.containers,
    initContainers: rs.initContainers,
    templateAnnotations: rs.templateAnnotations,
    templateKnown: true,
    template: rs.template,
  };
}

export function revisionOfController(cr: ControllerRevisionInfo): Revision {
  return {
    id: cr.name,
    number: cr.revision,
    name: cr.name,
    current: cr.current,
    at: cr.createdAt,
    changeCause: cr.changeCause,
    containers: cr.containers,
    initContainers: cr.initContainers,
    templateAnnotations: cr.templateAnnotations,
    templateKnown: cr.templateRead,
    template: cr.template,
  };
}

/** Whether a revision can be rolled back to: an older one whose template was read. */
export function canRollBackTo(revision: Revision): boolean {
  return (
    !revision.current && revision.number !== null && revision.templateKnown
  );
}

export interface FieldChange {
  /** The container the field belongs to; `null` for a template-level field. */
  container: string | null;
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * What an env var is set from, in one word.
 *
 * Each source type identifies itself by a different field: a `fieldRef` by
 * `fieldPath`, a `resourceFieldRef` by container and resource, the two map
 * refs by name and key. Reading only name and key spelled every downward-API
 * variable "fieldRef:null" — the same word for `spec.nodeName` and
 * `status.podIP`, so a change between them was no change at all.
 */
function envWord(entry: EnvVarInfo): string {
  if (entry.value !== null && entry.value !== undefined) return entry.value;
  const source = entry.valueFrom;
  if (!source) return "";
  const where =
    source.fieldPath ??
    (source.resource !== null
      ? [source.name, source.resource].filter(Boolean).join("/")
      : [source.name, source.key].filter(Boolean).join("/"));
  return where ? `${source.sourceType}:${where}` : source.sourceType;
}

function envFromWord(
  entry: DeploymentContainerInfo["envFrom"][number]
): string {
  const ref = entry.configMapRef ?? entry.secretRef ?? "";
  return `${entry.prefix ?? ""}${ref}`;
}

function resourceMap(container: DeploymentContainerInfo): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(container.resources.requests))
    out.set(`resources.requests.${name}`, value);
  for (const [name, value] of Object.entries(container.resources.limits))
    out.set(`resources.limits.${name}`, value);
  return out;
}

function diffMaps(
  container: string | null,
  prefix: string,
  older: Map<string, string>,
  newer: Map<string, string>
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of new Set([...older.keys(), ...newer.keys()])) {
    const from = older.get(key) ?? null;
    const to = newer.get(key) ?? null;
    if (from !== to)
      out.push({ container, field: `${prefix}${key}`, from, to });
  }
  return out;
}

/** Only annotations that carry a checksum or a hash: the ones a chart writes to force a rollout. */
export function configHashes(
  annotations: Record<string, string>
): Map<string, string> {
  return new Map(
    Object.entries(annotations).filter(([key]) =>
      /checksum|hash|digest/i.test(key)
    )
  );
}

/**
 * The template fields two revisions are compared on by name. Everything else
 * in the template is compared too, by {@link otherDifferences}, so a change
 * outside this list is "another field differs" and never "nothing changed".
 */
export const COMPARED_FIELDS = [
  "image",
  "env",
  "envFrom",
  "ports",
  "resources",
  "readinessProbe",
  "livenessProbe",
  "startupProbe",
  "annotations",
] as const;

const PROBE_FIELDS = [
  ["readinessProbe", "readiness"],
  ["livenessProbe", "liveness"],
  ["startupProbe", "startup"],
] as const;

function probeMap(container: DeploymentContainerInfo): Map<string, string> {
  return new Map(
    PROBE_FIELDS.flatMap(([field, key]) => [
      ...probeFields(field, container.probes[key]),
    ])
  );
}

/** What differs between two revisions, container by container, in the template's own field names. */
export function diffRevisions(older: Revision, newer: Revision): FieldChange[] {
  const out: FieldChange[] = [];
  const byName = (list: DeploymentContainerInfo[]) =>
    new Map(list.map((c) => [c.name, c]));
  const before = byName([...older.containers, ...older.initContainers]);
  const after = byName([...newer.containers, ...newer.initContainers]);
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name);
    const b = after.get(name);
    if (!a || !b) {
      out.push({
        container: name,
        field: "container",
        from: a ? a.image : null,
        to: b ? b.image : null,
      });
      continue;
    }
    if (a.image !== b.image)
      out.push({ container: name, field: "image", from: a.image, to: b.image });
    const ports = (c: DeploymentContainerInfo) => c.ports.join(",");
    if (ports(a) !== ports(b))
      out.push({
        container: name,
        field: "ports",
        from: ports(a) || null,
        to: ports(b) || null,
      });
    const envFrom = (c: DeploymentContainerInfo) =>
      new Map(c.envFrom.map((e, index) => [String(index), envFromWord(e)]));
    out.push(
      ...diffMaps(
        name,
        "env.",
        new Map(a.env.map((e) => [e.name, envWord(e)])),
        new Map(b.env.map((e) => [e.name, envWord(e)]))
      ),
      ...diffMaps(name, "envFrom.", envFrom(a), envFrom(b)),
      ...diffMaps(name, "", resourceMap(a), resourceMap(b)),
      ...diffMaps(name, "", probeMap(a), probeMap(b))
    );
  }
  out.push(
    ...diffMaps(
      null,
      "annotations.",
      configHashes(older.templateAnnotations),
      configHashes(newer.templateAnnotations)
    )
  );
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CONTAINER_LISTS = new Set(["containers", "initContainers"]);

/** Every leaf of a template, containers keyed by name so a reorder is no change. */
function leaves(
  value: unknown,
  path: string[],
  out: Map<string, { path: string[]; text: string }>
) {
  const put = (text: string) => out.set(path.join("\u0000"), { path, text });
  if (Array.isArray(value)) {
    const keyed =
      path.length === 2 &&
      path[0] === "spec" &&
      CONTAINER_LISTS.has(path[1]) &&
      value.every((item) => isRecord(item) && typeof item.name === "string");
    if (keyed) {
      for (const item of value as Record<string, unknown>[])
        leaves(item, [...path, String(item.name)], out);
      return;
    }
    if (value.length === 0 || value.every((item) => !isRecord(item)))
      return put(JSON.stringify(value));
    value.forEach((item, index) => leaves(item, [...path, String(index)], out));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return put("{}");
    for (const [key, item] of entries) leaves(item, [...path, key], out);
    return;
  }
  put(typeof value === "string" ? value : JSON.stringify(value));
}

/** `spec.containers[app].readinessProbe.httpGet.path`, as the API spells the place. */
function spell(path: string[]): string {
  return path.reduce((said, segment, index) => {
    const named =
      index === 2 && path[0] === "spec" && CONTAINER_LISTS.has(path[1]);
    if (named || /^\d+$/.test(segment)) return `${said}[${segment}]`;
    return said ? `${said}.${segment}` : segment;
  }, "");
}

/** Whether a field the named comparison already reported covers this leaf. */
function explained(path: string[], named: FieldChange[]): boolean {
  if (path[0] === "metadata" && path[1] === "annotations")
    return named.some(
      (change) =>
        change.container === null &&
        change.field === `annotations.${path.slice(2).join(".")}`
    );
  if (path[0] !== "spec" || !CONTAINER_LISTS.has(path[1])) return false;
  const container = path[2];
  const root = path[3];
  return named.some(
    (change) =>
      change.container === container &&
      (change.field === "container" || change.field.split(".")[0] === root)
  );
}

/**
 * What differs between two whole templates beyond what {@link diffRevisions}
 * names, or `null` where either template was not read. This is what keeps
 * "no difference in what we compared" from ever reading as "no difference".
 */
export function otherDifferences(
  older: Revision,
  newer: Revision,
  named: FieldChange[]
): FieldChange[] | null {
  if (!isRecord(older.template) || !isRecord(newer.template)) return null;
  const before = new Map<string, { path: string[]; text: string }>();
  const after = new Map<string, { path: string[]; text: string }>();
  leaves(older.template, [], before);
  leaves(newer.template, [], after);
  const out: FieldChange[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(key);
    const to = after.get(key);
    if (from?.text === to?.text) continue;
    const path = (from ?? to)!.path;
    if (explained(path, named)) continue;
    out.push({
      container: null,
      field: spell(path),
      from: from?.text ?? null,
      to: to?.text ?? null,
    });
  }
  return out;
}

export type JournalField =
  | "created"
  | "deleted"
  | "generation"
  | "image"
  | "replicas"
  | "annotation";

export interface JournalEntry {
  id: string;
  context: string;
  kind: string;
  namespace: string;
  name: string;
  at: number;
  field: JournalField;
  /** The container name or annotation key the change is about. */
  key: string | null;
  from: string | null;
  to: string | null;
  /**
   * Found by comparing against the baseline from before a break, not watched
   * happening. `at` is when it was noticed; it changed somewhere in the gap
   * before that.
   */
  atRelist?: boolean;
}

/**
 * One journal entry in words, for every surface that states it. `values`
 * lets a reader with less room shorten what `from` and `to` print.
 */
export function journalWords(
  item: JournalEntry,
  t: T,
  values: (value: string | null) => string = (value) => value ?? "∅"
): string {
  const from = values(item.from);
  const to = values(item.to);
  switch (item.field) {
    case "created":
      return t("changes", "journalCreated", { kind: item.kind });
    case "deleted":
      return t("changes", "journalDeleted", { kind: item.kind });
    case "generation":
      return t("changes", "journalGeneration", { from, to });
    case "image":
      return t("changes", "journalImage", {
        container: item.key ?? "",
        from,
        to,
      });
    case "replicas":
      return t("changes", "journalReplicas", { from, to });
    case "annotation":
      return t("changes", "journalAnnotation", {
        key: item.key ?? "",
        from,
        to,
      });
  }
}

/** The fields the journal watches, read off one list row. */
export interface Snapshot {
  /** The creation time, which tells a recreated object from the one it replaced. */
  born: string | null;
  generation: number | null;
  /** Container name to image, so a removed container is not read as a
   * changed image on every container after it. */
  images: Map<string, string>;
  replicas: number | null;
  hashes: Map<string, string>;
}

type WatchedRow = DeploymentInfo | StatefulSetInfo | DaemonSetInfo;

function namedImages(list: ContainerImage[]): Map<string, string> {
  return new Map(
    list.flatMap((c) => (c.image === null ? [] : [[c.name, c.image] as const]))
  );
}

export function snapshotOf(kind: string, row: WatchedRow): Snapshot {
  if (kind === "Deployment") {
    const d = row as DeploymentInfo;
    return {
      born: d.createdAt,
      generation: d.generation,
      images: new Map(
        [...d.containers, ...d.initContainers].map((c) => [c.name, c.image])
      ),
      replicas: d.replicas.desired,
      hashes: configHashes(d.templateAnnotations),
    };
  }
  if (kind === "StatefulSet") {
    const s = row as StatefulSetInfo;
    return {
      born: s.createdAt,
      generation: s.generation,
      images: namedImages(s.containerImages),
      replicas: s.replicas.desired,
      hashes: configHashes(s.templateAnnotations),
    };
  }
  const ds = row as DaemonSetInfo;
  return {
    born: ds.createdAt,
    generation: ds.generation,
    images: namedImages(ds.containerImages),
    replicas: null,
    hashes: configHashes(ds.templateAnnotations),
  };
}

/**
 * Whether `next` is a state of the same object already past `prev`. Every
 * field a snapshot holds is spec, so generation orders them; two watches over
 * one namespace deliver each change twice, and one may lag the other.
 */
export function alreadySeen(prev: Snapshot, next: Snapshot): boolean {
  return (
    prev.born === next.born &&
    prev.generation !== null &&
    next.generation !== null &&
    next.generation <= prev.generation
  );
}

/** The entries one row's change writes; empty when the watched fields held still. */
export function diffSnapshots(
  prev: Omit<Snapshot, "born">,
  next: Omit<Snapshot, "born">
): Array<Pick<JournalEntry, "field" | "key" | "from" | "to">> {
  const out: Array<Pick<JournalEntry, "field" | "key" | "from" | "to">> = [];
  if (prev.generation !== next.generation) {
    out.push({
      field: "generation",
      key: null,
      from: prev.generation === null ? null : String(prev.generation),
      to: next.generation === null ? null : String(next.generation),
    });
  }
  for (const name of new Set([...prev.images.keys(), ...next.images.keys()])) {
    const from = prev.images.get(name) ?? null;
    const to = next.images.get(name) ?? null;
    if (from !== to) out.push({ field: "image", key: name, from, to });
  }
  if (prev.replicas !== next.replicas) {
    out.push({
      field: "replicas",
      key: null,
      from: prev.replicas === null ? null : String(prev.replicas),
      to: next.replicas === null ? null : String(next.replicas),
    });
  }
  for (const key of new Set([...prev.hashes.keys(), ...next.hashes.keys()])) {
    const from = prev.hashes.get(key) ?? null;
    const to = next.hashes.get(key) ?? null;
    if (from !== to) out.push({ field: "annotation", key, from, to });
  }
  return out;
}

/** A stretch this app was watching a cluster's workloads. `to` is null while it still is. */
export interface ObservedSpan {
  from: number;
  /** The last moment the watch was known alive; a crash leaves this as the end. */
  seenAt: number;
  to: number | null;
  /** Kinds the cluster refused to let it watch anywhere, so this span says nothing about them. */
  unwatched?: string[];
  /** Kinds refused in some of its namespaces only, as `<kind>/<namespace>`. */
  unwatchedIn?: string[];
  /** The namespaces it watched; absent for all of them. */
  scope?: string[];
}

export type SpanCover = Pick<
  ObservedSpan,
  "unwatched" | "unwatchedIn" | "scope"
>;

/** Whether the span was refused `kind` in `namespace`, `null` asking about every namespace it watched. */
function refusedIn(
  span: SpanCover,
  kind: string,
  namespace: string | null
): boolean {
  if (span.unwatched?.includes(kind)) return true;
  return (span.unwatchedIn ?? []).some(
    (entry) =>
      entry.startsWith(`${kind}/`) &&
      (namespace === null || entry === `${kind}/${namespace}`)
  );
}

/** Each kind a span was refused, with the namespaces it was refused in; `[]` is the whole cluster. */
export function refusedWhere(span: ObservedSpan): Map<string, string[]> {
  const where = new Map<string, string[]>();
  for (const kind of span.unwatched ?? []) where.set(kind, span.scope ?? []);
  for (const entry of span.unwatchedIn ?? []) {
    const [kind, namespace] = entry.split("/");
    where.set(kind, [...(where.get(kind) ?? []), namespace]);
  }
  return where;
}

/** The kinds a span was refused, each with where, in words, or `null` when it watched them all. */
export function unwatchedWords(span: ObservedSpan, t: T): string | null {
  const kindsAt = new Map<string, { kinds: string[]; where: string[] }>();
  for (const [kind, where] of refusedWhere(span)) {
    const key = [...where].sort().join();
    const same = kindsAt.get(key) ?? { kinds: [], where };
    same.kinds.push(kind);
    kindsAt.set(key, same);
  }
  const said = [...kindsAt.values()].map(({ kinds, where }) =>
    t("changes", "unwatchedRefused", {
      kinds: kinds.join(", "),
      where: namespacesWhere(where, t),
    })
  );
  return said.length > 0 ? said.join(" · ") : null;
}

/**
 * The spans that watched every one of `kinds` in every one of `namespaces`,
 * `[]` meaning all of them. A span under kube-system watched nothing in shop.
 */
export function spansCovering(
  spans: readonly ObservedSpan[],
  {
    kinds,
    namespaces,
  }: { kinds: readonly string[]; namespaces: readonly string[] }
): ObservedSpan[] {
  return spans.filter(
    (span) =>
      !kinds.some((kind) =>
        namespaces.length === 0
          ? refusedIn(span, kind, null)
          : namespaces.some((namespace) => refusedIn(span, kind, namespace))
      ) &&
      (!span.scope?.length ||
        (namespaces.length > 0 &&
          namespaces.every((namespace) => span.scope?.includes(namespace))))
  );
}

/** The spans that watched every one of `kinds` somewhere, whatever namespaces they were on. */
export function spansWatching(
  spans: readonly ObservedSpan[],
  kinds: readonly string[]
): ObservedSpan[] {
  return spans.filter(
    (span) => !kinds.some((kind) => span.unwatched?.includes(kind))
  );
}

const GAP_WORDS = {
  watched: ["watchedQuietBrief", "watchedQuiet", "watchedQuiet"],
  part: ["partScopeBrief", "partScope", "partScopeStill"],
  partOfAll: ["partAllBrief", "partAll", "partAllStill"],
  elsewhere: ["outsideScopeBrief", "outsideScope", "outsideScopeStill"],
  unobserved: ["notObservedBrief", "notObserved", "notObservedStill"],
} as const;

/**
 * A gap in words; one under a minute by its length, which minutes would draw
 * as 20:23 to 20:23. One still running has no length yet, only a start: a
 * length read while it grew changed the words of a stretch that had ended.
 */
export function gapWords(
  gap: Gap,
  t: T,
  clock: (ms: number) => string,
  watched = false
): string {
  const ms = gap.to - gap.from;
  const [brief, long, still] =
    GAP_WORDS[
      watched
        ? "watched"
        : gap.partial
          ? gap.partial.missed.length > 0
            ? "part"
            : "partOfAll"
          : gap.elsewhere
            ? "elsewhere"
            : "unobserved"
    ];
  const names = gap.partial && {
    watched: listWords(gap.partial.watched, t),
    missed: listWords(gap.partial.missed, t),
  };
  if (gap.running && !watched)
    return t("changes", still, { from: clock(gap.from), ...names });
  return ms < 60_000
    ? t("changes", brief, {
        n: Math.max(1, Math.round(ms / 1000)),
        at: clock(gap.from),
        ...names,
      })
    : t("changes", long, {
        from: clock(gap.from),
        to: clock(gap.to),
        ...names,
      });
}

/**
 * Where the rows older than the running watch came from: this app recorded
 * them while it watched earlier, first start to last end. `null` when every
 * row is the running watch's own.
 */
export function earlierRowsWords(
  spans: readonly ObservedSpan[],
  items: readonly ChangeItem[],
  since: number,
  t: T,
  clock: (ms: number) => string
): string | null {
  const older = items.flatMap((item) =>
    item.kind === "journal" && item.at < since ? [item.at] : []
  );
  if (older.length === 0) return null;
  const held = spans
    .filter(
      (span) =>
        span.from < since &&
        older.some((at) => at >= span.from && at <= (span.to ?? span.seenAt))
    )
    .flatMap((span) => [span.from, Math.min(span.to ?? span.seenAt, since)]);
  const ends = held.length > 0 ? held : older;
  return t("changes", "earlierRows", {
    since: clock(since),
    from: clock(Math.min(...ends)),
    to: clock(Math.max(...ends)),
  });
}

/**
 * The stretches `spans` watched within [from, to] and recorded no row in, as
 * rows: Lena's page said nothing about the nine quiet minutes it had watched
 * before a scope switch. The one still running has the header's own line.
 */
export function quietStretches(
  spans: readonly ObservedSpan[],
  items: readonly ChangeItem[],
  from: number,
  to: number
): ChangeItem[] {
  const stretches: Gap[] = [];
  const clipped = spans
    .map((span) => ({
      from: Math.max(span.from, from),
      to: Math.min(span.to ?? to, to),
    }))
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
  for (const span of clipped) {
    const last = stretches.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else stretches.push({ ...span });
  }
  return stretches
    .filter(
      (stretch) =>
        stretch.to < to &&
        !items.some(
          (item) =>
            item.kind === "journal" &&
            item.at >= stretch.from &&
            item.at <= stretch.to
        )
    )
    .map((gap) => ({ kind: "watched", at: gap.to, gap }));
}

/** When the running watch began, if it has recorded no row since; `null` otherwise. */
export function quietSince(
  watching: ObservedSpan | undefined,
  items: readonly ChangeItem[]
): number | null {
  if (!watching) return null;
  return items.some(
    (item) =>
      item.kind !== "gap" &&
      item.kind !== "watched" &&
      item.at !== null &&
      item.at >= watching.from
  )
    ? null
    : watching.from;
}

/** The end of a window drawn at `now`, never before a moment the spans hold: a clock read to the half minute lags a span just ended. */
export function windowEnd(spans: readonly ObservedSpan[], now: number): number {
  let end = now;
  for (const span of spans)
    end = Math.max(end, span.from, span.seenAt, span.to ?? span.from);
  return end;
}

/** Where the watch running at `now` began to see these spans' scope without a break, by the rule `gapsOf` draws gaps with; `null` when nothing watches at `now`. */
export function watchedSince(
  spans: readonly ObservedSpan[],
  now: number
): number | null {
  let start: number | null = null;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    if (start === null || span.from > end) start = span.from;
    end = Math.max(end, span.to ?? Math.max(span.seenAt, now));
  }
  return start !== null && end >= now ? start : null;
}

export interface Gap {
  from: number;
  to: number;
  /** The app was watching these kinds the whole time, in other namespaces: the object was outside the scope, not unwatched. */
  elsewhere?: boolean;
  /** Of the scope's namespaces, the ones watched the whole time and the rest; no rest where the scope is every namespace. */
  partial?: { watched: string[]; missed: string[] };
  /** It reaches the end of the window: nothing covers it yet, so it has a start and no length. */
  running?: boolean;
}

/**
 * The parts of [from, to] no span covers. The whole window, when nothing was
 * ever watched.
 *
 * A span with no `to` is the one this process is still heartbeating —
 * rehydration closes every other one at its `seenAt` — so it covers up to the
 * end of the window. Ending it at `seenAt` instead drew a "Not observed" box
 * for the seconds since the last heartbeat, on a cluster being watched
 * perfectly.
 *
 * `watching` is every span that watched the kinds, in any namespace. A gap is
 * cut wherever what they watched changes, and each part says what that was:
 * nothing, part of the scope, or only namespaces outside it.
 */
export function gapsOf(
  spans: ObservedSpan[],
  from: number,
  to: number,
  watching?: readonly ObservedSpan[],
  /** The namespaces the page shows, `[]` for all: a gap where some were watched says which. */
  scope: readonly string[] = []
): Gap[] {
  const covered = spans
    .map((span) => ({
      from: span.from,
      to: span.to ?? Math.max(span.seenAt, to),
    }))
    .filter((span) => span.to > from && span.from <= to)
    .sort((a, b) => a.from - b.from);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const span of covered) {
    if (span.from > cursor) gaps.push({ from: cursor, to: span.from });
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < to) gaps.push({ from: cursor, to, running: true });
  if (!watching) return gaps;
  const watched = watching.map((span) => ({
    from: span.from,
    to: span.to ?? Math.max(span.seenAt, to),
    scope: span.scope,
  }));
  return gaps.flatMap((gap) => partsOf(gap, watched, scope));
}

type Watched = { from: number; to: number; scope?: string[] };

function partsOf(
  gap: Gap,
  watching: readonly Watched[],
  scope: readonly string[]
): Gap[] {
  const cuts = [
    ...new Set([
      gap.from,
      gap.to,
      ...watching
        .flatMap((span) => [span.from, span.to])
        .filter((at) => at > gap.from && at < gap.to),
    ]),
  ].sort((a, b) => a - b);
  const parts: Gap[] = [];
  for (let index = 1; index < cuts.length; index += 1) {
    const [start, end] = [cuts[index - 1], cuts[index]];
    const part = {
      from: start,
      to: end,
      ...watchedIn(
        watching.filter((span) => span.from < end && span.to > start),
        scope
      ),
    };
    const last = parts.at(-1);
    if (last && sameWatch(last, part)) last.to = end;
    else parts.push(part);
  }
  if (gap.running) parts[parts.length - 1].running = true;
  return parts;
}

/** What the spans over one part of a gap watched, as the gap's words need it. */
function watchedIn(
  over: readonly Watched[],
  scope: readonly string[]
): Pick<Gap, "elsewhere" | "partial"> {
  if (over.length === 0) return {};
  const watched =
    scope.length > 0
      ? scope.filter((name) => over.some((span) => span.scope?.includes(name)))
      : [...new Set(over.flatMap((span) => span.scope ?? []))].sort();
  if (watched.length === 0) return { elsewhere: true };
  const missed = scope.filter((name) => !watched.includes(name));
  // Every namespace of the scope watched and still not covering: refused the kind there.
  if (scope.length > 0 && missed.length === 0) return {};
  return { elsewhere: true, partial: { watched, missed } };
}

const sameWatch = (a: Gap, b: Gap) =>
  Boolean(a.elsewhere) === Boolean(b.elsewhere) &&
  a.partial?.watched.join() === b.partial?.watched.join();

/** What a revision could be said about, against the revision before it. */
export type Comparison =
  /** Nothing older is on the cluster to compare with. */
  | { state: "oldest" }
  /** One of the two templates did not parse: not a revision that ran nothing. */
  | { state: "unread" }
  | {
      state: "compared";
      changes: FieldChange[];
      /** Every other field of the template that differs; `null` where the whole templates were not read. */
      others: FieldChange[] | null;
      /** Revisions between the two the cluster no longer holds. */
      missing: number;
    };

export type ChangeItem =
  | {
      kind: "revision";
      at: number | null;
      revision: Revision;
      against: Comparison;
      /**
       * Its backing object is older than the revision before it, which is
       * what a rollback leaves: the controller re-adopts the existing object
       * and only bumps its revision. `at` is when that object was created,
       * not when it became current, and nothing records the latter.
       */
      readopted: boolean;
    }
  | { kind: "delivery"; at: number | null; revision: DeliveryRevision }
  | { kind: "helm"; at: number | null; revision: HelmRevision }
  | { kind: "journal"; at: number; entry: JournalEntry }
  | { kind: "gap"; at: number; gap: Gap }
  /** A stretch watched with nothing recorded, said so it is not read as unaccounted for. */
  | { kind: "watched"; at: number; gap: Gap }
  /** The object's `creationTimestamp`: nothing before it is this object's history. */
  | { kind: "created"; at: number };

function ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface TimelineInput {
  revisions: Revision[];
  deliveries: DeliveryRevision[];
  helm: HelmRevision[];
  journal: JournalEntry[];
  spans: ObservedSpan[];
  /** Every span that watched these kinds in any namespace; see {@link gapsOf}. */
  watching?: ObservedSpan[];
  /** The namespaces the timeline is about, `[]` or absent for all. */
  scope?: readonly string[];
  window: { from: number; to: number };
  /** The object's `creationTimestamp`, where the timeline is one object's. */
  createdAt?: string | null;
}

export function comparisonOf(
  older: Revision | null,
  newer: Revision
): Comparison {
  if (!older) return { state: "oldest" };
  if (!older.templateKnown || !newer.templateKnown) return { state: "unread" };
  const missing =
    older.number !== null && newer.number !== null
      ? Math.max(0, newer.number - older.number - 1)
      : 0;
  const changes = diffRevisions(older, newer);
  return {
    state: "compared",
    changes,
    others: otherDifferences(older, newer, changes),
    missing,
  };
}

/** Everything on one clock, newest first, with the unwatched stretches in it. */
export function timelineOf(input: TimelineInput): ChangeItem[] {
  const byNumber = [...input.revisions].sort(
    (a, b) =>
      (a.number ?? -Infinity) - (b.number ?? -Infinity) ||
      (ms(a.at) ?? 0) - (ms(b.at) ?? 0)
  );
  const items: ChangeItem[] = byNumber.map((revision, index) => {
    const older = index === 0 ? null : byNumber[index - 1];
    const at = ms(revision.at);
    const olderAt = older ? ms(older.at) : null;
    return {
      kind: "revision",
      at,
      revision,
      against: comparisonOf(older, revision),
      readopted: at !== null && olderAt !== null && at < olderAt,
    };
  });
  for (const revision of input.deliveries)
    items.push({ kind: "delivery", at: ms(revision.at), revision });
  for (const revision of input.helm)
    items.push({ kind: "helm", at: ms(revision.updated), revision });
  for (const entry of input.journal)
    items.push({ kind: "journal", at: entry.at, entry });
  // An object sixteen minutes old was not unobserved a week ago: it did not
  // exist. Its timeline starts where it does.
  const born = ms(input.createdAt ?? null);
  const from =
    born === null ? input.window.from : Math.max(input.window.from, born);
  if (born !== null && born >= input.window.from) {
    const watchedBirth = input.journal.some(
      (entry) => entry.field === "created" && entry.at >= born
    );
    if (!watchedBirth) items.push({ kind: "created", at: born });
  }
  for (const gap of gapsOf(
    input.spans,
    from,
    input.window.to,
    input.watching,
    input.scope
  ))
    items.push({ kind: "gap", at: gap.to, gap });
  return items.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

/**
 * What the Changes tab holds, each kind of row counted in its own words: the
 * changes this app saw are the number the shared file's "What changed" gives.
 */
export function changesCount(items: readonly ChangeItem[], t: T): string {
  const n = (kind: ChangeItem["kind"]) =>
    items.filter((item) => item.kind === kind).length;
  const parts = [
    [n("journal"), "changesSeen"],
    [n("revision"), "revisionCount"],
    [n("delivery"), "deliveryCount"],
    [n("helm"), "releases"],
  ] as const;
  return parts
    .filter(([count]) => count > 0)
    .map(([count, key]) => t("count", key, { n: count }))
    .join(" · ");
}

/** Where a workload says plain Helm installed it. */
export function helmReleaseOf(
  annotations: Record<string, string>,
  namespace: string
): { name: string; namespace: string } | null {
  const name = annotations[HELM_RELEASE_NAME];
  if (!name) return null;
  return { name, namespace: annotations[HELM_RELEASE_NAMESPACE] ?? namespace };
}
