import type { ReactNode } from "react";

/**
 * The data behind a metadata block. Kept apart from the components that
 * render it so a page can build its rows without importing a component
 * module, and so the render file stays exclusively components.
 */

export type KeyValueTone = "ok" | "warn" | "err" | "info";

/** The one place a tone becomes a colour, shared by every block that takes one. */
export const TONE_CLASS: Record<KeyValueTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  info: "text-info",
};

export interface KeyValue {
  /**
   * A node, not just a string: an endpoints row is keyed by its address, and
   * an address is a thing you copy.
   */
  label: ReactNode;
  value: ReactNode;
  /** Identifiers — names, images, IPs, versions — read as mono. */
  mono?: boolean;
  /** Colour the value. Reserve it for the row that is actually wrong. */
  tone?: KeyValueTone;
  /**
   * The raw text of a value that is a whole document rather than a word.
   * Set, the row draws it folded instead of drawing `value`; see
   * `isMachineDocument`.
   */
  document?: string;
}

/**
 * Annotation keys whose value a controller writes as a serialised document.
 *
 * `kubectl apply` keeps the entire manifest it last sent in the first of
 * these, which is why the annotations block of every applied object is a
 * multi-kilobyte wall of JSON on one line. The others are the same idea
 * under other names: an operator storing the state it reconciles against.
 * Membership folds the value however short it happens to be — these are
 * never worth reading at rest.
 */
const MACHINE_DOCUMENT_KEYS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "kopf.zalando.org/last-handled-configuration",
  "banzaicloud.com/last-applied",
  // Rancher and k3s stamp a gzipped, base64'd object set on everything the
  // bundled controllers own — which on a k3s cluster is most of kube-system.
  "objectset.rio.cattle.io/applied",
  "cattle.io/status",
  "field.cattle.io/publicEndpoints",
  // The HPA's alpha channel carried metrics, behaviour and conditions as
  // JSON arrays on the object itself.
  "autoscaling.alpha.kubernetes.io/conditions",
  "autoscaling.alpha.kubernetes.io/current-metrics",
  "autoscaling.alpha.kubernetes.io/metrics",
  "autoscaling.alpha.kubernetes.io/behavior",
  // Leader-election records, written every few seconds.
  "control-plane.alpha.kubernetes.io/leader",
]);

/**
 * Past this many characters a value has stopped being a word and started
 * being a document: it no longer fits the value column at any window width.
 */
const DOCUMENT_CHARS = 120;

/**
 * Whether this pair is a document a machine wrote rather than a word a
 * person typed — and so should be folded wherever it is shown.
 *
 * Two clauses, because a list of keys alone goes stale the moment a cluster
 * runs an operator nobody here has heard of. The known keys fold outright;
 * anything else folds when it is *namespaced like an annotation* and its
 * value has document shape — long, multi-line, or parseable as a JSON
 * object. The namespace check is what keeps the rule off ordinary metadata:
 * labels are capped at 63 characters by the API server and selectors and
 * storage-class parameters are single words, so none of them ever reach it.
 */
export function isMachineDocument(key: string, value: string): boolean {
  if (MACHINE_DOCUMENT_KEYS.has(key)) return true;
  if (!key.includes("/")) return false;
  return (
    value.length > DOCUMENT_CHARS ||
    value.includes("\n") ||
    parseJsonDocument(value) !== undefined
  );
}

/** The parsed value, when the text is a JSON object or array and nothing else. */
function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * A folded document, opened. JSON gets its indentation back — the whole
 * reason it is unreadable is that it was written without any — and anything
 * else is shown as it was stored.
 */
export function expandDocument(text: string): string {
  const parsed = parseJsonDocument(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

/** What the reader is being offered before they open it. */
export function describeDocument(text: string): string {
  const shape = parseJsonDocument(text) === undefined ? "text" : "JSON";
  return `${shape} · ${text.length} chars`;
}

/**
 * Labels, annotations and selectors are all string maps whose values are
 * identifiers, so they are always mono and always sorted — a map arrives in
 * whatever order the API serialised it, and a block that reorders itself
 * between polls is unreadable.
 *
 * Except when the value is not an identifier at all but a manifest a
 * controller parked on the object. Those are marked here rather than at the
 * eighteen call sites, so one rule decides it everywhere.
 */
export function recordToKeyValues(record: Record<string, string>): KeyValue[] {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) =>
      isMachineDocument(label, value)
        ? { label, value, document: value }
        : { label, value, mono: true }
    );
}
