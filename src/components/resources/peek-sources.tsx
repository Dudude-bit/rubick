import { load as parseYaml } from "js-yaml";

import { commands } from "@/lib/commands";
import { getApiVersion, toKind } from "@/lib/resource-registry";
import { vendorPeek } from "@/integrations";
import type { T as Translate } from "@/i18n/useT";
import type { PeekTarget } from "@/hooks/usePeek";
import type { KeyValue } from "./key-values";
import type {
  ConditionInfo,
  CustomResourceDetailInfo,
} from "@/generated/types";
import {
  conditionItem,
  controlledBy,
  source,
  type PeekSource,
  type PeekSources,
  type PeekSummary,
} from "./peek-sources-kit";
import { CLUSTER_SOURCES } from "./peek-sources-cluster";
import { GATEWAY_SOURCES } from "./peek-sources-gateway";
import { WORKLOAD_SOURCES } from "./peek-sources-workloads";
import { CONFIG_STORAGE_SOURCES } from "./peek-sources-storage";
import { NETWORK_SOURCES } from "./peek-sources-network";

export type { PeekGroup, PeekSummary } from "./peek-sources-kit";

/**
 * What each kind says about itself in the peek's Overview tab.
 *
 * Kind to the command its detail page already uses, plus the handful of rows
 * that page leads with. Anything missing here falls back to the raw manifest,
 * which every kind answers.
 */
const SOURCES: PeekSources = {
  ...CLUSTER_SOURCES,
  ...GATEWAY_SOURCES,
  ...WORKLOAD_SOURCES,
  ...CONFIG_STORAGE_SOURCES,
  ...NETWORK_SOURCES,
};

export function resolveSource(target: PeekTarget): PeekSource {
  // A custom resource first, and never by kind: two CRDs may declare the same
  // kind in different groups, and the object being looked at is the one whose
  // CRD the reference named.
  if (target.crd) return customResourceSource(target.crd);
  const resolved = toKind(target.kind);
  const known = resolved ? SOURCES[resolved] : undefined;
  return known ?? manifestSource(resolved ?? target.kind);
}

/**
 * A custom resource, read through the CRD that defines it.
 *
 * Not {@link manifestSource} with a different argument: `getManifest` is given
 * an `apiVersion`, and the only one available for a kind outside the registry
 * is `getApiVersion`'s fallback of `v1` — which asks the core API for an Argo
 * Application and gets a 404, an error panel for every custom resource in the
 * cluster. The backend already resolves a CRD's real group and version from
 * its name, which is what the detail page uses.
 *
 * `spec` and `status` are drawn the same way an unrecognised manifest's are:
 * scalars, dotted, capped. Nothing here reads a field by name, because the
 * whole population of this source is kinds this app has no schema for — and a
 * peek that understood Argo's `status.health` would be vendor knowledge in
 * the core, which is what the integrations seam exists to prevent.
 */
function customResourceSource(crdName: string): PeekSource {
  // A kind the vendor tree owns gets the vendor's own reading — the same
  // parser its routing page trusts — in place of the flattened spec. The
  // shell rows stay core either way: what controls it, and its labels.
  const vendor = vendorPeek(crdName);
  return source(
    (name, namespace) => commands.getCustomResource(crdName, name, namespace),
    (resource: CustomResourceDetailInfo, _target, t) => {
      const status = resource.status as Record<string, unknown> | null;
      const body = vendor?.(resource, t);
      return {
        status: body?.status ?? customResourceState(status),
        createdAt: resource.createdAt,
        groups: [
          ...controlledBy(resource.ownerReferences, resource.namespace, t),
          ...(body?.groups ?? [
            {
              title: t("columns", "status"),
              items: flatten(status, MANIFEST_ROW_LIMIT),
              emptyMessage: t("empty", "nothingReportedYet"),
            },
            {
              title: t("columns", "spec"),
              items: flatten(resource.spec, MANIFEST_ROW_LIMIT),
              emptyMessage: t("empty", "noSpec"),
            },
          ]),
          {
            title: t("columns", "labels"),
            count: Object.keys(resource.labels).length || undefined,
            items: Object.entries(resource.labels)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([label, value]) => ({ label, value, mono: true })),
            emptyMessage: t("empty", "noLabels"),
          },
        ],
      };
    }
  );
}

