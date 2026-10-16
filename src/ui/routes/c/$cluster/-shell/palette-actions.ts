import { AlignLeft, Copy, ExternalLink, Link2 } from "lucide-react";

import { clusterOf, hrefOf, servedObjectLink, type AppLink } from "@/lib/links";
import {
  getResourceDefinition,
  ResourceType,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import type { CatalogEntry } from "@/generated/types";
import type { Entry } from "./palette-entries";
import type { T } from "@/i18n/useT";
import type { PeekAction, PeekActionId } from "../-peek/peek-actions";
import type { IconType } from "./palette-entries";

/**
 * Whose actions a row opens, where it opens any: the page's object, or a hit
 * in the cluster this window is on. Every action runs against that cluster,
 * so a hit from another one is offered none rather than one aimed wrong.
 */
export function actionTargetOfEntry(
  entry: Entry | undefined,
  currentContext: string | null
): ActionTarget | null {
  if (entry?.kind === "page-actions") return entry.target;
  if (entry?.kind !== "hit" || entry.hit.context !== currentContext)
    return null;
  const { hit } = entry;
  return {
    context: hit.context,
    kind: hit.kind,
    group: hit.group,
    plural: hit.plural,
    name: hit.name,
    namespace: hit.namespace,
  };
}

/** One object the palette can act on, in the cluster it lives in. */
export interface ActionTarget {
  context: string;
  kind: string;
  group: string;
  plural: string;
  name: string;
  namespace: string | null;
}

export type PaletteActionId =
  | PeekActionId
  | "logs"
  | "copyName"
  | "copyLink"
  | "openTab";

export interface PaletteAction {
  id: PaletteActionId;
  label: string;
  icon: IconType;
  danger?: boolean;
  /** Why it cannot run on this object as it stands. */
  reason?: string;
  busy?: boolean;
}

/** What the action host read of its object, and the registry's actions for it. */
export type ActionsReport =
  | { target: string; reading: "pending" }
  | { target: string; reading: "failed"; error: string }
  | {
      target: string;
      reading: "ready";
      actions: PeekAction[];
      busy: Partial<Record<PeekActionId, boolean>>;
    };

/** The kinds whose page opens on a Logs tab. */
const LOGS_KINDS: ReadonlySet<ResourceKind> = new Set([
  ResourceType.Pod,
  ResourceType.Deployment,
  ResourceType.StatefulSet,
  ResourceType.DaemonSet,
  ResourceType.ReplicaSet,
  ResourceType.Job,
  ResourceType.CronJob,
]);

export function targetKey(target: ActionTarget): string {
  return [
    target.context,
    target.group,
    target.plural,
    target.namespace ?? "",
    target.name,
  ].join("/");
}

/** The registry's own kind, only where the target is that very kind. */
export function registryKindOf(target: ActionTarget): ResourceKind | null {
  const known = toKind(target.kind);
  if (!known) return null;
  const definition = getResourceDefinition(known);
  return definition.group === target.group &&
    definition.plural === target.plural
    ? known
    : null;
}

export function targetLink(
  target: ActionTarget,
  options?: { tab?: string }
): AppLink | null {
  return servedObjectLink(target, { cluster: target.context, ...options });
}

/**
 * Everything the palette offers on one object: the registry's actions, the
 * same ones the peek and the object menu run, with Delete last; Logs where
 * the page has that tab; and the object menu's own Copy and Open.
 */
export function paletteActionsOf(
  target: ActionTarget,
  registry: readonly PeekAction[],
  busy: Partial<Record<PeekActionId, boolean>>,
  t: T
): PaletteAction[] {
  const known = registryKindOf(target);
  const logs: PaletteAction[] =
    known && LOGS_KINDS.has(known)
      ? [{ id: "logs", label: t("action", "logs"), icon: AlignLeft }]
      : [];
  const ordered = [
    ...registry.filter((action) => action.id !== "delete"),
    ...registry.filter((action) => action.id === "delete"),
  ].map((action): PaletteAction => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    danger: action.danger,
    reason: action.reason,
    busy: busy[action.id],
  }));
  const link = targetLink(target);
  const shared: PaletteAction[] = [
    { id: "copyName", label: t("action", "copyName"), icon: Copy },
    ...(link && clusterOf(hrefOf(link))
      ? [
          {
            id: "copyLink" as const,
            label: t("action", "copyLink"),
            icon: Link2,
          },
        ]
      : []),
    { id: "openTab", label: t("action", "openInNewTab"), icon: ExternalLink },
  ];
  return [...logs, ...ordered, ...shared];
}

/** An action's words, in the reader's language or in English. */
export function actionMatches(
  action: PaletteAction,
  english: string | undefined,
  needle: string
): boolean {
  const lower = needle.trim().toLowerCase();
  if (!lower) return true;
  return [action.label, english ?? ""].some((label) =>
    label.toLowerCase().includes(lower)
  );
}

/**
 * The object the page on screen is about, from the route it matched: the
 * segment its address names it by, its name and its namespace. A page that
 * is not one object's, a list or a Helm release, is none.
 */
export function objectOnScreen(
  match: { fullPath: string; params: Record<string, string | undefined> },
  context: string,
  catalog: readonly CatalogEntry[] = []
): ActionTarget | null {
  const { name, namespace, resource } = match.params;
  if (!name) return null;
  const rest = match.fullPath
    .replace(/^\/c\/\$cluster\//, "")
    .replace(/\/(\$namespace\/)?\$name$/, "");
  const segment = rest === "$resource" ? resource : rest;
  if (!segment || segment.includes("/") || segment.includes("$")) return null;
  const known = toKind(segment);
  if (known) {
    const definition = getResourceDefinition(known);
    return {
      context,
      kind: known,
      group: definition.group,
      plural: definition.plural,
      name,
      namespace: namespace ?? null,
    };
  }
  const dot = segment.indexOf(".");
  const plural = dot === -1 ? segment : segment.slice(0, dot);
  const group = dot === -1 ? "" : segment.slice(dot + 1);
  const served = catalog.find(
    (entry) => entry.group === group && entry.plural === plural
  );
  return {
    context,
    kind: served?.kind ?? plural,
    group,
    plural,
    name,
    namespace: namespace ?? null,
  };
}

/** A report as words: two that say the same thing are the same report. */
export function sameReport(a: ActionsReport | null, b: ActionsReport): boolean {
  return a !== null && reportWords(a) === reportWords(b);
}

function reportWords(report: ActionsReport): string {
  return JSON.stringify(
    report.reading === "ready"
      ? {
          ...report,
          actions: report.actions.map((action) => [
            action.id,
            action.label,
            action.reason,
            action.danger,
          ]),
        }
      : report
  );
}
