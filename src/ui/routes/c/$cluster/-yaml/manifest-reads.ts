/**
 * What the YAML editor reads out of a manifest's text: who delivers it, and
 * whether an edit moves the replica count. Here and not beside their
 * list-row siblings because they need the YAML parser, which loads with the
 * editor and not at startup.
 */

import { load, loadAll } from "js-yaml";

import type { DryRunDocument } from "@/generated/types";
import type { DeliveryQuery } from "@/integrations";
import {
  WITHHELD_MARKER,
  withheldCopyIn,
  withheldKeysOf,
} from "@/lib/withheld";

/**
 * The same question, asked of a manifest rather than of a list row.
 *
 * The YAML editor has no typed object behind it — it has the document, which
 * states its own `apiVersion`, `kind` and `metadata`. Reading the query out of
 * the text is therefore both free and *better* than {@link apiGroupOf}: a
 * custom resource's group is in the document and will never be in the registry,
 * so an Argo `Application` edited by hand gets the same answer a Deployment
 * does.
 *
 * Always the text the API server gave, never the buffer. Deleting the tracking
 * label from the editor does not change who owns the object, and asking the
 * question of the edited copy would let a reader talk the warning away by
 * typing.
 */
export function deliveryOfManifest(text: string): DeliveryQuery | null {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const { apiVersion, kind } = doc;
  if (typeof apiVersion !== "string" || typeof kind !== "string") return null;
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  const name = metadata.name;
  if (typeof name !== "string" || name === "") return null;

  const slash = apiVersion.indexOf("/");
  return {
    group: slash === -1 ? "" : apiVersion.slice(0, slash),
    kind,
    name,
    namespace:
      typeof metadata.namespace === "string" ? metadata.namespace : null,
    labels: stringsOf(metadata.labels),
    annotations: stringsOf(metadata.annotations),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the string-valued entries: a label with a number in it is not one. */
function stringsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * The keys of the buffer that still hold the placeholder: applied as it is,
 * the placeholder would be written over each of them.
 */
export function withheldKeysIn(text: string): string[] {
  // Nearly every buffer has none, and is not parsed on every keystroke.
  if (!text.includes(WITHHELD_MARKER)) return [];
  return (documentsIn(text) ?? []).flatMap(withheldKeysOf);
}

/** An annotation holding a record the backend blanked, and the keys blanked. */
export interface WithheldCopy {
  annotation: string;
  keys: string[];
}

/**
 * The annotations of the buffer that hold a blanked record. The backend
 * leaves each out of what Apply sends, so the placeholder is never stored
 * over the record on the cluster; the corpus holds the two to one answer.
 */
export function withheldCopiesIn(text: string): WithheldCopy[] {
  if (!text.includes(WITHHELD_MARKER)) return [];
  return (documentsIn(text) ?? []).flatMap((doc) => {
    const metadata = isRecord(doc.metadata) ? doc.metadata : {};
    return Object.entries(stringsOf(metadata.annotations))
      .map(([annotation, value]) => ({
        annotation,
        keys: withheldCopyIn(value),
      }))
      .filter((copy) => copy.keys.length > 0);
  });
}

/**
 * Whether applying `edited` would set a different replica count from the one
 * `original` carried.
 *
 * `original` is what the API server had when the editor opened, so this is
 * the number the reader typed and nothing newer: a count an autoscaler moved
 * since is {@link liveReplicaMove}'s to see.
 *
 * A document that will not parse is not a replica change: the apply is about
 * to fail on its own, and the API server's message beats anything guessed
 * from here.
 */
export function changesReplicaCount(original: string, edited: string): boolean {
  const [subject] = documentsIn(original) ?? [];
  const docs = documentsIn(edited);
  if (subject === undefined || docs === null || docs.length === 0) return false;
  // The apply takes every document in the buffer, in order, so a second one
  // added under `---` does not stop this one from moving the count — and
  // each copy of this object sets its own count, the last one to stay.
  const counterparts =
    docs.length === 1 ? docs : docs.filter((doc) => sameObject(doc, subject));
  return counterparts.some(
    (doc) => replicaCountOf(subject) !== replicaCountOf(doc)
  );
}

/** The count the cluster holds now, and the one applying would leave. */
export interface ReplicaMove {
  from: number;
  to: number;
  /** The cluster's count is no longer the one the editor read. */
  drifted: boolean;
}

/**
 * What applying does to the replica count the editor's object has on the
 * cluster now, read from the dry run. The buffer is as old as the moment it
 * was read, and an autoscaler that moved the count since is undone by it.
 *
 * `null` where the count stays. `"unknown"` where the buffer sets a count and
 * the server showed no current object to hold it against (`documents` is
 * `null` for a dry run that did not answer at all): not "it stays".
 */
export function liveReplicaMove(
  original: string,
  edited: string,
  documents: Pick<DryRunDocument, "outcome" | "live" | "would">[] | null
): ReplicaMove | "unknown" | null {
  const [subject] = documentsIn(original) ?? [];
  if (subject === undefined) return null;
  const first = (text: string | null) =>
    text === null ? undefined : documentsIn(text)?.[0];

  let unread = documents === null;
  for (const doc of documents ?? []) {
    // Neither has a current count to move: there is no object, or no apply.
    if (doc.outcome.says === "created" || doc.outcome.says === "refused")
      continue;
    const [now, after] = [first(doc.live), first(doc.would)];
    if (now === undefined || after === undefined) {
      unread = true;
      continue;
    }
    if (!sameObject(now, subject)) continue;
    const [from, to] = [replicaCountOf(now), replicaCountOf(after)];
    return from === null || to === null || from === to
      ? null
      : { from, to, drifted: from !== replicaCountOf(subject) };
  }
  if (!unread) return null;
  const docs = documentsIn(edited) ?? [];
  const mine =
    docs.length === 1 ? docs : docs.filter((doc) => sameObject(doc, subject));
  return mine.some((doc) => replicaCountOf(doc) !== null) ? "unknown" : null;
}

/** The buffer's documents, or `null` where it will not parse. */
function documentsIn(text: string): Record<string, unknown>[] | null {
  let docs: unknown[];
  try {
    docs = loadAll(text);
  } catch {
    return null;
  }
  return docs.filter(isRecord);
}

function sameObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const meta = (doc: Record<string, unknown>) =>
    isRecord(doc.metadata) ? doc.metadata : {};
  const [left, right] = [meta(a).namespace, meta(b).namespace];
  return (
    a.kind === b.kind &&
    meta(a).name === meta(b).name &&
    (left === undefined || right === undefined || left === right)
  );
}

function replicaCountOf(doc: Record<string, unknown>): number | null {
  const spec = doc.spec;
  if (!isRecord(spec)) return null;
  return typeof spec.replicas === "number" ? spec.replicas : null;
}
