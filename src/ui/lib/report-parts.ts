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
import {
  gapsOf,
  gapWords,
  spansCovering,
  hasChangesTab,
  journalWords,
  type Gap,
  type JournalEntry,
  type ObservedSpan,
} from "./changes";
import { conditionRole } from "./condition-health";
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

/** The kinds whose page draws how traffic reaches them; for the rest there is no such path. */
export const TRAFFIC_KINDS = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Service",
  "Ingress",
]);

/**
 * Every section that could not be read, as one line of the file's "Not read"
 * each: the section says it in place, and the summary has to agree with it.
 * Sections that failed for the same reason share a line.
 */
export function unreadLines(sections: readonly PlacedSection[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const section of sections) {
    const reason = section.unread ?? section.partial;
    if (!reason) continue;
    const titles = byReason.get(reason) ?? [];
    titles.push(section.title);
    byReason.set(reason, titles);
  }
  return [...byReason].map(
    ([reason, titles]) => `${titles.join(", ")}: ${reason}`
  );
}

/** As many journal entries as a reader scrolls; older ones are in the app. */
const MAX_CHANGES = 20;
/** How far back the Changes tab looks, and so how far back a gap is worth naming. */
const JOURNAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
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
    noSecretsLogs: t("share", "noSecretsLogs"),
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
 * A day and a time for a line of text, in UTC like every other time in the
 * file: the reader is not in the sender's zone. Digits only, so a sentence
 * in the reader's language carries no month name in the sender's.
 */
export function utcMoment(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A stretch nobody watched, as a row of its own rather than a silence. */
export function gapChange(gap: Gap, t: T): ReportChange {
  return {
    at: new Date(gap.to).toISOString(),
    ref: null,
    parts: [{ text: gapWords(gap, t, utcMoment), quiet: false }],
  };
}

/** A ReplicaSet is named for its Deployment plus the template hash. */
const TEMPLATE_HASH = /^(.+)-[bcdfghjklmnpqrstvwxz2456789]{5,10}$/;

/**
 * The watched workloads a change to would be a change to this object: the
 * object itself when the journal watches its kind, otherwise the owner its
 * `ownerReferences` name — through the ReplicaSet, for a Deployment's pod.
 * `null` when there is none, and then nothing about changes can be said.
 */
function watchedAs(
  subject: { kind: string; name: string },
  owners: readonly { kind: string; name: string }[]
): { kind: string; name: string }[] | null {
  if (hasChangesTab(subject.kind))
    return [{ kind: subject.kind, name: subject.name }];
  const out = owners.flatMap((owner) => {
    if (hasChangesTab(owner.kind)) return [owner];
    const deployment =
      owner.kind === "ReplicaSet" ? TEMPLATE_HASH.exec(owner.name)?.[1] : null;
    return deployment ? [{ kind: "Deployment", name: deployment }] : [];
  });
  return out.length > 0 ? out : null;
}

/**
 * What this app watched change on the object or on the workload that owns
 * it, one row per moment, with the stretches it was not watching as rows of
 * their own. `null` for an object no watched workload owns: the journal has
 * nothing to say about it, and an empty list would read as "nothing changed".
 */
export function changesSection(
  journal: {
    entries: readonly JournalEntry[];
    spans: readonly ObservedSpan[];
  },
  context: string,
  subject: {
    kind: string;
    name: string;
    namespace: string | null;
    owners: readonly { kind: string; name: string }[];
  },
  capturedAt: string,
  t: T
): PlacedSection | null {
  const targets = watchedAs(subject, subject.owners);
  if (!targets) return null;
  const spans = spansCovering(journal.spans, {
    kinds: targets.map((target) => target.kind),
    namespaces: subject.namespace ? [subject.namespace] : [],
  });
  const all = journal.entries.filter(
    (entry) =>
      entry.context === context &&
      entry.namespace === (subject.namespace ?? "") &&
      targets.some(
        (target) => target.kind === entry.kind && target.name === entry.name
      )
  );
  const mine = all.slice(-MAX_CHANGES);
  const watched =
    spans.length > 0 ||
    journal.entries.some((entry) => entry.context === context);
  const out: (ReportChange & { key: string; ms: number })[] = [];
  for (const entry of [...mine].reverse()) {
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
    else out.push({ key, ms: entry.at, at, ref: refOf(entry), parts });
  }
  const now = Date.parse(capturedAt);
  // As far back as the journal keeps, or as the oldest row shown.
  const from = Math.min(now - JOURNAL_WINDOW_MS, ...out.map((row) => row.ms));
  const gaps = watched ? gapsOf(spans, from, now) : [];
  const rows: (ReportChange & { ms: number })[] = [
    ...out.map(({ ms, at, ref, parts }) => ({
      ms,
      at,
      ref,
      parts: [...parts].sort((a, b) => Number(a.quiet) - Number(b.quiet)),
    })),
    ...gaps.map((gap) => ({ ms: gap.to, ...gapChange(gap, t) })),
  ].sort((a, b) => b.ms - a.ms);
  const changes: ReportChange[] = !watched
    ? [
        {
          at: null,
          ref: null,
          parts: [{ text: t("share", "journalEmpty"), quiet: true }],
        },
      ]
    : rows.map(({ at, ref, parts }) => ({ at, ref, parts }));
  return {
    id: "changes",
    order: ORDER.changes,
    title: t("share", "sectionChanges"),
    icon: iconSvg(History),
    // Changes, as the Changes tab counts them; a row holds every change of one moment.
    count: all.length,
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
