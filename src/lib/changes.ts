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
  ControllerRevisionInfo,
  DaemonSetInfo,
  DeploymentContainerInfo,
  DeploymentInfo,
  HelmRevision,
  ReplicaSetInfo,
  StatefulSetInfo,
} from "@/generated/types";
import type { DeliveryRevision } from "@/integrations";

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
    templateAnnotations: {},
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
  };
}

export interface FieldChange {
  /** The container the field belongs to; `null` for a template-level field. */
  container: string | null;
  field: string;
  from: string | null;
  to: string | null;
}

function envWord(entry: DeploymentContainerInfo["env"][number]): string {
  if (entry.value !== null && entry.value !== undefined) return entry.value;
  const source = entry.valueFrom;
  return source
    ? `${source.sourceType}:${source.name}${source.key ? `/${source.key}` : ""}`
    : "";
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
    out.push(
      ...diffMaps(
        name,
        "env.",
        new Map(a.env.map((e) => [e.name, envWord(e)])),
        new Map(b.env.map((e) => [e.name, envWord(e)]))
      ),
      ...diffMaps(name, "", resourceMap(a), resourceMap(b))
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

export type JournalField =
  "created" | "deleted" | "generation" | "image" | "replicas" | "annotation";

export interface JournalEntry {
  id: string;
  context: string;
  kind: string;
  namespace: string;
  name: string;
  at: number;
  field: JournalField;
  /** The image index or annotation key the change is about. */
  key: string | null;
  from: string | null;
  to: string | null;
}

/** The fields the journal watches, read off one list row. */
export interface Snapshot {
  generation: number | null;
  images: string[];
  replicas: number | null;
  hashes: Map<string, string>;
}

type WatchedRow = DeploymentInfo | StatefulSetInfo | DaemonSetInfo;

export function snapshotOf(kind: string, row: WatchedRow): Snapshot {
  if (kind === "Deployment") {
    const d = row as DeploymentInfo;
    return {
      generation: d.generation,
      images: [...d.containers, ...d.initContainers].map((c) => c.image),
      replicas: d.replicas.desired,
      hashes: configHashes(d.templateAnnotations),
    };
  }
  if (kind === "StatefulSet") {
    const s = row as StatefulSetInfo;
    return {
      generation: s.generation,
      images: s.images,
      replicas: s.replicas.desired,
      hashes: configHashes(s.templateAnnotations),
    };
  }
  const ds = row as DaemonSetInfo;
  return {
    generation: ds.generation,
    images: ds.images,
    replicas: null,
    hashes: configHashes(ds.templateAnnotations),
  };
}

/** The entries one row's change writes; empty when the watched fields held still. */
export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot
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
  const width = Math.max(prev.images.length, next.images.length);
  for (let index = 0; index < width; index += 1) {
    const from = prev.images[index] ?? null;
    const to = next.images[index] ?? null;
    if (from !== to) out.push({ field: "image", key: String(index), from, to });
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
}

export interface Gap {
  from: number;
  to: number;
}

/** The parts of [from, to] no span covers. The whole window, when nothing was ever watched. */
export function gapsOf(spans: ObservedSpan[], from: number, to: number): Gap[] {
  const covered = spans
    .map((span) => ({ from: span.from, to: span.to ?? span.seenAt }))
    .filter((span) => span.to > from && span.from < to)
    .sort((a, b) => a.from - b.from);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const span of covered) {
    if (span.from > cursor) gaps.push({ from: cursor, to: span.from });
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

export type ChangeItem =
  | {
      kind: "revision";
      at: number | null;
      revision: Revision;
      /** Against the revision before it; `null` for the oldest one known. */
      changes: FieldChange[] | null;
    }
  | { kind: "delivery"; at: number | null; revision: DeliveryRevision }
  | { kind: "helm"; at: number | null; revision: HelmRevision }
  | { kind: "journal"; at: number; entry: JournalEntry }
  | { kind: "gap"; at: number; gap: Gap };

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
  window: { from: number; to: number };
}

/** Everything on one clock, newest first, with the unwatched stretches in it. */
export function timelineOf(input: TimelineInput): ChangeItem[] {
  const byNumber = [...input.revisions].sort(
    (a, b) =>
      (a.number ?? -Infinity) - (b.number ?? -Infinity) ||
      (ms(a.at) ?? 0) - (ms(b.at) ?? 0)
  );
  const items: ChangeItem[] = byNumber.map((revision, index) => ({
    kind: "revision",
    at: ms(revision.at),
    revision,
    changes: index === 0 ? null : diffRevisions(byNumber[index - 1], revision),
  }));
  for (const revision of input.deliveries)
    items.push({ kind: "delivery", at: ms(revision.at), revision });
  for (const revision of input.helm)
    items.push({ kind: "helm", at: ms(revision.updated), revision });
  for (const entry of input.journal)
    items.push({ kind: "journal", at: entry.at, entry });
  for (const gap of gapsOf(input.spans, input.window.from, input.window.to))
    items.push({ kind: "gap", at: gap.to, gap });
  return items.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
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
