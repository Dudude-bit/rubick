import type { MouseEvent, ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { useT } from "@/i18n/useT";
import { openExternal } from "@/lib/open-external";
import { cn } from "@/lib/utils";

/**
 * A way out of the app, for the one kind of destination this tree has:
 * somebody else's website.
 *
 * A real anchor with the real address, so a screen reader announces a link,
 * and every gesture intercepted, because following it would navigate the app
 * away from itself.
 *
 * Nothing here decides whether a link should exist; `gitRepoLink` and its
 * neighbours do that, and a destination they declined never reaches this
 * component.
 */
export function OutLink({
  href,
  site,
  children,
  className,
}: {
  href: string;
  site: string;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternal(href, site, t);
  };

  return (
    <a
      href={href}
      onClick={go}
      onAuxClick={(event) => event.button === 1 && go(event)}
      title={t("action", "openOnSiteShort", { site })}
      className={cn(
        "inline-flex items-baseline gap-0.5 text-info hover:underline",
        className
      )}
    >
      {children}
      <ExternalLink className="size-2.5 self-center" aria-hidden />
    </a>
  );
}
