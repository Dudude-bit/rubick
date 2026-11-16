import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A whole pane that says one thing: a title, a sentence, and the next step. */
export function EmptyPage({
  title,
  body,
  icon: Icon,
  detail,
  testId,
  children,
}: {
  title: string;
  body: string;
  /** Said in the warn tone, beside the title: the page is a refusal, not a blank. */
  icon?: LucideIcon;
  /** The machine's own words, verbatim, under the sentence. */
  detail?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full justify-center px-6 py-12" data-testid={testId}>
      <div className="w-full max-w-[460px]">
        <h2 className="flex items-center gap-1.5 text-title font-semibold tracking-tight text-fg">
          {Icon && (
            <Icon
              className="h-3.5 w-3.5 flex-none text-warn"
              aria-hidden="true"
            />
          )}
          {title}
        </h2>
        <p className="mt-[3px] text-xs text-fg-mut">{body}</p>
        {detail && (
          <p className="mt-3 select-text wrap-break-word font-mono text-caption text-fg-fnt">
            {detail}
          </p>
        )}
        {children && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
