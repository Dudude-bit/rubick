import type { ReactNode } from "react";
import { Play, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The frame a tab's "nothing to show here, and why" sits in. */
export function HollowFrame({
  headline,
  icon: Icon,
  testId,
  children,
}: {
  headline: string;
  icon?: LucideIcon;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="max-w-[62ch] px-3 pb-12 pt-11" data-testid={testId}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-title font-medium text-fg">
        {Icon && (
          <Icon
            className="h-3.5 w-3.5 flex-none text-fg-fnt"
            aria-hidden="true"
          />
        )}
        {headline}
      </h3>
      {children}
    </div>
  );
}

/** A tab that would run something in the container, waiting for the reader to say so. */
export function StartOnAsk({
  icon: Icon,
  headline,
  body,
  action,
  onStart,
}: {
  icon: LucideIcon;
  headline: string;
  body: string;
  action: string;
  onStart: () => void;
}) {
  return (
    <HollowFrame headline={headline} icon={Icon} testId="start-on-ask">
      <p className="mb-3.5 text-xs text-fg-mut">{body}</p>
      <Button size="sm" variant="outline" onClick={onStart}>
        <Play className="mr-1.5 h-3 w-3 text-ok" aria-hidden="true" />
        {action}
      </Button>
    </HollowFrame>
  );
}
