import {
  isMachineDocument,
  type KeyValue,
} from "@/components/object/key-values";
import type { ConditionInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { segmentOf } from "@/lib/access-kinds";
import { desiredComputed } from "@/lib/governance";
import { formatDate } from "@/lib/utils";
import {
  conditionItem,
  ref,
  type PeekGroup,
  type PeekSummary,
} from "../-peek/peek-sources-kit";

import {
  rbacKindOf,
  roleRefOf,
  rulesOf,
  rulesTable,
  subjectsOf,
  subjectTarget,
  type RbacKind,
  type RbacTarget,
} from "./rbac";

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

interface Walked {
  rows: KeyValue[];
  limit: number;
  /** Leaves past the limit, counted so the cut can say what it left out. */
  omitted: number;
}

function keep(walked: Walked, row: KeyValue): void {
  if (walked.rows.length < walked.limit) walked.rows.push(row);
  else walked.omitted += 1;
}

function walked(value: unknown, limit: number): Walked {
  const out: Walked = { rows: [], limit, omitted: 0 };
  walk(value, "", out);
  return out;
}

/** Scalar leaves, dotted, so a nested `status.conditions` does not explode. */
export function flatten(value: unknown, limit: number): KeyValue[] {
  return walked(value, limit).rows;
}

/** A glance's worth of rows, and one more saying how many the YAML tab still holds. */
function capped(value: unknown, t: T): KeyValue[] {
  const { rows, omitted } = walked(value, FACET_ROW_LIMIT);
  return omitted > 0
    ? [
        ...rows,
        { label: "…", value: t("empty", "moreFieldsInYaml", { n: omitted }) },
      ]
    : rows;
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

function walk(value: unknown, path: string, out: Walked): void {
  if (value === undefined) return;
  // An explicit null is the API saying the field is empty, which can be the
  // whole answer: an EndpointSlice with `ports: null` routes nothing.
  if (value === null) {
    if (path) keep(out, { label: path, value: "null", mono: true });
    return;
  }
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object");
    if (scalars.length === value.length) {
      keep(out, {
        label: path,
        value: value.length ? scalars.join(" · ") : "[]",
        mono: true,
      });
      return;
    }
    // A conditions array is verdicts, not data: one row per condition, in
    // the reason-first wording every condition row in the app carries.
    if (isConditionList(path, value)) {
      for (const entry of value) {
        const condition: ConditionInfo = {
          type: String(entry.type),
          status: String(entry.status),
          reason: typeof entry.reason === "string" ? entry.reason : null,
          message: typeof entry.message === "string" ? entry.message : null,
          lastTransitionTime: null,
        };
        keep(out, {
          ...conditionItem(condition),
          label: `${path}.${condition.type}`,
        });
      }
      return;
    }
    // An array of objects is where a custom resource keeps the part anybody
    // opens it for, so it is descended with indexed paths.
    value.forEach((child, index) => {
      walk(child, path ? `${path}.${index}` : String(index), out);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  const said = String(value);
  if (said === "") {
    keep(out, { label: path, value: '""', mono: true });
    return;
  }
  keep(
    out,
    said.includes("\n") || said.length > DOCUMENT_CHARS
      ? { label: path, value: said, document: said }
      : { label: path, value: said, mono: true }
  );
}

/** Past this a value is a document: folded, not wrapped down the column. */
const DOCUMENT_CHARS = 120;

const ENVELOPE = new Set(["apiVersion", "kind", "metadata", "spec", "status"]);

const isWords = (value: unknown): boolean =>
  typeof value !== "object" ||
  (Array.isArray(value) && value.every((entry) => typeof entry !== "object"));

const linked = (target: RbacTarget, namespace: string | null) =>
  ref(target.kind, target.name, target.namespace, {
    crd: segmentOf(target),
    showNamespace: !!target.namespace && target.namespace !== namespace,
  });

/** Roles and bindings read as what they grant and to whom, not as dotted paths. */
function rbacGroup(
  kind: RbacKind,
  field: string,
  object: Json,
  namespace: string | null,
  t: T
): PeekGroup | null {
  if (field === "rules" && (kind === "Role" || kind === "ClusterRole")) {
    const rules = rulesOf(object);
    return {
      title: field,
      count: rules.length,
      items: [],
      table: rulesTable(rules, t),
      emptyMessage: t("rbac", "noRules"),
    };
  }
  if (kind !== "RoleBinding" && kind !== "ClusterRoleBinding") return null;
  if (field === "subjects")
    return {
      title: field,
      count: subjectsOf(object).length,
      items: subjectsOf(object).map((subject) => {
        const target = subjectTarget(subject, namespace);
        return target
          ? { label: subject.kind, value: linked(target, namespace) }
          : { label: subject.kind, value: subject.name, mono: true };
      }),
      emptyMessage: t("rbac", "noSubjects"),
    };
  if (field === "roleRef") {
    const target = roleRefOf(object, namespace);
    return target
      ? {
          title: field,
          items: [{ label: target.kind, value: linked(target, namespace) }],
        }
      : null;
  }
  return null;
}

/** Secret values are never drawn here; their names are. */
const isSecretData = (object: Json, field: string) =>
  object.kind === "Secret" && (field === "data" || field === "stringData");

/**
 * Every top-level field besides the envelope: where EndpointSlice, Role,
 * PriorityClass and their like keep what they say. Single words share one
 * group; anything with structure gets its own, titled by its field name.
 */
function payloadGroups(object: Json, t: T): PeekGroup[] {
  const namespace = asText(record(object.metadata).namespace) ?? null;
  const rbac = rbacKindOf(object);
  const words: KeyValue[] = [];
  const groups: PeekGroup[] = [];
  for (const [field, value] of Object.entries(object)) {
    if (ENVELOPE.has(field) || value === undefined) continue;
    const shaped = rbac && rbacGroup(rbac, field, object, namespace, t);
    if (shaped) {
      groups.push(shaped);
    } else if (isSecretData(object, field)) {
      groups.push({
        title: field,
        items: Object.keys(record(value))
          .sort()
          .map((key) => ({ label: key, value: "••••••", mono: true })),
        emptyMessage: t("empty", "noneLower"),
      });
    } else if (value === null || isWords(value)) {
      words.push(...flatten({ [field]: value }, FACET_ROW_LIMIT));
    } else {
      groups.push({
        title: field,
        count: Array.isArray(value) ? value.length : undefined,
        items: capped(value, t),
        emptyMessage: t("empty", "noneLower"),
      });
    }
  }
  return words.length
    ? [{ title: t("columns", "fields"), items: words }, ...groups]
    : groups;
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

/** An autoscaler that never computed a count leaves `desiredReplicas` at 0, which is not a wish for none. */
function readStatus(fields: Json, rows: KeyValue[], t: T): KeyValue[] {
  if (fields.kind !== "HorizontalPodAutoscaler") return rows;
  const listed = record(fields.status).conditions;
  const conditions = (Array.isArray(listed) ? listed : [])
    .map(record)
    .flatMap(({ type, status }) =>
      typeof type === "string" && typeof status === "string"
        ? [{ type, status }]
        : []
    );
  if (desiredComputed(conditions)) return rows;
  return rows.map((row) =>
    row.label === "desiredReplicas"
      ? { label: row.label, value: t("readings", "hpaNothingComputed") }
      : row
  );
}

/**
 * What any object says about itself, read without knowing its kind: its
 * status and spec as dotted rows, every other field it carries, who writes
 * it, and its labels, annotations and finalizers. The peek and the object
 * page draw the same groups from this, so the two never read one object two
 * ways. A kind that keeps its payload at the top level has no spec to miss.
 */
export function objectFacets(
  object: unknown,
  t: T,
  /** From discovery; `false` is a kind with no status at all, `undefined` not known. */
  hasStatus?: boolean
): PeekSummary {
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

  const status = readStatus(fields, capped(fields.status, t), t);
  const spec = capped(fields.spec, t);
  const payload = payloadGroups(fields, t);
  const enveloped = payload.length === 0 || spec.length > 0;
  const statusDrawn = status.length > 0 || (enveloped && hasStatus !== false);
  // No status subresource and no spec: a ServiceAccount, a ConfigMap, a Role,
  // which keep their fields at the top level. "No spec" there reads as a gap.
  const specDrawn = spec.length > 0 || (enveloped && hasStatus !== false);

  return {
    status: stateOf(fields.status),
    createdAt: asText(metadata.creationTimestamp) ?? null,
    groups: [
      ...(statusDrawn
        ? [
            {
              title: t("columns", "status"),
              items: status,
              emptyMessage: t("empty", "nothingReportedYet"),
            },
          ]
        : []),
      ...(specDrawn
        ? [
            {
              title: t("columns", "spec"),
              items: spec,
              emptyMessage: t("empty", "noSpec"),
            },
          ]
        : []),
      ...payload,
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
