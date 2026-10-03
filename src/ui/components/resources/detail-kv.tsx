import * as React from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { useCopyToClipboard } from "@/hooks";
import { cn } from "@/lib/utils";
import { DetailAction } from "./detail-blocks";
import {
  TONE_CLASS,
  describeDocument,
  expandDocument,
  type KeyValue,
  type KeyValueTone,
} from "./key-values";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/**
 * The metadata row every detail page is made of.
 *
 * Eighteen detail pages were each inventing their own label/value grid —
 * different weights, different sizes, a bordered box around every group. One
 * row shape replaces all of them: an 11px label at the faintest foreground, a
 * 12px value at full foreground, one hairline between rows and no box. The
 * label column is fixed so values line up down the page; the value column
 * wraps rather than scrolls, because annotations and ingress URLs are long and
 * a horizontal scrollbar hides the end of the string that matters.
 */

export interface KeyValueRowProps {
  label: React.ReactNode;
  mono?: boolean;
  tone?: KeyValueTone;
  children: React.ReactNode;
  className?: string;
}

export function KeyValueRow({
  label,
  mono,
  tone,
  children,
  className,
}: KeyValueRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,132px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-1 last:border-b-0",
        className
      )}
    >
      {/* `min-w-0` lets the label shrink to its track and `wrap-break-word`
       *  breaks inside it. Without both, a grid item keeps its content's
       *  intrinsic width, and an unhyphenated annotation key such as
       *  `deployment.kubernetes.io/revision` is drawn straight over the
       *  value column. */}
      <dt
        className="min-w-0 wrap-break-word text-[11px] text-fg-fnt"
        // Only a plain label can be its own tooltip; a rendered one carries
        // its own affordances and would announce them twice.
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 wrap-break-word text-xs",
          mono && "font-mono",
          tone ? TONE_CLASS[tone] : "text-fg"
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * A value that is a document, folded.
 *
 * `kubectl.kubernetes.io/last-applied-configuration` is on almost every
 * applied object and is two to twelve wrapped lines of single-line JSON —
 * the tallest thing on the Overview tab of a page whose actual subject is
 * elsewhere. It is still real data, so it is never dropped: the row states
 * what it is holding, one control opens it, and Copy takes the whole value
 * whether it is open or not. Opened, it borrows the ConfigMap page's answer
 * to a long value — an indented `pre` behind a rule, capped and scrolling —
 * because that answer was already right.
 */
function FoldedDocument({ label, text }: { label: string; text: string }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const copyToClipboard = useCopyToClipboard();
  const expanded = React.useMemo(() => expandDocument(text), [text]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-fg-fnt">
          {describeDocument(text)}
        </span>
        <div className="-my-0.5 ml-auto flex items-center gap-1">
          <DetailAction
            label={open ? t("action", "hide") : t("action", "show")}
            icon={open ? ChevronDown : ChevronRight}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          />
          <DetailAction
            label={t("action", "copy")}
            icon={Copy}
            onClick={() =>
              copyToClipboard(text, t("action", "valueCopied", { label }))
            }
          />
        </div>
      </div>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all border-l border-hair pl-3 font-mono text-[11px] text-fg-mid">
          {expanded}
        </pre>
      )}
    </div>
  );
}

export interface KeyValueListProps {
  items: KeyValue[];
  /** Shown in place of the rows when there are none. */
  emptyMessage?: string;
  className?: string;
}

export function KeyValueList({
  items,
  emptyMessage,
  className,
}: KeyValueListProps) {
  if (items.length === 0) {
    return (
      <p className="py-1 text-xs text-fg-fnt">
        {emptyMessage ?? <T section="empty" k="none" />}
      </p>
    );
  }
  return (
    <dl className={cn("flex flex-col", className)}>
      {items.map((item, index) => (
        <KeyValueRow
          key={index}
          label={item.label}
          mono={item.mono}
          tone={item.tone}
        >
          {item.document ? (
            <FoldedDocument
              label={typeof item.label === "string" ? item.label : "value"}
              text={item.document}
            />
          ) : (
            item.value
          )}
        </KeyValueRow>
      ))}
    </dl>
  );
}

export interface KeyValueSectionProps extends KeyValueListProps {
  title: string;
  count?: React.ReactNode;
  actions?: React.ReactNode;
}

/** A titled metadata block: the heading, then the rows, on the canvas. */
export function KeyValueSection({
  title,
  count,
  actions,
  items,
  emptyMessage,
  className,
}: KeyValueSectionProps) {
  return (
    <Section className={className}>
      <SectionHeader title={title} count={count} actions={actions} />
      <KeyValueList items={items} emptyMessage={emptyMessage} />
    </Section>
  );
}

export type { KeyValue, KeyValueTone };
