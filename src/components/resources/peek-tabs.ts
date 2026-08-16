import { AlignLeft, Braces, Info, Link2, Table2 } from "lucide-react";

import { podContainers } from "@/lib/container-sequence";
import { ResourceType, toKind } from "@/lib/resource-registry";
import {
  countMark,
  kindGlyph,
  viewGlyph,
  type DetailTabGlyph,
  type DetailTabMark,
} from "./detail-tab";
import type { ConfigMapInfo, PodInfo, SecretInfo } from "@/generated/types";

/**
 * Which work surfaces a peeked object actually has.
 *
 * One fixed tab strip across every kind would lie: a ConfigMap has no logs
 * and a Service has no containers, and a tab that opens onto "nothing here"
 * is worse than no tab. The middle of the strip is therefore per kind; only
 * Overview and YAML are universal, because every kind answers both.
 *
 * Events deliberately stay inside Overview rather than becoming a tab. They
 * are the answer to "why is this red", which is the question a peek is opened
 * to ask — putting them one click away hides the thing being looked for.
 *
 * The glyphs are `detail-tab.ts`'s two rules, applied here exactly as the
 * detail pages apply them: a tab that names a kind takes that kind's glyph
 * and hue, a tab that names a view takes a functional one and no hue. The
 * strip keeps its pill shape — it is not the page's underline strip and is
 * not trying to be — because what a tab *is* does not depend on the shape
 * drawn around it.
 */
export type PeekTabId =
  | "overview"
  | "logs"
  | "containers"
  | "data"
  | "children"
  | "connections"
  | "yaml";

export interface PeekTabDefinition {
  id: PeekTabId;
  label: string;
  glyph: DetailTabGlyph;
  /**
   * A count, and only ever from something the panel is already holding. A
   * number that needed a list fetched to draw it would be a request per peek
   * for a badge, on a panel opened dozens of times an hour — so the child
   * tabs carry none. Severity is the header badge's job here, not a dot's.
   */
  mark?: Extract<DetailTabMark, { shows: "count" }>;
}

const OVERVIEW: PeekTabDefinition = {
  id: "overview",
  label: "Overview",
  glyph: viewGlyph(Info),
};
const YAML: PeekTabDefinition = {
  id: "yaml",
  label: "YAML",
  glyph: viewGlyph(Braces),
};

/** The kinds whose children are worth listing, and what those children are. */
const CHILDREN_LABEL = {
  Deployment: "Pods",
  StatefulSet: "Pods",
  DaemonSet: "Pods",
  Job: "Pods",
  // A CronJob owns Jobs, not Pods — its pods are two hops away and belong to
  // whichever run produced them. Listing the runs is the honest answer.
  CronJob: "Jobs",
} as const;

export function peekTabsFor(
  kind: string,
  /** What the Overview fetch returned, when it has returned. */
  detail?: unknown,
  /**
   * Set for a custom resource, which is the only kind that gets Connections
   * here.
   *
   * Not because a Pod's connections are uninteresting in a peek — they are —
   * but because a Pod has a Connections tab on its own page already, and a
   * custom resource had one nowhere at all. Widening this to every kind is a
   * separate decision about how much a peek should hold, and making it by
   * accident while closing a gap would be the wrong way to take it.
   */
  crd?: string
): PeekTabDefinition[] {
  const resolved = toKind(kind);
  const middle: PeekTabDefinition[] = [];

  if (crd) {
    return [
      OVERVIEW,
      { id: "connections", label: "Connections", glyph: viewGlyph(Link2) },
      YAML,
    ];
  }

  if (resolved === "Pod") {
    const pod = detail as PodInfo | undefined;
    middle.push(
      { id: "logs", label: "Logs", glyph: viewGlyph(AlignLeft) },
      {
        id: "containers",
        label: "Containers",
        // A container has no kind of its own; it is what a Pod is made of,
        // so it arrives under the Pod's cube and the Pod's hue.
        glyph: kindGlyph(ResourceType.Pod),
        mark: pod ? countMark(podContainers(pod).length) : undefined,
      }
    );
  } else if (resolved === "ConfigMap" || resolved === "Secret") {
    const keyed = detail as ConfigMapInfo | SecretInfo | undefined;
    middle.push({
      id: "data",
      label: "Data",
      glyph: viewGlyph(Table2),
      mark: keyed ? countMark(keyed.dataKeys.length) : undefined,
    });
  } else if (resolved && resolved in CHILDREN_LABEL) {
    const label = CHILDREN_LABEL[resolved as keyof typeof CHILDREN_LABEL];
    middle.push({
      id: "children",
      label,
      glyph: kindGlyph(label === "Jobs" ? ResourceType.Job : ResourceType.Pod),
    });
  }

  return [OVERVIEW, ...middle, YAML];
}

/**
 * The tab to show for a target, given the one the reader last asked for.
 *
 * Staying on Logs while clicking down a list of pods is the whole point of a
 * peek, so the request survives a change of target. It is only a request: a
 * kind that has no such tab falls back to Overview without forgetting it, so
 * the next pod opens on Logs again.
 */
export function resolvePeekTab(
  requested: PeekTabId,
  tabs: PeekTabDefinition[]
): PeekTabId {
  return tabs.some((tab) => tab.id === requested) ? requested : "overview";
}
