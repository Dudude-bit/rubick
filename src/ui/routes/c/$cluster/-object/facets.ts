import {
  isMachineDocument,
  type KeyValue,
} from "@/components/object/key-values";
import type { ConditionInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatDate } from "@/lib/utils";
import { conditionItem, type PeekSummary } from "../-peek/peek-sources-kit";

/** Rows per group: a glance, not the YAML tab in a narrower column. */
export const FACET_ROW_LIMIT = 12;

type Json = Record<string, unknown>;

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

/**
 * The one word for a header badge, from where operators conventionally put
 * one: `phase`, `state`, or a `Ready` condition. Anything else is left
 * unsaid rather than guessed.
 */
export function stateOf(status: unknown): string | undefined {
  const fields = record(status);
  const said = asText(fields.phase) ?? asText(fields.state);
  if (said) return said;
  const conditions = Array.isArray(fields.conditions) ? fields.conditions : [];
  const ready = conditions.find(
    (condition): condition is { type: string; status: string } =>
      record(condition).type === "Ready"
  );
  if (!ready) return undefined;
  return ready.status === "True" ? "Ready" : "Not ready";
}

/** Scalar leaves, dotted, so a nested `status.conditions` does not explode. */
export function flatten(value: unknown, limit: number): KeyValue[] {
  const rows: KeyValue[] = [];
  walk(value, "", rows, limit);
  return rows;
}

/** The one shape the whole API machinery shares, enough to read as one. */
function isConditionList(
  path: string,
  value: unknown[]
): value is Array<Record<string, unknown>> {
  return (
    /(^|\.)conditions$/i.test(path) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof record(entry).type === "string" &&
        typeof record(entry).status === "string"
    )
  );
}

function walk(
  value: unknown,
  path: string,
  rows: KeyValue[],
  limit: number
): void {
  if (rows.length >= limit || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object");
    if (scalars.length === value.length) {
      rows.push({ label: path, value: scalars.join(" · "), mono: true });
      return;
    }
    // A conditions array is verdicts, not data: one row per condition, in
    // the reason-first wording every condition row in the app carries.
    if (isConditionList(path, value)) {
      for (const entry of value.slice(0, limit - rows.length)) {
        const condition: ConditionInfo = {
          type: String(entry.type),
          status: String(entry.status),
          reason: typeof entry.reason === "string" ? entry.reason : null,
          message: typeof entry.message === "string" ? entry.message : null,
          lastTransitionTime: null,
        };
        rows.push({
          ...conditionItem(condition),
          label: `${path}.${condition.type}`,
        });
      }
      return;
    }
    // An array of objects is where a custom resource keeps the part anybody
    // opens it for, so it is descended with indexed paths.
    value.forEach((child, index) => {
      walk(child, path ? `${path}.${index}` : String(index), rows, limit);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, rows, limit);
    }
    return;
  }
  rows.push({ label: path, value: String(value), mono: true });
}

/** Who writes the object, from its managed fields: one row per manager. */
function writers(metadata: Json): KeyValue[] {
  const entries = Array.isArray(metadata.managedFields)
    ? metadata.managedFields.map(record)
    : [];
  const latest = new Map<string, Json>();
  for (const entry of entries) {
    const manager = asText(entry.manager);
    if (!manager) continue;
    const held = latest.get(manager);
    if (!held || String(entry.time ?? "") > String(held.time ?? ""))
      latest.set(manager, entry);
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([manager, entry]) => ({
      label: manager,
      value: [
        asText(entry.operation),
        asText(entry.subresource),
        formatDate(entry.time),
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    }));
}

/**
 * What any object says about itself, read without knowing its kind: its
 * status and spec as dotted rows, who writes it, and its labels,
 * annotations and finalizers. The peek and the object page draw the same
 * groups from this, so the two never read one object two ways.
 */
export function objectFacets(object: unknown, t: T): PeekSummary {
  const fields = record(object);
  const metadata = record(fields.metadata);
  const labels = record(metadata.labels) as Record<string, string>;
  const annotations = record(metadata.annotations) as Record<string, string>;
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.map(String)
    : [];
  const written = writers(metadata);
  const sorted = (map: Record<string, string>) =>
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b));

  return {
    status: stateOf(fields.status),
    createdAt: asText(metadata.creationTimestamp) ?? null,
    groups: [
      {
        title: t("columns", "status"),
        items: flatten(fields.status, FACET_ROW_LIMIT),
        emptyMessage: t("empty", "nothingReportedYet"),
      },
      {
        title: t("columns", "spec"),
        items: flatten(fields.spec, FACET_ROW_LIMIT),
        emptyMessage: t("empty", "noSpec"),
      },
      ...(written.length > 0
        ? [{ title: t("columns", "writtenBy"), items: written }]
        : []),
      {
        title: t("columns", "labels"),
        count: Object.keys(labels).length || undefined,
        items: sorted(labels).map(([label, value]) => ({
          label,
          value,
          mono: true,
        })),
        emptyMessage: t("empty", "noLabels"),
      },
      {
        title: t("columns", "annotations"),
        count: Object.keys(annotations).length || undefined,
        items: sorted(annotations).map(([label, value]) => ({
          label,
          value,
          mono: true,
          document: isMachineDocument(label, value) ? value : undefined,
        })),
        emptyMessage: t("empty", "noAnnotations"),
      },
      ...(finalizers.length > 0
        ? [
            {
              title: t("columns", "finalizers"),
              items: finalizers.map((name, index) => ({
                label: String(index + 1),
                value: name,
                mono: true,
              })),
            },
          ]
        : []),
    ],
  };
}
