import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useResourceMutation } from "@/hooks";
import { useT } from "@/i18n/useT";
import type { Revision } from "@/lib/changes";
import { commands } from "@/lib/commands";
import type { DeliveryIntercept } from "@/lib/delivery";
import { queryKeys } from "@/lib/query-keys";
import { guardedOf, noteDenied, useDenied } from "@/lib/access";
import type { ResourceKind } from "@/lib/resource-registry";
import { RollbackDialog, type RollbackSubject } from "./RollbackDialog";

/**
 * Roll a workload back to one of its revisions, the way
 * `kubectl rollout undo --to-revision` does, behind a confirmation that
 * shows what will change. One per surface: `offer` opens it for a revision.
 */
export function useRollback({
  subject,
  revisions,
  intercept,
}: {
  subject: RollbackSubject;
  revisions: Revision[];
  intercept: DeliveryIntercept | null;
}): {
  offer: (revision: Revision) => void;
  /** Why the cluster will not take a rollback from this user. */
  denied: string | undefined;
  dialog: ReactNode;
} {
  const t = useT();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Revision | null>(null);
  const { kind, name, namespace } = subject;
  const guarded = guardedOf(kind, namespace);
  const denied = useDenied(guarded).patch;

  const rollback = useResourceMutation(
    (revision: number) =>
      commands.rollbackWorkload(kind, name, namespace, revision),
    {
      toast: {
        successTitle: t("action", "rollBack"),
        successDescription: (outcome, revision) =>
          t(
            "action",
            outcome.outcome === "alreadyThere"
              ? "rollbackAlreadyThere"
              : "rollbackStarted",
            { kind, name, n: revision }
          ),
        errorPrefix: t("action", "rollbackFailed"),
      },
      invalidateQueryKeys: [
        queryKeys.details(kind),
        queryKeys.lists(kind as ResourceKind),
        queryKeys.deploymentReplicaSets(namespace, name),
      ],
      onError: (error) => noteDenied("patch", guarded, error),
      onSuccess: () => {
        setTarget(null);
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey.includes("changes"),
        });
      },
    }
  );

  const current = revisions.find((revision) => revision.current);
  const dialog = target && target.number !== null && (
    <RollbackDialog
      subject={subject}
      target={target}
      current={current}
      intercept={intercept}
      busy={rollback.isPending}
      onOpenChange={(open) => !open && setTarget(null)}
      onConfirm={() => rollback.mutate(target.number!)}
    />
  );
  return { offer: setTarget, denied, dialog };
}
