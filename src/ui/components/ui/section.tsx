import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A region on the flat canvas — the replacement for `Card`.
 *
 * Deliberately brings no background, border or shadow: the window is one
 * surface, and stacking tinted boxes on it reads as a grid of containers.
 * Grouping is carried by the heading above and the space around it.
 */
export function Section({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

/**
 * What the frame around a section has already told the reader.
 *
 * A tab strip is a heading: clicking "Conditions" is being told what the pane
 * below holds, so a block captioned "Conditions" under it says the word
 * twice, and the breadcrumb and page title say the kind the same way. The
 * rule — *a caption names what the frame has not already named* — is enforced
 * here rather than remembered by thirty-odd tabs one at a time.
 *
 * So the frame states what it says, and `SectionHeader` drops a title that
 * only repeats it. What the frame does not carry — a count, a description,
 * the section's own controls — survives as the 11px caption line.
 */
export interface CaptionFrame {
  /** The kind in the breadcrumb and the header row. */
  kind?: string;
  /** The label of the tab this subtree is inside. */
  tab?: string;
}

const CaptionFrameContext = React.createContext<CaptionFrame>({});

/** Extends the frame rather than replacing it: the tab sits inside a page
 *  that has already named the kind. */
export function CaptionScope({
  kind,
  tab,
  children,
}: CaptionFrame & { children: React.ReactNode }) {
  const outer = React.useContext(CaptionFrameContext);
  const value = React.useMemo(
    () => ({ kind: kind ?? outer.kind, tab: tab ?? outer.tab }),
    [kind, tab, outer.kind, outer.tab]
  );
  return (
    <CaptionFrameContext.Provider value={value}>
      {children}
    </CaptionFrameContext.Provider>
  );
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a title says only what the frame said. Deliberately exact rather
 * than fuzzy: "Reachable at" under an "Access" tab is a second fact and
 * has to survive, while "PersistentVolumeClaim YAML" under a "YAML" tab is
 * the tab label with the kind bolted onto it and does not.
 */
function restatesFrame(title: string, frame: CaptionFrame): boolean {
  const said = slug(title);
  if (said === "") return false;
  const kind = frame.kind ? slug(frame.kind) : "";
  const tab = frame.tab ? slug(frame.tab) : "";
  if (kind !== "" && said === kind) return true;
  if (tab !== "" && said === tab) return true;
  return (
    kind !== "" && tab !== "" && (said === kind + tab || said === tab + kind)
  );
}

/**
 * A bare number left alone under a dropped title is a digit floating on
 * the canvas, so it borrows the noun the title was carrying. Zero says
 * nothing the empty message below does not say better.
 */
function tally(count: React.ReactNode, title: string): React.ReactNode {
  if (typeof count !== "number") return count;
  if (count === 0) return null;
  const caps = title === title.toUpperCase();
  const word = caps ? title : title.toLowerCase();
  const noun =
    !caps && count === 1 && word.endsWith("s") ? word.slice(0, -1) : word;
  return `${count} ${noun}`;
}

export interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  /** Shown muted beside the title — a row count, a total. */
  count?: React.ReactNode;
  /** One line under the title for a qualifier the title cannot carry. */
  description?: React.ReactNode;
  /** Right-aligned controls belonging to this section. */
  actions?: React.ReactNode;
}

export function SectionHeader({
  title,
  count,
  description,
  actions,
  className,
  ...props
}: SectionHeaderProps) {
  const frame = React.useContext(CaptionFrameContext);

  if (restatesFrame(title, frame)) {
    const caption = tally(count, title);
    if (caption == null && !description && !actions) return null;
    return (
      <div className={cn("flex flex-col gap-0.5", className)} {...props}>
        <div className="flex items-baseline gap-2 text-[11px] text-fg-fnt">
          {caption}
          {actions && (
            <div className="ml-auto flex items-center gap-1">{actions}</div>
          )}
        </div>
        {description && <p className="text-xs text-fg-mut">{description}</p>}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-0.5", className)} {...props}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {count != null && <span className="text-xs text-fg-fnt">{count}</span>}
        {actions && (
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        )}
      </div>
      {description && <p className="text-xs text-fg-mut">{description}</p>}
    </div>
  );
}

/** Wrapper for a list or table body: one hairline separates it from the
 *  heading, in place of the card's top border. */
export function SectionBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-hair", className)} {...props} />;
}
