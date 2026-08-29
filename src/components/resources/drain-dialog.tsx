/**
 * The drain, from the click to the last pod, in one dialog.
 *
 * A drain is where a PodDisruptionBudget stops being a number on a workload
 * page and becomes the reason a command sits there. So this says which
 * budget before the click, and then stays open and says what is happening —
 * because the interesting part of a drain is the waiting, and a spinner
 * cannot tell "still going" from "stuck".
 *
 * **It does not block, it tells.** Draining into a spent budget is a
 * legitimate thing to do; the eviction is refused for now and asked again,
 * and a tool that refuses to let you try gets worked around.
 *
 * What it must never do is promise one thing and do another. An earlier
 * version said here that the drain would wait, while the backend answered
 * every refused eviction with a direct `DELETE` — the one call that does not
 * consult a budget at all. The words were the honest half and the code was
 * not. Now the waiting is real, so the sentence is true.
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
import type { DrainOptions } from "@/generated/types";
import type {
  DrainOutcome,
  DrainReport,
  DrainRefusal,
  DrainState,
  RefusedPod,
} from "@/hooks/useNodeDrain";
import { useConnections } from "@/hooks/useConnections";
import { budgetRule, drainBlockers } from "@/lib/governance";
import { ResourceType } from "@/lib/resource-registry";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";

/** What the operator ticked, alongside the node. */
export type DrainChoices = Omit<DrainOptions, "ignoreDaemonsets">;

const REFUSAL_LABEL: Record<DrainRefusal, keyof typeof en.cluster> = {
  notNow: "refusalNotNow",
  nothingWouldReplaceIt: "refusalNothingWouldReplaceIt",
  holdsLocalData: "refusalHoldsLocalData",
  other: "refusalOther",
};

/**
 * Total over the four outcomes, with no fallback on purpose.
 *
 * `drained` normally never reaches this view — the list closes the dialog and
 * says so in a toast, because an emptied node has nothing left to read. It is
 * still named here: a partial map needs a default, and a default is how a new
 * outcome ends up silently wearing an old one's label.
 *
 * `failed` here is not the same as the `failed` phase. That one is the
 * command being refused before any drain existed; this one is a drain that
 * was running and broke — so it arrives with a report of what it had already
 * moved, and the phase does not.
 */
const OUTCOME_LABEL: Record<DrainOutcome, keyof typeof en.action> = {
  drained: "nodeIsDrained",
  stopped: "drainStopped",
  cancelled: "drainCancelled",
  failed: "drainFailed",
};

/** Split for the two lists: one is waiting, the other is not going to move. */
const waiting = (pods: RefusedPod[]) =>
  pods.filter((pod) => pod.refusal === "notNow");
const staying = (pods: RefusedPod[]) =>
  pods.filter((pod) => pod.refusal !== "notNow");

