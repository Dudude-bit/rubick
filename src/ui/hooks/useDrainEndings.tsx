import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import {
  forgetDrain,
  onDrainFinished,
  useDrainStore,
} from "@/stores/drainStore";

/**
 * Says how every drain ended, wherever the reader is by then.
 *
 * Mounted with the window and not with the Nodes pages: a drain waits on
 * budgets for as long as it takes, and its ending said only to the page
 * that started it is said to nobody once that page is left.
 */
export function useDrainEndings() {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onDrainFinished((result) => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.resources(ResourceType.Node, null),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.details(ResourceType.Node),
        });
        // A node that emptied has nothing left to read. Every other ending
        // left a list of pods and a reason each, which is not a story a
        // toast can hold: it stays for the dialog, and the toast only says
        // so when nobody is looking at that dialog.
        if (result.outcome === "drained") {
          forgetDrain(result.key);
          toast({
            title: t("action", "nodeDrained"),
            description: t("action", "nodeDrainedDetail", {
              name: result.node,
            }),
          });
          return;
        }
        if (useDrainStore.getState().shown !== result.key) {
          toast({
            title: t("action", "drainEnded", { name: result.node }),
            description: t("action", "reopenTheNodeToRead"),
          });
        }
      }),
    [t, toast, queryClient]
  );
}
