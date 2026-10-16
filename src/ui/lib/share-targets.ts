/**
 * Where a report may go, and how a surface tells one target from another.
 *
 * A colour per host, from the same ring the cluster identity uses, so two
 * servers never look alike by accident — and the reserved red, which the
 * hash never assigns, for a target anyone with the link can read.
 */

import { DANGER_CLUSTER_COLOR, hashedColor } from "@/lib/cluster-identity";
import type { ShareTargetInfo } from "@/generated/types";

export function targetColor(target: { host: string; public: boolean }): string {
  // Public is the one colour a hash must never land on, exactly as a
  // production cluster's is: it means "anyone with the link", not "this one".
  // The ring alone, not `clusterColor`: its production rule would hand the
  // reserved red to a private target hosted on anything called "prod".
  return target.public ? DANGER_CLUSTER_COLOR : hashedColor(target.host);
}

/** What a target must have before anything can be sent to it. */
export function readyToPublish(target: ShareTargetInfo): boolean {
  return target.hasKey;
}

/**
 * A public target needs the sentence acknowledged every time, not once in
 * settings: the report being sent now is a different report from the last
 * one, and it is the only moment the reader can weigh what is in it.
 */
export function needsAcknowledgement(target: ShareTargetInfo): boolean {
  return target.public;
}

/**
 * The key the draft is remembered against: one link per object per cluster
 * per target, so a second share of the same object updates its link and a
 * share from another cluster never replaces it. A screen is not one object
 * with versions: its key is the route it was taken on, filters and all.
 */
export function objectKey(report: {
  subject: {
    kind: string;
    namespace: string | null;
    name: string;
    context: string;
  };
  hero: { ref: unknown };
  link: string;
}): string {
  const { subject } = report;
  if (report.hero.ref !== null)
    return `${subject.context}/${subject.kind}/${subject.namespace ?? ""}/${subject.name}`;
  const route = report.link
    .replace(/([?&])t=[^&]*&?/, "$1")
    .replace(/[?&]$/, "");
  return `${subject.context}/screen/${subject.namespace ?? ""}/${route}`;
}

/**
 * The address a target answered with, if it is one a browser should be sent
 * to. The target is somebody else's server: a `file:`, `javascript:` or an
 * app's own scheme in that field is not a report link, whatever it claims.
 * The host is not held to the target's — a generic target may serve its
 * reports from another one — and the full address is on screen before a click.
 */
export function reportLink(url: string | null): string | null {
  if (!url || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : null;
}
