import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

import { parseDeepLink } from "@/lib/deep-link";
import { logInfo } from "@/lib/logger";
import { useDeepLinkStore } from "@/stores/deepLinkStore";

/**
 * The launch link belongs to the window, not to the layout that reads it:
 * that unmounts at the front door and on a missing cluster, and mounting
 * again must not open the link the app was launched with a second time.
 */
let launchRead = false;

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

    const open = (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) {
        logInfo(`ignored a link that is not ours: ${raw}`, {
          context: "deep-link",
        });
        return;
      }
      // Announced once the window is there: before, the page still on
      // screen would be taken for the one the link opened, and leaving it
      // is what dismisses the banner.
      void navigate({ href: link.path }).then(() => {
        if (!cancelled)
          useDeepLinkStore.getState().arrive({ status: "live", link });
      });
    };

    if (!launchRead) {
      void getCurrent()
        .then((urls) => {
          if (cancelled || launchRead) return;
          launchRead = true;
          for (const url of urls ?? []) open(url);
        })
        .catch((error: unknown) => {
          logInfo(`no launch link: ${String(error)}`, { context: "deep-link" });
        });
    }

    const stop = onOpenUrl((urls) => {
      for (const url of urls) open(url);
    });

    return () => {
      cancelled = true;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [navigate]);
}