export function DrainDialog({
  node,
  state,
  onOpenChange,
  onConfirm,
  onCancelDrain,
}: {
  /** The node to drain, or `null` for a closed dialog. */
  node: string | null;
  state: DrainState;
  onOpenChange: (open: boolean) => void;
  onConfirm: (node: string, choices: DrainChoices) => void;
  onCancelDrain: () => void;
}) {
  const t = useT();
  const busy = state.phase === "starting" || state.phase === "running";

  return (
    <Dialog
      open={!!node}
      onOpenChange={(open) => {
        // A running drain is not dismissed by a stray click. It is a cluster
        // operation with a Stop button; closing it by accident would leave
        // the reader with no way back to what they started.
        if (busy && !open) return;
        onOpenChange(open);
      }}
    >
      <DialogContent
        onInteractOutside={(event) => busy && event.preventDefault()}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t("action", "drainNamed", { name: node ?? "" })}
          </DialogTitle>
        </DialogHeader>
        {state.phase === "idle" ? (
          // Keyed by node so each one starts from a clean pair of opt-ins.
          // Carrying the last node's answers over would be the dialog
          // answering a question this reader was never asked.
          <DrainConfirm
            key={node ?? ""}
            node={node}
            t={t}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        ) : (
          <DrainLive
            state={state}
            t={t}
            onStop={onCancelDrain}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Everything read and decided before the drain runs. */
function DrainConfirm({
  node,
  t,
  onCancel,
  onConfirm,
}: {
  node: string | null;
  t: T;
  onCancel: () => void;
  onConfirm: (node: string, choices: DrainChoices) => void;
}) {
  const [choices, setChoices] = useState<DrainChoices>({
    evictUnmanagedPods: false,
    evictPodsWithEmptydir: false,
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
          {t("empty", "drainKeepsAsking")}
        </p>
        <div className="flex flex-col border-t border-hair pt-1.5">
          <OptIn
            checked={choices.evictUnmanagedPods}
            onChange={(next) =>
              setChoices((was) => ({ ...was, evictUnmanagedPods: next }))
            }
            label={t("action", "evictUnmanagedPods")}
            explained={t("empty", "evictUnmanagedPodsExplained")}
          />
          <OptIn
            checked={choices.evictPodsWithEmptydir}
            onChange={(next) =>
              setChoices((was) => ({ ...was, evictPodsWithEmptydir: next }))
            }
            label={t("action", "evictPodsWithLocalData")}
            explained={t("empty", "evictPodsWithLocalDataExplained")}
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

/** The drain while it runs, and where it ended. */
function DrainLive({
  state,
  t,
  onStop,
  onClose,
}: {
  state: DrainState;
  t: T;
  onStop: () => void;
  onClose: () => void;
}) {
  if (state.phase === "idle") return null;

  if (state.phase === "failed") {
    return (
      <>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-bad">
            {t("action", "drainFailed")}
          </p>
          <p className="text-[11px] text-fg-fnt">{state.message}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("action", "close")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (state.phase === "starting") {
    return (
      <>
        <p className="text-xs text-fg-mut">
          {t("empty", "readingWhatRefusesToMove")}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onStop}>
            {t("action", "stopDraining")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const running = state.phase === "running";
  const report = state.report;
  const held = waiting(report.refused);
  const stuck = staying(report.refused);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        {running ? (
          <>
            <p className="text-xs text-fg-mut">
              {t("count", "podsMovedOff", { n: report.evicted })}{" "}
              {held.length > 0 &&
                t("count", "waitingOnPods", { n: held.length })}
            </p>
            {state.attempt > 1 && (
              <p className="text-[11px] text-fg-fnt">
                {t("action", "drainingAttempt", { n: state.attempt })}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs font-medium text-fg-mid">
            {t("action", OUTCOME_LABEL[state.outcome])}
          </p>
        )}

        {!running && (
          <p className="text-xs text-fg-mut">
            {t("count", "podsMovedOff", { n: report.evicted })}{" "}
            {report.refused.length > 0 &&
              t("count", "podsStayedOnTheNode", { n: report.refused.length })}
          </p>
        )}

        <PodLines pods={held} t={t} />
        {held.length > 0 && (
          <p className="text-[11px] text-fg-fnt">
            {t("empty", "notNowExplained")}
          </p>
        )}
        {running && held.length > 0 && (
          <p className="text-[11px] text-fg-fnt">
            {t("empty", "waitingOnTheseExplained")}
          </p>
        )}

        <PodLines pods={stuck} t={t} />
        {stuck.length > 0 && !running && (
          <p className="text-[11px] text-fg-fnt">
            {t("empty", "stoppedExplained")}
          </p>
        )}

        <Counts report={report} t={t} />
        {!running && state.message && (
          <p className="text-[11px] text-fg-fnt">{state.message}</p>
        )}
      </div>
      <DialogFooter>
        {running ? (
          <Button variant="outline" onClick={onStop}>
            {t("action", "stopDraining")}
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose}>
            {t("action", "close")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function PodLines({ pods, t }: { pods: RefusedPod[]; t: T }) {
  if (pods.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-1">
      {pods.map((pod) => (
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
  );
}

/** The rest of what was on the node, so the counts add up to what was there. */
function Counts({ report, t }: { report: DrainReport; t: T }) {
  return (
    <>
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
    </>
  );
}

/** One opt-in, with the consequence under it rather than in a tooltip. */
function OptIn({
  checked,
  onChange,
  label,
  explained,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  explained: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-fg-mid">{label}</span>
        <span className="text-[11px] text-fg-fnt">{explained}</span>
      </span>
    </label>
  );
}
