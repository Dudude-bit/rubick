import {
  AlignLeft,
  BadgeCheck,
  CircleDashed,
  EyeOff,
  ExternalLink,
  History,
  ShieldCheck,
  Zap,
  Bell,
  type LucideIcon,
} from "lucide-react";

import type { ConditionInfo, EventInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { journalWords, type JournalEntry } from "./changes";
import { conditionRole } from "./condition-health";
import { familyOf } from "./event-stories";
import { iconSvg } from "./icon-svg";
import { parseImageRef } from "./image-ref";
import {
  VALUE_CLOSE,
  VALUE_OPEN,
  type ReportChange,
  type ReportIcons,
  type ReportRef,
  type ReportSection,
  type ReportWords,
} from "./report";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "./resource-registry";
import { identHue, kindHue, splitName } from "./resource-identity";
import { ROLE_ICON, statusRole } from "./status-role";

/** A section with where it sits: the page's own first, the evidence after, the logs last. */
export type PlacedSection = ReportSection & { order: number };

export const ORDER = {
  summary: 10,
  own: 20,
  conditions: 30,
  events: 40,
  changes: 50,
  traffic: 60,
  connections: 70,
  vendor: 80,
  logs: 90,
} as const;

/** The kinds `get_resource_connections` answers for; the rest have no graph to show. */
export const CONNECTED_KINDS = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
  "Service",
  "Ingress",
  "PersistentVolumeClaim",
  "ConfigMap",
  "Secret",
  "Node",
  "PersistentVolume",
]);

/** As many journal entries as a reader scrolls; older ones are in the app. */
const MAX_CHANGES = 20;
/** Enough events to see a pattern; the Events screen has the rest. */
const MAX_EVENTS = 25;

export function kindIcon(kind: string): LucideIcon {
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  return resolved ? getResourceDefinition(resolved).icon : CircleDashed;
}

/** The object the way `ResourceName` draws it, so the file and the app agree on its colours. */
export function refOf(object: {
  kind: string;
  name: string;
  namespace: string | null;
}): ReportRef {
  const { stem, tail } = splitName(object.name);
  return {
    kind: object.kind,
    namespace: object.namespace,
    stem,
    tail,
    icon: iconSvg(kindIcon(object.kind)),
    kindHue: kindHue(object.kind),
    identHue: identHue(object.kind, object.name),
  };
}

export function frameIcons(): ReportIcons {
  return {
    roles: {
      ok: iconSvg(ROLE_ICON.ok),
      pending: iconSvg(ROLE_ICON.pending),
      warn: iconSvg(ROLE_ICON.warn),
      err: iconSvg(ROLE_ICON.err),
      neutral: iconSvg(ROLE_ICON.neutral),
    },
    verdict: iconSvg(Zap),
    notRead: iconSvg(EyeOff),
    open: iconSvg(ExternalLink),
    shield: iconSvg(ShieldCheck),
  };
}

export function frameWords(t: T, lang: string, notRead: number): ReportWords {
  return {
    lang,
    captured: t("share", "captured"),
    openInRubick: t("share", "openInRubick"),
    linkFallback: t("share", "linkFallback"),
    verdict: t("share", "sectionVerdict"),
    notRead: t("share", "sectionNotRead"),
    notReadCount: t("share", "notReadCount", { n: notRead }),
    allRead: t("share", "allRead"),
    nothingHere: t("share", "nothingHere"),
    previousRun: t("share", "previousRun"),
    init: t("share", "initContainer"),
    madeBy: t("share", "madeBy"),
    noSecrets: t("share", "noSecrets"),
  };
}

/** Conditions as the Conditions tab reads them, with the role the app gives each one. */
export function conditionsSection(
  conditions: readonly ConditionInfo[],
  t: T
): PlacedSection {
  return {
    id: "conditions",
    order: ORDER.conditions,
    title: t("columns", "conditions"),
    icon: iconSvg(BadgeCheck),
    count: conditions.length,
    body: {
      type: "conditions",
      rows: conditions.map((condition) => ({
        type: condition.type,
        status: condition.status,
        role: conditionRole(condition),
        reason: condition.reason,
        message: condition.message,
        since: condition.lastTransitionTime,
      })),
    },
  };
}

