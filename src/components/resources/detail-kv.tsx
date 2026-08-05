import * as React from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { TONE_CLASS, type KeyValue, type KeyValueTone } from "./key-values";

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
  label: string;
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
      {/* `min-w-0` lets the label shrink to its track and `break-words`
       *  breaks inside it. Without both, a grid item keeps its content's
       *  intrinsic width, and an unhyphenated annotation key such as
       *  `deployment.kubernetes.io/revision` is drawn straight over the
       *  value column. */}
      <dt className="min-w-0 break-words text-[11px] text-fg-fnt" title={label}>
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 break-words text-xs",
          mono && "font-mono",
          tone ? TONE_CLASS[tone] : "text-fg"
        )}
      >
        {children}
      </dd>
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
  emptyMessage = "None",
  className,
}: KeyValueListProps) {
  if (items.length === 0) {
    return <p className="py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  }
  return (
    <dl className={cn("flex flex-col", className)}>
      {items.map((item, index) => (
        <KeyValueRow
          key={`${index}-${item.label}`}
          label={item.label}
          mono={item.mono}
          tone={item.tone}
        >
          {item.value}
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
