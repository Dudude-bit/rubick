import {
  AlignLeft,
  BadgeCheck,
  EyeOff,
  ExternalLink,
  History,
  Lock,
  ShieldCheck,
  Zap,
  Bell,
  type LucideIcon,
} from "lucide-react";

import type {
  ConditionInfo,
  EventInfo,
  FieldMove,
  Identity,
  LetGoes,
  SeqStretch,
  SpanSets,
  TimelineRow,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import {
  coverageOf,
  gapsOf,
  gapWords,
  isChange,
  letGoWords,
  placedBy,
  REVISED_KINDS,
  rowWords,
  type Gap,
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
import type { ResourceKind } from "./resource-registry";
import { identHue, kindHue, kindMark, splitName } from "./resource-identity";
import { involvedNamespace, namedOf } from "./event-incarnation";
import { drawnCrd } from "./links";
import { ROLE_ICON, statusRole } from "./status-role";

/**
 * A section with where it sits: the page's own first, the evidence after,
 * the logs last, and what it names as not read, for the file's "Not read".
 */
export type PlacedSection = ReportSection & {
  order: number;
  notRead?: string[];
};

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
  return [
    ...[...byReason].map(
      ([reason, titles]) => `${titles.join(", ")}: ${reason}`
    ),
    ...sections.flatMap((section) => section.notRead ?? []),
  ];
}

/**
 * How a ladder's filter box and group chip narrowed its rows, for the
 * caption of the section that carries only those rows; `null` for every row.
 */
export function narrowedWords(
  t: T,
  filter: string,
  group: string | null
): string | null {
  const query = filter.trim();
  return (
    [
      group ? t("share", "onlyGroup", { group }) : null,
      query ? t("share", "tableSearched", { query }) : null,
    ]
      .filter(Boolean)
      .join(" ") || null
  );
}

/** As many journal entries as a reader scrolls; older ones are in the app. */
const MAX_CHANGES = 20;
/** How far back the Changes tab looks, and so how far back a gap is worth naming. */
const JOURNAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Enough events to see a pattern; the Events screen has the rest. */
const MAX_EVENTS = 25;

export function kindIcon(kind: ResourceKind): LucideIcon;
/** A kind read from the cluster says the segment it is served at, known or not. */
export function kindIcon(
  kind: string,
  crd: string | null | undefined
): LucideIcon;
export function kindIcon(kind: string, crd?: string | null): LucideIcon {
  return kindMark({ kind, crd }).Icon;
}

/** The object the way `ResourceName` draws it, so the file and the app agree on its glyph and colours. */
export function refOf(object: {
  kind: string;
  name: string;
  namespace: string | null;
  crd?: string | null;
}): ReportRef {
  const { stem, tail } = splitName(object.name);
  return {
    kind: object.kind,
    namespace: object.namespace,
    stem,
    tail,
    icon: iconSvg(kindIcon(object.kind, object.crd)),
    kindHue: kindHue(object.kind, object.crd),
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
    refused: iconSvg(Lock),
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
        role: conditionRole(condition, conditions),
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
  withObject: boolean | ((event: EventInfo) => boolean) = false,
  title = "Events"
): PlacedSection {
  const sorted = [...(events ?? [])].sort(
    (a, b) =>
      Number(b.type === "Warning") - Number(a.type === "Warning") ||
      (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? "")
  );
  return {
    id: "events",
    order: ORDER.events,
    title,
    icon: iconSvg(Bell),
    count: sorted.length,
    unread,
    body: {
      type: "events",
      rows: sorted.slice(0, MAX_EVENTS).map((event) => ({
        at: event.lastTimestamp ?? event.firstTimestamp,
        first:
          (event.count ?? 1) > 1 &&
          event.firstTimestamp &&
          event.firstTimestamp !== event.lastTimestamp
            ? event.firstTimestamp
            : null,
        role: event.type === "Warning" ? "warn" : statusRole(event.type),
        reason: event.reason ?? event.type,
        message: event.message ?? "",
        count: event.count ?? 1,
        ref: (typeof withObject === "function" ? withObject(event) : withObject)
          ? refOf({
              kind: event.involvedObject.kind,
              name: event.involvedObject.name,
              namespace: involvedNamespace(event),
              crd: drawnCrd(namedOf(event)),
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
function markedValue(value: string | null, field: FieldMove): string {
  const image =
    field.says === "moved" && field.path.endsWith(".image")
      ? [field.from, field.to].map((side) =>
          side ? parseImageRef(side) : null
        )
      : null;
  const sameRepository =
    image !== null &&
    image[0] !== null &&
    image[1] !== null &&
    image[0].registry === image[1].registry &&
    image[0].repository === image[1].repository;
  const parsed = sameRepository && value ? parseImageRef(value) : null;
  const shown =
    value === null
      ? "∅"
      : (parsed?.tag ?? parsed?.digest?.slice(0, 19) ?? value);
  return `${VALUE_OPEN}${shown}${VALUE_CLOSE}`;
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

/** An object as the timeline is asked about it. */
export interface TimelineTarget {
  kind: string;
  name: string;
  namespace: string | null;
}

/** A ReplicaSet is named for its Deployment plus the template hash. */
const TEMPLATE_HASH = /^(.+)-[bcdfghjklmnpqrstvwxz2456789]{5,10}$/;

/**
 * Whose changes are this object's: the object itself, and the workload that
 * owns it — through the ReplicaSet, for a Deployment's pod — since a pod's
 * story is mostly its owner's rollouts. A custom kind is left to its owner:
 * a namesake of a built-in is not the object the timeline recorded.
 */
export function changesTargets(
  subject: {
    kind: ResourceKind | null;
    name: string;
    namespace: string | null;
  },
  owners: readonly { kind: string; name: string }[]
): TimelineTarget[] {
  const out: TimelineTarget[] = subject.kind
    ? [{ kind: subject.kind, name: subject.name, namespace: subject.namespace }]
    : [];
  for (const owner of owners) {
    const deployment =
      owner.kind === "ReplicaSet" ? TEMPLATE_HASH.exec(owner.name)?.[1] : null;
    if ((REVISED_KINDS as readonly string[]).includes(owner.kind))
      out.push({ ...owner, namespace: subject.namespace });
    else if (deployment)
      out.push({
        kind: "Deployment",
        name: deployment,
        namespace: subject.namespace,
      });
  }
  return out;
}

/**
 * What this app recorded change on the object and on the workload that owns
 * it, one row per moment, with the stretches it was not watching and the
 * rows it let go as rows of their own. `null` for an object nothing is asked
 * of: an empty list would read as "nothing changed".
 */
/** Whether the rows held are this cluster's, in words where that is not known; a new answer does not compile until it is said. */
export function identityLine(identity: Identity, t: T): string | null {
  switch (identity.says) {
    case "known":
    case "notChecked":
      return null;
    case "unknown":
      return t("changes", "identityUnknown", { reason: identity.message });
    case "unsettled":
      return t("changes", "identityUnsettled");
  }
}

/** What a row no read placed says beside it, as the screen does. */
export const unplacedPart = (unplaced: boolean, t: T) =>
  unplaced ? [{ text: t("changes", "journalUnplaced"), quiet: false }] : [];

export function changesSection(
  read: {
    rows: readonly TimelineRow[];
    /** Which rows a read placed; see `placedBy`. */
    vouched: readonly SeqStretch[] | undefined;
    /** Whether the name was checked, as the Changes page says it. */
    identity: Identity | undefined;
    spans: SpanSets | undefined;
    letGo: LetGoes | undefined;
    /** Older rows than this were not read; `null` where every one was. */
    readFrom?: number | null;
    /** Why nothing could be read, where the timeline did not answer. */
    unread?: string | null;
  },
  targets: readonly TimelineTarget[],
  capturedAt: string,
  t: T
): PlacedSection | null {
  if (targets.length === 0) return null;
  const shell = {
    id: "changes",
    order: ORDER.changes,
    title: t("share", "sectionChanges"),
    icon: iconSvg(History),
  };
  // A read that failed or never answered is not a history with no change.
  // Beside rows another read gave, it is what the section lacks.
  if (read.unread && read.rows.length === 0)
    return {
      ...shell,
      unread: read.unread,
      body: { type: "changes", changes: [] },
    };
  const readFrom = read.readFrom ?? null;
  const namespaces = targets[0].namespace ? [targets[0].namespace] : [];
  // Each kind on the source that reads it, as the object's Changes tab does.
  const { covering: spans, watching } = coverageOf(
    read.spans,
    targets.map((target) => target.kind),
    namespaces,
    "changes"
  );
  const all = read.rows
    .filter(isChange)
    .filter((row) =>
      targets.some(
        (target) =>
          target.kind === row.kind &&
          target.name === row.name &&
          target.namespace === row.namespace
      )
    );
  const mine = all.slice(0, MAX_CHANGES);
  const watched = spans.length > 0 || all.length > 0;
  const out: (ReportChange & { key: string; ms: number })[] = [];
  for (const row of mine) {
    const at = new Date(row.at).toISOString();
    const key = `${at}/${row.kind}/${row.name}`;
    const parts = [
      {
        text: rowWords(row, t, markedValue),
        quiet: row.what.says === "generation",
      },
      ...(row.atRelist
        ? [{ text: t("changes", "journalSeenAtRelist"), quiet: true }]
        : []),
      ...unplacedPart(!placedBy(row, read.vouched), t),
    ];
    const last = out.at(-1);
    if (last && last.key === key) last.parts.push(...parts);
    else out.push({ key, ms: row.at, at, ref: refOf(row), parts });
  }
  const now = Date.parse(capturedAt);
  // As far back as the timeline keeps, or as the oldest row shown; never
  // below the rows read, where nothing is known either way.
  const from = Math.max(
    Math.min(now - JOURNAL_WINDOW_MS, ...out.map((row) => row.ms)),
    readFrom ?? Number.NEGATIVE_INFINITY
  );
  // The object's own read gave no spans: what was watched is not known,
  // so neither a gap nor an empty journal is.
  const known = read.spans !== undefined;
  const gaps =
    watched && known ? gapsOf(spans, from, now, watching, namespaces) : [];
  const letGo = read.letGo?.changes;
  const rows: (ReportChange & { ms: number })[] = [
    ...out.map(({ ms, at, ref, parts }) => ({
      ms,
      at,
      ref,
      parts: [...parts].sort((a, b) => Number(a.quiet) - Number(b.quiet)),
    })),
    ...gaps.map((gap) => ({ ms: gap.to, ...gapChange(gap, t) })),
    ...(letGo && letGo.before >= from
      ? [
          {
            ms: letGo.before,
            at: null,
            ref: null,
            parts: [
              {
                text: letGoWords({ letGo, of: "changes" }, t, utcMoment),
                quiet: false,
              },
            ],
          },
        ]
      : []),
  ].sort((a, b) => b.ms - a.ms);
  const said = rows.map(({ at, ref, parts }) => ({ at, ref, parts }));
  // Not watched, the let-go line is still what is known of the history.
  const changes: ReportChange[] =
    watched || !known
      ? said
      : [
          ...said,
          {
            at: null,
            ref: null,
            parts: [{ text: t("share", "journalEmpty"), quiet: true }],
          },
        ];
  return {
    ...shell,
    // Changes, as the Changes tab counts them; a row holds every change of one moment.
    count: all.length,
    partial:
      [
        read.identity && identityLine(read.identity, t),
        read.unread,
        readFrom === null
          ? null
          : t("changes", "olderNotRead", { at: utcMoment(readFrom) }),
      ]
        .filter(Boolean)
        .join(" ") || null,
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
