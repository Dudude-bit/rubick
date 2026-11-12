import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { DrainDialog } from "./drain-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useAsk } from "../../../-object/useAsk";
import { useCritical } from "@/hooks/useCritical";
import {
  drainKey,
  drainOf,
  forgetDrain,
  onDrainFinished,
  startDrain,
  stopDrain,
  useDrainStore,
} from "@/stores/drainStore";
import { useClusterStore } from "@/stores/clusterStore";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { listQueryFor, ResourceType } from "@/lib/resource-registry";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { guardedOf, noteDenied, useDenied, useRowDenial } from "@/lib/access";

export interface NodeActions {
  cordon: (node: string) => void;
  uncordon: (node: string) => void;
  /** Opens the drain dialog; the drain itself starts from there. */
  drain: (node: string) => void;
  /** Whether a drain this window started is still running on `node`. */
  draining: (node: string) => boolean;
  /** Why the cluster will not let this user cordon, uncordon or drain `node`. */
  denied: (node: string) => string | undefined;
  /** Mount once beside the surface; the dialog outlives any row. */
  dialogs: ReactNode;
}

/**
 * Cordon, uncordon and drain, for the list and the page alike.
 *
 * One hook rather than two copies: the list had these first, and a page
 * that grew its own would be the second reader of a drain's state, with a
 * report that could disagree with the row's.
 */
export function useNodeActions(asked: string | null): NodeActions {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const asking = useAsk();
  // The page asks about its node; a list learns of a row from its menu or a try.
  useDenied(asked ? guardedOf(ResourceType.Node, null, asked) : null);
  const rowDenied = useRowDenial(listQueryFor(ResourceType.Node), "patch");

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.resources(ResourceType.Node, null),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.details(ResourceType.Node),
    });
  };

  const cordonMutation = useMutation({
    mutationFn: (nodeName: string) => commands.cordonNode(nodeName),
    onSuccess: (_, nodeName) => {
      invalidate();
      toast({
        title: t("action", "nodeCordoned"),
        description: t("action", "nodeCordonedDetail", { name: nodeName }),
      });
    },
    onError: (error, nodeName) => {
      noteDenied("patch", guardedOf(ResourceType.Node, null, nodeName), error);
      toast({
        title: t("action", "error"),
        description: t("action", "cordonFailed", { error: errorToShow(error) }),
        variant: "destructive",
      });
    },
  });

  const uncordonMutation = useMutation({
    mutationFn: (nodeName: string) => commands.uncordonNode(nodeName),
    onSuccess: (_, nodeName) => {
      invalidate();
      toast({
        title: t("action", "nodeUncordoned"),
        description: t("action", "nodeUncordonedDetail", { name: nodeName }),
      });
    },
    onError: (error, nodeName) => {
      noteDenied("patch", guardedOf(ResourceType.Node, null, nodeName), error);
      toast({
        title: t("action", "error"),
        description: t("action", "uncordonFailed", {
          error: errorToShow(error),
        }),
        variant: "destructive",
      });
    },
  });

  const [open, setOpen] = useState<string | null>(null);
  // Cordon and uncordon fire straight from a list row. On a critical cluster
  // they are still a change to that cluster, so they route through the
  // typed-name gate the ConfirmDialog carries; elsewhere they stay one-click.
  const critical = useCritical();
  const criticalActive = critical.critical && !!critical.context;
  const [pendingSchedulable, setPendingSchedulable] = useState<{
    action: "cordon" | "uncordon";
    node: string;
  } | null>(null);

  // A drain is not a mutation: it outlives its own command call, this
  // dialog and this page. The store holds every one the window started; this
  // hook only owns which node's dialog is open.
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const drains = useDrainStore((s) => s.drains);
  const state = drainOf(drains, context, open);
  const shown = open ? drainKey(context, open) : null;
  useEffect(() => {
    useDrainStore.setState({ shown });
    // A node that emptied has nothing left to read, so its dialog gets out
    // of the way of the toast that says so.
    const off = onDrainFinished((result) => {
      if (result.outcome === "drained" && result.key === shown) setOpen(null);
    });
    return () => {
      off();
      useDrainStore.setState({ shown: null });
    };
  }, [shown]);

  const dialogs = (
    <>
      {asking.dialog}
      <ConfirmDialog
        open={pendingSchedulable !== null}
        onOpenChange={(next) => !next && setPendingSchedulable(null)}
        title={
          pendingSchedulable
            ? t(
                "action",
                pendingSchedulable.action === "cordon"
                  ? "cordonNamed"
                  : "uncordonNamed",
                { name: pendingSchedulable.node }
              )
            : ""
        }
        confirmLabel={t(
          "action",
          pendingSchedulable?.action === "uncordon" ? "uncordon" : "cordon"
        )}
        confirmVariant="destructive"
        onConfirm={() => {
          if (!pendingSchedulable) return;
          const { action, node } = pendingSchedulable;
          setPendingSchedulable(null);
          if (action === "cordon") cordonMutation.mutate(node);
          else uncordonMutation.mutate(node);
        }}
      />
      <DrainDialog
        node={open}
        state={state}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(null);
          // A running drain keeps running when its window is closed; the
          // panel says so. Only a finished one is cleared, so that reopening
          // the row does not reread an old report.
          if (shown) forgetDrain(shown);
        }}
        onConfirm={(node, { tellMeWhen, ...choices }) => {
          if (tellMeWhen) {
            asking.ask({ kind: "Node", namespace: null, name: node });
          }
          void startDrain(context, node, {
            ignoreDaemonsets: true,
            ...choices,
          });
        }}
        onCancelDrain={() => open && stopDrain(context, open)}
      />
    </>
  );

  return {
    cordon: (node) =>
      criticalActive
        ? setPendingSchedulable({ action: "cordon", node })
        : cordonMutation.mutate(node),
    uncordon: (node) =>
      criticalActive
        ? setPendingSchedulable({ action: "uncordon", node })
        : uncordonMutation.mutate(node),
    // Each node has its own drain, so reopening one shows what is running
    // on it and never another node's report.
    drain: setOpen,
    draining: (node) => {
      const { phase } = drainOf(drains, context, node);
      return phase === "starting" || phase === "running";
    },
    denied: (node) => rowDenied({ name: node }),
    dialogs,
  };
}
