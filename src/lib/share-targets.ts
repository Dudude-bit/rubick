/**
 * Where a report may go, and how a surface tells one target from another.
 *
 * A colour per host, from the same ring the cluster identity uses, so two
 * servers never look alike by accident — and the reserved red, which the
 * hash never assigns, for a target anyone with the link can read.
 */

import { clusterColor, DANGER_CLUSTER_COLOR } from "@/lib/cluster-identity";
import type { ShareTargetInfo } from "@/generated/types";

export function targetColor(target: { host: string; public: boolean }): string {
  // Public is the one colour a hash must never land on, exactly as a
  // production cluster's is: it means "anyone with the link", not "this one".
  return target.public ? DANGER_CLUSTER_COLOR : clusterColor(target.host);
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

/** The key the draft is remembered against: one link per object per target. */
export function objectKey(subject: {
  kind: string;
  namespace: string | null;
  name: string;
}): string {
  return `${subject.kind}/${subject.namespace ?? ""}/${subject.name}`;
}