/**
 * The one word for the header badge, from the two places an operator is
 * likely to have put one.
 *
 * `phase` and `state` are the conventional free-form fields; `conditions` is
 * the upstream `metav1.Condition` shape, and a `Ready` condition is the
 * nearest thing to a universal verdict a custom resource has. Anything else
 * is left unsaid rather than guessed — an operator that reports health under
 * a name of its own gets no badge, and the flattened status underneath is
 * where the reader finds it.
 */
function customResourceState(
  status: Record<string, unknown> | null
): string | undefined {
  if (!status) return undefined;
  const said = asText(status.phase) ?? asText(status.state);
  if (said) return said;

  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const ready = conditions.find(
    (condition): condition is { type: string; status: string } =>
      typeof condition === "object" &&
      condition !== null &&
      (condition as { type?: unknown }).type === "Ready"
  );
  if (!ready) return undefined;
  return ready.status === "True" ? "Ready" : "Not ready";
}

/**
 * The fallback every kind answers. The manifest arrives as YAML, and pasting
 * it into the panel would just be the YAML tab in a narrower column — so the
 * scalars under `status` and `spec` become rows, which is the part of a
 * manifest a reader actually scans for.
 */
function manifestSource(kind: string): PeekSource {
  return source(
    (name, namespace) =>
      commands.getManifest(kind, getApiVersion(kind), name, namespace),
    (text, _target, t) => summariseManifest(text, t)
  );
}

const MANIFEST_ROW_LIMIT = 12;

function summariseManifest(text: string, t: Translate): PeekSummary {
  const manifest = parseYaml(text);
  if (!manifest || typeof manifest !== "object") {
    return {
      groups: [
        {
          title: t("action", "manifestTab"),
          items: [],
          emptyMessage: t("empty", "nothingReportedYet"),
        },
      ],
    };
  }
  const record = manifest as Record<string, unknown>;
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const status = record.status as unknown;
  const labels = (metadata.labels ?? {}) as Record<string, string>;

  return {
    status:
      typeof status === "object" && status !== null
        ? (asText((status as Record<string, unknown>).phase) ??
          asText((status as Record<string, unknown>).state))
        : undefined,
    createdAt: asText(metadata.creationTimestamp) ?? null,
    groups: [
      {
        title: t("columns", "status"),
        items: flatten(status, MANIFEST_ROW_LIMIT),
        emptyMessage: t("empty", "nothingReportedYet"),
      },
      {
        title: t("columns", "spec"),
        items: flatten(record.spec, MANIFEST_ROW_LIMIT),
        emptyMessage: t("empty", "noSpec"),
      },
      {
        title: t("columns", "labels"),
        count: Object.keys(labels).length || undefined,
        items: Object.entries(labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, value]) => ({ label, value, mono: true })),
        emptyMessage: t("empty", "noLabels"),
      },
    ],
  };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Scalar leaves, dotted, so a nested `status.conditions` does not explode. */
export function flatten(value: unknown, limit: number): KeyValue[] {
  const rows: KeyValue[] = [];
  walk(value, "", rows, limit);
  return rows;
}

/** The one shape the whole API machinery shares — enough to read as one. */
function isConditionList(
  path: string,
  value: unknown[]
): value is Array<Record<string, unknown>> {
  return (
    /(^|\.)conditions$/i.test(path) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).type === "string" &&
        typeof (entry as Record<string, unknown>).status === "string"
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
    // the reason-first wording and polarity-aware tone every condition row
    // in the app already carries — instead of six grey fragments per entry.
    if (isConditionList(path, value)) {
      for (const entry of value.slice(0, limit - rows.length)) {
        const condition: ConditionInfo = {
          type: String(entry.type),
          status: String(entry.status),
          reason: typeof entry.reason === "string" ? entry.reason : null,
          message: typeof entry.message === "string" ? entry.message : null,
          lastTransitionTime: null,
        };
        // The same wording every condition row speaks — one implementation,
        // relabelled with the dotted path.
        rows.push({
          ...conditionItem(condition),
          label: `${path}.${condition.type}`,
        });
      }
      return;
    }
    // An array of objects is where a custom resource keeps the part anybody
    // opens it for — an IngressRoute's `routes` holds the match rule, the
    // service, the priority. Printed as "1 entries" the peek said nothing;
    // descended with indexed paths it says the thing itself, and the row
    // limit still caps how far that goes.
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
