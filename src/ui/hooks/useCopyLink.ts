import { useEffect } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { toast } from "@/components/ui/use-toast";
import { useLocationHref } from "@/hooks/useLocationHref";
import { buildDeepLink } from "@/lib/deep-link";
import { clusterOf } from "@/lib/links";
import { useT } from "@/i18n/useT";

/** True inside a terminal or a text field, where the same keys mean something else. */
export function claimedByTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return true;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}

/**
 * Whether a layer the reader is *in* owns the keys.
 *
 * Asked of where the focus is, not of whether any dialog exists in the
 * document — the app has settled this twice before, and the second form gets
 * both directions wrong. Too broad: the peek panel is a non-modal Sheet,
 * opened deliberately so the sidebar, the tabs and the list behind it keep
 * working, and a plain row click opens one — a whole-document test made `?`,
 * every `g` chord and every page key silently dead for as long as it was up.
 * Too narrow: a dropdown or a context menu carries `role="menu"` and no
 * dialog at all, so its own keys were fighting the global ones.
 */
export function claimedByLayer(target: EventTarget | null): boolean {
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const within = (element: HTMLElement | null) =>
    !!element?.closest(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'
    );
  return (
    within(focused) || within(target instanceof HTMLElement ? target : null)
  );
}

export function isCopyLinkKey(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "c"
  );
}

/**
 * `mod+shift+c` copies a `rubick://` link to where the window is. Not
 * inside a terminal, where Ctrl+Shift+C is "copy the selection" everywhere
 * and a link would be a surprise.
 */
export function useCopyLink(): void {
  const href = useLocationHref();
  const t = useT();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCopyLinkKey(event) || claimedByTarget(event.target)) return;
      if (clusterOf(href) === null) return;
      event.preventDefault();
      const link = buildDeepLink(href);
      void writeText(link).then(() =>
        toast({
          title: t("cluster", "linkCopied"),
          description: link,
        })
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [href, t]);
}
