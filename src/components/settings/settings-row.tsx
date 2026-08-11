import * as React from "react";
import { cn } from "@/lib/utils";
import {
  SettingsGroupScope,
  useGroupHasMatch,
  useSettingSearchMatch,
} from "./settings-search";

/**
 * The two shapes every settings screen is made of.
 *
 * Settings pages rot into stacked bordered panels because each group looks
 * like it wants a box. It does not: a caption plus a hairline already says
 * "these belong together", and once the boxes are gone the controls line up
 * down a single right edge across the whole page, which is what makes a
 * long settings screen scannable.
 */
export function SettingsGroup({
  title,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { title?: string }) {
  const id = React.useId();
  // A caption above nothing is worse than no caption: it says the group is
  // empty rather than that the search passed it over.
  const visible = useGroupHasMatch(id);

  return (
    <SettingsGroupScope id={id}>
      <section
        className={cn("flex flex-col", !visible && "hidden", className)}
        {...props}
        hidden={!visible}
      >
        {/* A section named once by the nav does not name itself again. */}
        {title && (
          <h2 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
            {title}
          </h2>
        )}
        <div className="border-t border-hair">{children}</div>
      </section>
    </SettingsGroupScope>
  );
}

export interface SettingRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  label: React.ReactNode;
  /** One line under the label. Not a paragraph, and never in a box. */
  hint?: React.ReactNode;
  /** `id` of the control this row labels, when there is a single one. */
  htmlFor?: string;
  /** The control. Right-aligned against every other row's control. */
  control?: React.ReactNode;
  /**
   * Words the row does not print but a reader would type: the other
   * spelling, the tool's real name, the thing this is usually called.
   */
  keywords?: string;
  /**
   * Full-width content below the label, for the rare row whose control
   * cannot sit on one line (a file path field, a key/value editor).
   */
  children?: React.ReactNode;
}

export function SettingRow({
  label,
  hint,
  htmlFor,
  control,
  keywords,
  className,
  children,
  ...props
}: SettingRowProps) {
  const visible = useSettingSearchMatch(label, hint, keywords);
  const Label = htmlFor ? "label" : "span";
  return (
    <div
      className={cn(
        "border-b border-hair py-2",
        !visible && "hidden",
        className
      )}
      {...props}
      hidden={!visible}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor={htmlFor} className="text-xs text-fg-mid">
            {label}
          </Label>
          {hint && <span className="text-[11px] text-fg-mut">{hint}</span>}
        </div>
        {control && (
          <div className="flex flex-none items-center gap-1.5">{control}</div>
        )}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/**
 * A block of settings that is not built from rows — a tabbed editor, a
 * list with its own controls — indexed as one thing.
 *
 * It matches or it does not; there is nothing finer to filter inside it.
 */
export function SettingsSearchable({
  keywords,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { keywords?: string }) {
  const visible = useSettingSearchMatch(keywords);
  return (
    <div
      className={cn(!visible && "hidden", className)}
      {...props}
      hidden={!visible}
    >
      {children}
    </div>
  );
}
