/**
 * The drain confirmation, and the one thing it is worth reading first.
 *
 * A drain is where a PodDisruptionBudget stops being a number on a workload
 * page and becomes the reason a command sits there. This dialog says which
 * budget, before the click, so that a drain which does not finish is legible
 * without going and finding the budget by hand.
 *
 * **It does not block, it tells.** Draining into a spent budget is a
 * legitimate thing to do; the eviction is simply refused for now, and a tool
 * that refuses to let you try gets worked around.
 *
 * What it must never do is *promise* one thing and do another. An earlier
 * version said here that the drain would wait for the budget, while the
 * backend answered every refused eviction with a direct `DELETE` — the one
 * call that does not consult a budget at all. The words were the honest half
 * and the code was not. Both now say the same thing: what can move, moves;
 * what cannot, stays and is named.
 *
 * The two opt-ins are the other half of the same honesty. They decide which
 * pods are in the set, never how they leave it, and both start off, because
 * each one ends something the cluster will not bring back.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DrainRefusal, DrainReport } from "@/generated/types";
import { useConnections } from "@/hooks/useConnections";
import { budgetRule, drainBlockers } from "@/lib/governance";
import { ResourceType } from "@/lib/resource-registry";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";

/** What the operator asked for, alongside the node. */
export type DrainChoices = {
  evictUnmanagedPods: boolean;
  evictPodsWithLocalData: boolean;
};

const REFUSAL_LABEL: Record<DrainRefusal, keyof typeof en.cluster> = {
  notNow: "refusalNotNow",
  nothingWouldReplaceIt: "refusalNothingWouldReplaceIt",
  holdsLocalData: "refusalHoldsLocalData",
  other: "refusalOther",
};

export function DrainDialog({
  node,
  report,
  onOpenChange,
  onConfirm,
  busy,
}: {
  /** The node to drain, or `null` for a closed dialog. */
  node: string | null;
  /** Set once a drain has run and left something behind. */
  report: DrainReport | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (node: string, choices: DrainChoices) => void;
  busy: boolean;
}) {
  const t = useT();

  return (
    <Dialog open={!!node} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("action", "drainNamed", { name: node ?? "" })}
          </DialogTitle>
        </DialogHeader>
        {report ? (
          <DrainOutcome
            report={report}
            t={t}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          // Keyed by node so each one starts from a clean pair of opt-ins.
          // Carrying the last node's answers over would be the dialog
          // answering a question this reader was never asked.
          <DrainConfirm
            key={node ?? ""}
            node={node}
            busy={busy}
            t={t}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Everything read and decided before the drain runs. */
function DrainConfirm({
  node,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  node: string | null;
  busy: boolean;
  t: T;
  onCancel: () => void;
  onConfirm: (node: string, choices: DrainChoices) => void;
}) {
  const [choices, setChoices] = useState<DrainChoices>({
    evictUnmanagedPods: false,
    evictPodsWithLocalData: false,
  });

  // Asked for only while the dialog is open: a node's neighbourhood is every
  // pod on it in every namespace, which is not a read to make from a list row.
  const query = useConnections(
    ResourceType.Node,
    node ?? undefined,
    null,
    !!node
  );
  const blockers = drainBlockers(query.data);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-fg-mut">{t("empty", "drainExplained")}</p>
        {query.isPending && node && (
          <p className="text-[11px] text-fg-fnt">
            {t("empty", "readingWhatRefusesToMove")}
          </p>
        )}
        {blockers.length > 0 && (
          <div className="flex flex-col gap-1 pt-1">
            <p className="text-xs font-medium text-warn">
              {t("count", "budgetsAllowNoEviction", { n: blockers.length })}
            </p>
            {blockers.map(({ budget, pods }) => (
              <p
                key={`${budget.object.namespace}/${budget.object.name}`}
                className="text-[11px] text-fg-fnt"
              >
                <span className="font-mono text-fg-mid">
                  {budget.object.namespace}/{budget.object.name}
                </span>{" "}
                —{" "}
                {t("empty", "budgetRuleHealthyCovering", {
                  rule: budgetRule(budget.facts, t),
                  healthy: budget.facts.currentHealthy,
                  expected: budget.facts.expectedPods,
                  pods: t("cluster", "podCount", { n: pods }),
                })}
              </p>
            ))}
          </div>
        )}
        <p className="pt-1 text-[11px] text-fg-fnt">
          {t("empty", "drainStopsAtRefusals")}
        </p>
        <div className="flex flex-col border-t border-hair pt-1.5">
          <OptIn
            checked={choices.evictUnmanagedPods}
            onChange={(next) =>
              setChoices((was) => ({ ...was, evictUnmanagedPods: next }))
            }
            label={t("action", "evictUnmanagedPods")}
            explained={t("empty", "evictUnmanagedPodsExplained")}
            disabled={busy}
          />
          <OptIn
            checked={choices.evictPodsWithLocalData}
            onChange={(next) =>
              setChoices((was) => ({ ...was, evictPodsWithLocalData: next }))
            }
            label={t("action", "evictPodsWithLocalData")}
            explained={t("empty", "evictPodsWithLocalDataExplained")}
            disabled={busy}
          />
        </div>
        {node && (
          <Link
            to={`/nodes/${node}`}
            className="pt-1 text-[11px] text-info hover:underline"
          >
            {t("action", "openTheNodeFirst")}
          </Link>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("action", "cancel")}
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => node && onConfirm(node, choices)}
        >
          {blockers.length > 0
            ? t("action", "drainAnyway")
            : t("action", "drain")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * What the drain actually did.
 *
 * Only reached when something stayed — a drain that emptied the node says so
 * in a toast and closes, because there is nothing here to read.
 */
function DrainOutcome({
  report,
  t,
  onClose,
}: {
  report: DrainReport;
  t: T;
  onClose: () => void;
}) {
  const anyNotNow = report.refused.some((pod) => pod.refusal === "notNow");

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-fg-mut">
          {t("count", "podsMovedOff", { n: report.evicted })}{" "}
          {t("count", "podsStayedOnTheNode", { n: report.refused.length })}
        </p>
        {/* The rest of what was on the node, so the counts add up to what
         *  was there rather than trailing off. */}
        {report.daemonsetPodsLeft > 0 && (
          <p className="text-[11px] text-fg-fnt">
            {t("count", "daemonsetPodsStay", { n: report.daemonsetPodsLeft })}
          </p>
        )}
        {report.alreadyGone > 0 && (
          <p className="text-[11px] text-fg-fnt">
            {t("count", "podsHadAlreadyLeft", { n: report.alreadyGone })}
          </p>
        )}
        <div className="flex flex-col gap-1 pt-1">
          {report.refused.map((pod) => (
            <p
              key={`${pod.namespace}/${pod.name}`}
              className="text-[11px] text-fg-fnt"
            >
              <span className="font-mono text-fg-mid">
                {pod.namespace}/{pod.name}
              </span>{" "}
              — {pod.message ?? t("cluster", REFUSAL_LABEL[pod.refusal])}
            </p>
          ))}
        </div>
        {anyNotNow && (
          <>
            <p className="pt-1 text-[11px] text-fg-fnt">
              {t("empty", "notNowExplained")}
            </p>
            <p className="text-[11px] text-fg-fnt">
              {t("empty", "podsStayedExplained")}
            </p>
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("action", "close")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One opt-in, with the consequence under it rather than in a tooltip. */
function OptIn({
  checked,
  onChange,
  label,
  explained,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  explained: string;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-fg-mid">{label}</span>
        <span className="text-[11px] text-fg-fnt">{explained}</span>
      </span>
    </label>
  );
}
