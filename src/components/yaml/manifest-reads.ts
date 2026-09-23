/**
 * What the YAML editor reads out of a manifest's text: who delivers it, and
 * whether an edit moves the replica count. Here and not beside their
 * list-row siblings because they need the YAML parser, which loads with the
 * editor and not at startup.
 */

import { load, loadAll } from "js-yaml";

import type { DeliveryQuery } from "@/integrations";

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
 * Whether applying `edited` would set a different replica count from the one
 * `original` carried.
 *
 * `original` is what the API server had when the editor opened, so this is
 * true both when the reader typed a new number and when the buffer is stale —
 * an autoscaler moved the count under them, and applying scales the workload
 * back.
 *
 * A document that will not parse is not a replica change: the apply is about
 * to fail on its own, and the API server's message beats anything guessed
 * from here.
 */
export function changesReplicaCount(original: string, edited: string): boolean {
  const [subject] = documentsIn(original) ?? [];
  const docs = documentsIn(edited);
  if (subject === undefined || docs === null || docs.length === 0) return false;
  // The apply takes every document in the buffer, so a second one added
  // under `---` does not stop this one from moving the count.
  const counterpart =
    docs.length === 1 ? docs[0] : docs.find((doc) => sameObject(doc, subject));
  if (counterpart === undefined) return false;
  return replicaCountOf(subject) !== replicaCountOf(counterpart);
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
