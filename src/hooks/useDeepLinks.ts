import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

import { commands } from "@/lib/commands";
import { parseDeepLink } from "@/lib/deep-link";
import { logInfo } from "@/lib/logger";
import { useClusterStore } from "@/stores/clusterStore";
import { useDeepLinkStore } from "@/stores/deepLinkStore";

/**
 * Turns a `rubick://` link into a place in this window: the one the app was
 * launched with, and any that arrive while it runs.
 *
 * The kubeconfig is asked again for each link rather than read from the
 * store, because the link may arrive before the store has loaded and a
 * cluster added since launch should still count.
 */
export function useDeepLinks(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    const open = async (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) {
        logInfo(`ignored a link that is not ours: ${raw}`, {
          context: "deep-link",
        });
        return;
      }
      const contexts = await commands.listContexts();
      if (cancelled) return;
      const known = contexts.map((c) => c.name);
      if (!known.includes(link.context)) {
        useDeepLinkStore
          .getState()
          .arrive({ status: "contextMissing", link, known });
        navigate("/");
        return;
      }
      const cluster = useClusterStore.getState();
      if (cluster.currentContext !== link.context) {
        await cluster.switchContext(link.context);
        // Awaited, not fired-and-forgotten: the banner says "you are looking
        // at it live", so it must not appear until the connect has actually
        // landed — and awaiting is what makes this connect the one that wins
        // the launch race with the saved-cluster auto-restore.
        await cluster.connect(link.context);
        if (cancelled) return;
      }
      useDeepLinkStore.getState().arrive({ status: "live", link });
      navigate(link.path);
    };

    void getCurrent()
      .then((urls) => {
        for (const url of urls ?? []) void open(url);
      })
      .catch((error: unknown) => {
        logInfo(`no launch link: ${String(error)}`, { context: "deep-link" });
      });

    const stop = onOpenUrl((urls) => {
      for (const url of urls) void open(url);
    });

    return () => {
      cancelled = true;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [navigate]);
}
