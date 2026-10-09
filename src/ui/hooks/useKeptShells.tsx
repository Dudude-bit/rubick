import { useEffect, useRef } from "react";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { SquareTerminal } from "lucide-react";

import { toast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { listenEvent } from "@/lib/events";
import { hrefOf, objectLink } from "@/lib/links";
import { ResourceType } from "@/lib/resource-registry";
import {
  endShell,
  heard,
  strandedShell,
  useKeptShellStore,
  type KeptShell,
} from "@/stores/keptShellStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

const plain = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

function pageOf(shell: KeptShell): string {
  const link = objectLink(
    { kind: ResourceType.Pod, name: shell.pod, namespace: shell.namespace },
    { cluster: shell.context }
  );
  return link ? plain(hrefOf(link).split("?")[0]) : "";
}

/**
 * Holds every kept shell to its owner: buffers what it prints for the pane
 * that attaches next, lets go of one that ended, and ends one whose tab
 * closed or left the pod's page, which `onLeftPage` is told about.
 */
export function keepShells(
  router: AnyRouter,
  onLeftPage: (shell: KeptShell) => void
): () => void {
  const output = listenEvent("terminal-output", ({ payload }) =>
    heard(payload.session_id, payload.data)
  );
  const closed = listenEvent("terminal-closed", ({ payload }) =>
    useKeptShellStore.getState().forget(payload.session_id)
  );

  const onPage = (shell: KeptShell) => {
    const { resolvedLocation, location } = router.state;
    return plain((resolvedLocation ?? location).pathname) === pageOf(shell);
  };
  const settle = () => {
    for (;;) {
      const { tabs, activeId, pendingHref } = useScopeTabStore.getState();
      const stranded = strandedShell(
        useKeptShellStore.getState().shells,
        { ids: tabs.map((tab) => tab.id), activeId, pendingHref },
        onPage
      );
      if (!stranded) return;
      void endShell(stranded.shell.id);
      if (stranded.why === "leftPage") onLeftPage(stranded.shell);
    }
  };

  const stops = [
    useScopeTabStore.subscribe(settle),
    useKeptShellStore.subscribe(settle),
    router.subscribe("onResolved", settle),
  ];
  return () => {
    stops.forEach((stop) => stop());
    for (const off of [output, closed])
      void off.then(
        (unlisten) => unlisten(),
        () => undefined
      );
  };
}

/** {@link keepShells} for the window, saying so when a shell ends with its page. */
export function useKeptShells(): void {
  const router = useRouter();
  const t = useT();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(
    () =>
      keepShells(router, (shell) =>
        toast({
          title: tRef.current("activity", "shellEndedOnLeave"),
          description: (
            <span className="flex items-start gap-1.5">
              <SquareTerminal
                className="mt-px h-3.5 w-3.5 flex-none text-warn"
                aria-hidden="true"
              />
              {tRef.current("activity", "shellEndedOnLeaveBody", {
                target: `${shell.pod}/${shell.container}`,
              })}
            </span>
          ),
        })
      ),
    [router]
  );
}
