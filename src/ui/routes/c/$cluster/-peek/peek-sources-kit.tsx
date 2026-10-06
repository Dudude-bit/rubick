import type { ReactNode } from "react";

import { ResourceRef } from "@/components/object/ResourceRef";
import type { T as Translate } from "@/i18n/useT";
import { conditionRole } from "@/lib/condition-health";
import type { StatusRole } from "@/lib/status-role";
import type { PeekTarget } from "@/hooks/usePeek";
import type { KeyValue, KeyValueTone } from "@/components/object/key-values";
import type { ConditionInfo } from "@/generated/types";
import type { ResourceKind } from "@/lib/resource-registry";
import { OwnerRef, type Owner } from "./OwnerRef";
import { None } from "@/components/ui/none";

/** A cell is a list of words; `none` is said, faint, when there are none. */
export interface WordCell {
  words: string[];
  none?: string;
  /** Words that grant more than they say, drawn as a warning. */
  escalating?: string[];
}

export interface WordTable {
  columns: string[];
  rows: WordCell[][];
}

export interface PeekGroup {
  title: string;
  count?: ReactNode;
  items: KeyValue[];
  /** Drawn in place of `items` where the rows are records, not pairs. */
  table?: WordTable;
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
  /** The diagnosis the page heads its Overview with, above the groups. */
  lead?: ReactNode;
}

/** What discovery says about the kind, where the catalogue has answered. */
export interface KindFacts {
  hasStatus?: boolean;
}

export interface PeekSource {
  fetch: (name: string, namespace: string | null) => Promise<unknown>;
  summarise: (
    data: unknown,
    target: PeekTarget,
    t: Translate,
    kind?: KindFacts
  ) => PeekSummary;
}

export type PeekSources = Partial<Record<ResourceKind, PeekSource>>;

export function source<T>(
  fetch: (name: string, namespace: string | null) => Promise<T>,
  summarise: (
    data: T,
    target: PeekTarget,
    t: Translate,
    kind?: KindFacts
  ) => PeekSummary
): PeekSource {
  return {
    fetch,
    summarise: (data, target, t, kind) => summarise(data as T, target, t, kind),
  };
}

/** A condition, in the reason-first wording every condition row speaks. */
export function conditionItem(condition: ConditionInfo): KeyValue {
  const role = conditionRole(condition);
  const spoken =
    condition.reason && condition.reason !== condition.type
      ? `${condition.status} (${condition.reason})`
      : condition.status;
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

export const ref = (
  kind: string,
  name: string,
  namespace?: string | null,
  options: { crd?: string | null; showNamespace?: boolean } = {}
) => (
  <ResourceRef
    kind={kind}
    name={name}
    namespace={namespace}
    showKind={false}
    // Bounded by the row it sits in, so a long name ends in an ellipsis at
    // the panel's edge instead of being cut there.
    className="max-w-full"
    {...options}
  />
);

export function controlledBy(
  owners: ReadonlyArray<Owner> | undefined,
  namespace: string | null,
  t: Translate
): PeekGroup[] {
  if (!owners?.length) return [];
  return [
    {
      title: t("columns", "controlledBy"),
      items: owners.map((owner) => ({
        label: owner.kind,
        value: <OwnerRef owner={owner} namespace={namespace} />,
      })),
    },
  ];
}

export const list = (values: string[], empty: ReactNode = <None />) =>
  values.length ? values.join(" · ") : empty;
