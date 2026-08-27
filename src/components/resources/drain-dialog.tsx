/**
 * The drain confirmation, and the one thing it is worth reading first.
 *
 * A drain is where a PodDisruptionBudget stops being a number on a workload
 * page and becomes the reason a command sits there. `kubectl drain` does not
 * fail on a spent budget — the eviction API returns 429 and the drain retries,
 * forever if nothing changes — so a reader watching a drain that is not
 * finishing has no way to tell "slow" from "will never finish" without going
 * and finding the budget by hand. This says which one, before the click.
 *
 * **It does not block, it tells**, on the same terms as the delivery
 * intercept: draining into a spent budget is a legitimate thing to do, the
 * eviction simply waits, and a tool that refuses gets worked around.
 */

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnections } from "@/hooks/useConnections";
import { budgetRule, drainBlockers } from "@/lib/governance";
import { ResourceType } from "@/lib/resource-registry";
import { useT } from "@/i18n/useT";

export function DrainDialog({
  node,
  onOpenChange,
  onConfirm,
  busy,
}: {
  /** The node to drain, or `null` for a closed dialog. */
  node: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (node: string) => void;
  busy: boolean;
}) {
  const t = useT();
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
    <Dialog open={!!node} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("action", "drainNamed", { name: node ?? "" })}
          </DialogTitle>
        </DialogHeader>
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
              <p className="text-[11px] text-fg-fnt">
                {t("empty", "drainWillWait")}
              </p>
            </div>
          )}
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => node && onConfirm(node)}
          >
            {blockers.length > 0
              ? t("action", "drainAnyway")
              : t("action", "drain")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
