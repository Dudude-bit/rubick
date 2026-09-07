import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { DrainDialog } from "@/components/resources/drain-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useAsk } from "@/hooks/useAsk";
import { drainingNode, useNodeDrain } from "@/hooks/useNodeDrain";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useT } from "@/i18n/useT";

export interface NodeActions {
  cordon: (node: string) => void;
  uncordon: (node: string) => void;
  /** Opens the drain dialog; the drain itself starts from there. */
  drain: (node: string) => void;
  /** The node a drain is running on, if one is. */
  draining: string | null;
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
export function useNodeActions(): NodeActions {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const asking = useAsk();

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.resources(ResourceType.Node, null),
    });
    void queryClient.invalidateQueries({ queryKey: ["node"] });
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
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: t("action", "cordonFailed", { error: String(error) }),
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
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: t("action", "uncordonFailed", { error: String(error) }),
        variant: "destructive",
      });
    },
  });

  const [open, setOpen] = useState<string | null>(null);

  // A drain is not a mutation: it outlives its own command call and reports
  // as it goes. The hook owns that; this one only owns which node is open.
  const drain = useNodeDrain({
    onFinished: (result) => {
      invalidate();
      // A node that emptied has nothing left to read, so it says so in a
      // toast and gets out of the way. Every other ending left a list of
      // pods and a reason each, which is not a story a toast can hold, so
      // it stays in the dialog unless nobody is looking at the dialog.
      if (result.outcome === "drained") {
        setOpen(null);
        drain.reset();
        toast({
          title: t("action", "nodeDrained"),
          description: t("action", "nodeDrainedDetail", { name: result.node }),
        });
        return;
      }
      if (open === null) {
        toast({
          title: t("action", "drainEnded", { name: result.node }),
          description: t("action", "reopenTheNodeToRead"),
        });
      }
    },
  });

  const dialogs = (
    <>
      {asking.dialog}
      <DrainDialog
        node={open}
        state={drain.state}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(null);
          // A running drain keeps running when its window is closed; the
          // panel says so. Only a finished one is cleared, so that reopening
          // the row does not reread an old report.
          if (drain.state.phase === "done" || drain.state.phase === "failed") {
            drain.reset();
          }
        }}
        onConfirm={(node, { tellMeWhen, ...choices }) => {
          if (tellMeWhen) {
            asking.ask({ kind: "Node", namespace: null, name: node });
          }
          void drain.start(node, { ignoreDaemonsets: true, ...choices });
        }}
        onCancelDrain={drain.cancel}
      />
    </>
  );

  return {
    cordon: (node) => cordonMutation.mutate(node),
    uncordon: (node) => uncordonMutation.mutate(node),
    // Reopening the node a drain is running on shows that drain. Any other
    // node starts clean, so one node's report never appears over another's.
    drain: (node) => {
      if (drainingNode(drain.state) !== node) drain.reset();
      setOpen(node);
    },
    draining: drainingNode(drain.state),
    dialogs,
  };
}
