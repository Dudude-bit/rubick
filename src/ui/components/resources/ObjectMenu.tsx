import { Copy, ExternalLink, Link2 } from "lucide-react";
import { createPortal } from "react-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { useClusterStore } from "@/stores/clusterStore";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/**
 * The right-click menu of an object link. The webview's own menu offered
 * "Copy link address" and copied `http://tauri.localhost/...`, an address
 * that opens nothing anywhere; this one copies the name, the link that
 * does open, or the object in a tab behind this one.
 */
export function ObjectMenu() {
  const t = useT();
  const copy = useCopyToClipboard();
  const target = useObjectMenuStore((state) => state.target);
  const close = useObjectMenuStore((state) => state.close);
  const context = useClusterStore((state) => state.currentContext);
  const openTab = useScopeTabStore((state) => state.openTab);
  if (target === null) return null;
  const link = context ? buildDeepLink(context, target.to) : null;
  // Into the body, because `position: fixed` is measured from the nearest
  // ancestor that has a transform rather than from the window, and the page
  // container this used to sit in carries one: the menu opened a sidebar's
  // width away from the pointer, and drifted further the more the list was
  // scrolled. Anchoring outside every page wrapper is what makes the two
  // numbers the ones the pointer reported.
  return createPortal(
    <DropdownMenu open onOpenChange={(open) => !open && close()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: target.x, top: target.y }}
          className="size-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuItem
          onSelect={() =>
            void copy(
              target.name,
              t("action", "nameCopied", { name: target.name })
            )
          }
        >
          <Copy className="mr-2 size-3.5" aria-hidden />
          {t("action", "copyName")}
        </DropdownMenuItem>
        {link !== null && (
          <DropdownMenuItem
            onSelect={() =>
              void copy(
                link,
                t("cluster", "objectLinkCopied", { name: target.name })
              )
            }
          >
            <Link2 className="mr-2 size-3.5" aria-hidden />
            {t("action", "copyLink")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => void openTab({ href: target.to, background: true })}
        >
          <ExternalLink className="mr-2 size-3.5" aria-hidden />
          {t("action", "openInNewTab")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  );
}
