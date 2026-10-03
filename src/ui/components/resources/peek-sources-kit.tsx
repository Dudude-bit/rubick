import type { ReactNode } from "react";

import { ResourceRef } from "./ResourceRef";
import type { T as Translate } from "@/i18n/useT";
import { conditionRole } from "@/lib/condition-health";
import type { StatusRole } from "@/lib/status-role";
import type { PeekTarget } from "@/hooks/usePeek";
import type { KeyValue, KeyValueTone } from "./key-values";
import type { ConditionInfo } from "@/generated/types";
import type { ResourceKind } from "@/lib/resource-registry";

export interface PeekGroup {
  title: string;
  count?: ReactNode;
  items: KeyValue[];
  emptyMessage?: string;
}

export interface PeekSummary {
  /** Drives the header badge; leave unset where the API reports no state. */
  status?: string | null;
  /**
   * The node whose kubelet wrote that status, where one did.
   *
   * The panel looks up whether that node is still reporting and drops the
   * badge to neutral when it is not — the same thing the list and the detail
   * page have always done. Carried as a name rather than as a verdict
   * because the lookup needs a hook, and this function has none: without it
   * the peek was the one surface painting a pod on an unreachable node
   * confident green.
   */
  statusFrom?: string | null;
  createdAt?: string | null;
  /** For the kinds whose API hands back a rendered age instead of a stamp. */
  groups: PeekGroup[];
}

export interface PeekSource {
  fetch: (name: string, namespace: string | null) => Promise<unknown>;
  summarise: (data: unknown, target: PeekTarget, t: Translate) => PeekSummary;
}

export type PeekSources = Partial<Record<ResourceKind, PeekSource>>;

export function source<T>(
  fetch: (name: string, namespace: string | null) => Promise<T>,
  summarise: (data: T, target: PeekTarget, t: Translate) => PeekSummary
): PeekSource {
  return {
    fetch,
    summarise: (data, target, t) => summarise(data as T, target, t),
  };
}

/** A condition, in the reason-first wording every condition row speaks. */
export function conditionItem(condition: ConditionInfo): KeyValue {
  const role = conditionRole(condition);
  const spoken = [
    condition.status,
    condition.reason && condition.reason !== condition.type
      ? condition.reason
      : null,
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    label: condition.type,
    value:
      role !== "ok" && condition.message
        ? `${spoken}: ${condition.message}`
        : spoken,
    mono: true,
    tone: ROLE_TONE[role],
  };
}

/** The five roles, folded to the tones a key-value row can carry —
 *  `neutral` deliberately stays uncoloured, and `pending` reads as info. */
const ROLE_TONE: Partial<Record<StatusRole, KeyValueTone>> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  pending: "info",
};

export const ref = (kind: string, name: string, namespace?: string | null) => (
  <ResourceRef kind={kind} name={name} namespace={namespace} showKind={false} />
);

/**
 * Typed by what it reads rather than by either owner-reference shape: the
 * generated `OwnerReference` spells its fields with underscores and
 * `OwnerReferenceInfo` spells them in camel case, and this needs neither of
 * the two fields they disagree about.
 */
export function controlledBy(
  owners: ReadonlyArray<{ kind: string; name: string }> | undefined,
  namespace: string | null,
  t: Translate
): PeekGroup[] {
  if (!owners?.length) return [];
  return [
    {
      title: t("columns", "controlledBy"),
      items: owners.map((owner) => ({
        label: owner.kind,
        value: ref(owner.kind, owner.name, namespace),
      })),
    },
  ];
}

export const list = (values: string[], empty = "—") =>
  values.length ? values.join(" · ") : empty;
