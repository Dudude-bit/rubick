import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { launchLinks, onOpenLinks } from "@/lib/host";

import { parseDeepLink } from "@/lib/deep-link";
import { logInfo } from "@/lib/logger";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { tabKeepsShell } from "@/stores/keptShellStore";

/**
 * The launch link belongs to the window, not to the layout that reads it:
 * that unmounts at the front door and on a missing cluster, and mounting
 * again must not open the link the app was launched with a second time.
 */
let launchRead = false;

/** Once the tab just opened has its route, or at once if nothing is on its way. */
function landed(): Promise<void> {
  return new Promise((resolve) => {
    if (useScopeTabStore.getState().pendingHref === null) return resolve();
    const stop = useScopeTabStore.subscribe((state) => {
      if (state.pendingHref !== null) return;
      stop();
      resolve();
    });
  });
}

/**
 * Turns a `rubick://` link into a place in this window: the one the app was
 * launched with, and any that arrive while it runs.
 *
 * The link's address names its cluster, so going there is all this does:
 * the cluster route connects, and is what says so when the kubeconfig has
 * no cluster by that name.
 */
export function useDeepLinks(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    const open = (raw: string, launched = false) => {
      const link = parseDeepLink(raw);
      if (!link) {
        logInfo(`ignored a link that is not ours: ${raw}`, {
          context: "deep-link",
        });
        return;
      }
      const tabs = useScopeTabStore.getState();
      // The link the app was started with wins over the page the session restores.
      if (launched) tabs.yieldToLink(link);
      // Announced once the window is there: before, the page still on
      // screen would be taken for the one the link opened, and leaving it
      // is what dismisses the banner.
      const announce = () => {
        if (!cancelled)
          useDeepLinkStore.getState().arrive({ status: "live", link });
      };
      // A tab holding a shell the reader started keeps it: navigating that
      // tab away would end the shell, so the link gets a tab of its own.
      if (!launched && tabKeepsShell(tabs.activeId)) {
        void tabs
          .openTab({ href: link.path, context: link.context })
          .then(landed)
          .then(announce);
        return;
      }
      void navigate({ href: link.path }).then(announce);
    };

    if (!launchRead) {
      void launchLinks()
        .then((urls) => {
          if (cancelled || launchRead) return;
          launchRead = true;
          for (const url of urls ?? []) open(url, true);
        })
        .catch((error: unknown) => {
          logInfo(`no launch link: ${String(error)}`, { context: "deep-link" });
        });
    }

    const stop = onOpenLinks((urls) => {
      for (const url of urls) open(url);
    });

    return () => {
      cancelled = true;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [navigate]);
}