/** Warnings first, newest first: what went wrong is what the reader came for. */
export function eventsSection(
  events: readonly EventInfo[] | undefined,
  unread: string | null,
  withObject = false
): PlacedSection {
  const sorted = [...(events ?? [])].sort(
    (a, b) =>
      Number(b.type === "Warning") - Number(a.type === "Warning") ||
      (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? "")
  );
  return {
    id: "events",
    order: ORDER.events,
    title: "Events",
    icon: iconSvg(Bell),
    count: sorted.length,
    unread,
    body: {
      type: "events",
      rows: sorted.slice(0, MAX_EVENTS).map((event) => ({
        at: event.lastTimestamp ?? event.firstTimestamp,
        role: event.type === "Warning" ? "warn" : statusRole(event.type),
        reason: event.reason ?? event.type,
        message: event.message ?? "",
        count: event.count ?? 1,
        ref: withObject
          ? refOf({
              kind: event.involvedObject.kind,
              name: event.involvedObject.name,
              namespace: event.namespace || null,
            })
          : undefined,
      })),
    },
  };
}

/**
 * Each value marked so the file can draw it as one, and an image cut to its
 * tag where both sides are the same repository.
 */
function valuesOf(entry: JournalEntry) {
  const from = entry.from ? parseImageRef(entry.from) : null;
  const to = entry.to ? parseImageRef(entry.to) : null;
  const sameRepository =
    entry.field === "image" &&
    from !== null &&
    to !== null &&
    from.registry === to.registry &&
    from.repository === to.repository;
  return (value: string | null) => {
    const parsed = sameRepository && value ? parseImageRef(value) : null;
    const shown =
      value === null
        ? "∅"
        : (parsed?.tag ?? parsed?.digest?.slice(0, 19) ?? value);
    return `${VALUE_OPEN}${shown}${VALUE_CLOSE}`;
  };
}

/**
 * What this app watched change on the object or on what owns it, one row per
 * moment, and a sentence rather than silence when it never watched this
 * cluster at all.
 */
export function changesSection(
  entries: readonly JournalEntry[],
  context: string,
  subject: { kind: string; name: string; namespace: string | null },
  t: T
): PlacedSection {
  const family = familyOf(subject.name);
  const mine = entries
    .filter(
      (entry) =>
        entry.context === context &&
        entry.namespace === (subject.namespace ?? "") &&
        (entry.kind === subject.kind
          ? entry.name === subject.name
          : entry.name === family || family.startsWith(`${entry.name}-`))
    )
    .slice(-MAX_CHANGES)
    .reverse();
  const watched = entries.some((entry) => entry.context === context);
  const out: (ReportChange & { key: string })[] = [];
  for (const entry of mine) {
    const at = new Date(entry.at).toISOString();
    const key = `${at}/${entry.kind}/${entry.name}`;
    const parts = [
      {
        text: journalWords(entry, t, valuesOf(entry)),
        quiet: entry.field === "generation",
      },
      ...(entry.atRelist
        ? [{ text: t("changes", "journalSeenAtRelist"), quiet: true }]
        : []),
    ];
    const last = out.at(-1);
    if (last && last.key === key) last.parts.push(...parts);
    else out.push({ key, at, ref: refOf(entry), parts });
  }
  const changes: ReportChange[] =
    mine.length === 0 && !watched
      ? [
          {
            at: null,
            ref: null,
            parts: [{ text: t("share", "journalEmpty"), quiet: true }],
          },
        ]
      : out.map(({ at, ref, parts }) => ({
          at,
          ref,
          parts: [...parts].sort((a, b) => Number(a.quiet) - Number(b.quiet)),
        }));
  return {
    id: "changes",
    order: ORDER.changes,
    title: t("share", "sectionChanges"),
    icon: iconSvg(History),
    count: changes.filter((change) => change.at !== null).length,
    body: { type: "changes", changes },
  };
}

export function logsSectionShell(t: T): Omit<PlacedSection, "body"> {
  return {
    id: "logs",
    order: ORDER.logs,
    title: t("share", "sectionLogs"),
    icon: iconSvg(AlignLeft),
  };
}

/** A section id from a title in any script; never empty. */
export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Sorted by where each belongs; the order a page contributed them in breaks
 * ties. Ids are made unique, since sections registered apart can share one.
 */
export function placed(sections: PlacedSection[]): ReportSection[] {
  const seen = new Map<string, number>();
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => {
      const n = (seen.get(section.id) ?? 0) + 1;
      seen.set(section.id, n);
      return n === 1 ? section : { ...section, id: `${section.id}-${n}` };
    });
}
