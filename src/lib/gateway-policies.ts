/**
 * The reverse lookup GEP-713 leaves to the viewer: policies name their
 * targets, the targets never name them back — so "what affects this
 * backend" is answered by scanning the policies, exactly the way gwctl's
 * effective-policy view does. No dashboard renders this yet; the GEP
 * itself names discoverability as the unsolved part.
 */

import type { BackendTlsPolicyInfo } from "@/generated/types";

/** Direct policies cannot cross namespaces, so the match never does. */
export function policiesOnService(
  policies: BackendTlsPolicyInfo[],
  service: { name: string; namespace: string }
): BackendTlsPolicyInfo[] {
  return policies.filter(
    (policy) =>
      policy.namespace === service.namespace &&
      policy.targetRefs.some(
        (target) => target.kind === "Service" && target.name === service.name
      )
  );
}

/**
 * One word for a policy's standing, from `PolicyStatus.Ancestors` — a
 * verdict is always scoped to (ancestor, controller) pairs, so "accepted"
 * here means every pair that answered said so.
 */
export function policyVerdict(policy: BackendTlsPolicyInfo): {
  word: string;
  tone: "ok" | "warn" | "err";
} {
  if (policy.ancestors.length === 0) {
    return { word: "no controller answered", tone: "warn" };
  }
  const verdicts = policy.ancestors.flatMap((entry) =>
    entry.conditions.filter((c) => c.type === "Accepted")
  );
  const refused = verdicts.find((c) => c.status === "False");
  if (refused) {
    return { word: refused.reason ?? "refused", tone: "err" };
  }
  // MaxItems=16 is the API's hard ceiling: a full list must be surfaced
  // as possible truncation, never read as the whole story.
  if (policy.ancestorsMaybeTruncated) {
    return {
      word: "accepted — the ancestor list may be truncated",
      tone: "warn",
    };
  }
  if (verdicts.every((c) => c.status === "True") && verdicts.length > 0) {
    return { word: "accepted", tone: "ok" };
  }
  return { word: "unknown", tone: "warn" };
}
