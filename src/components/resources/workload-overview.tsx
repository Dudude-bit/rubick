/**
 * The one composition every workload Overview is laid out in.
 *
 * Seven pages — Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob
 * and Pod — differ in which rows exist, not in the order of the questions a
 * reader asks, and each of them used to declare its own layout. What they all
 * declared was the same naive two-column grid, so four blocks flowed into it
 * in DOM order and a component that rendered *two* sections put "who sets the
 * replica count" top-right and "what a drain must respect" bottom-left.
 * Nobody chose that; auto-flow did. Doing it per page is how it drifted the
 * first time, so the order lives here and a page passes its content in.
 *
 * The questions, in the order they are asked:
 *
 * 1. *Is it all right?* — the header answers, and the problem summary says why
 *    when it is not. Above this, and untouched by it.
 * 2. *How many, who decides, what stops it* — one block. See {@link CountBlock}.
 * 3. *What does it use* — Usage, which needs the width it used to get least of.
 * 4. *How is it reached, and how is it declared* — the traffic chain, then the
 *    flat facts nobody reads until they need one.
 *
 * ## The layout rules
 *
 * - **Full width by default.** A block spans the page; nothing is squeezed
 *   into half of it by where it happened to fall.
 * - **Two columns only inside a block, and declared by that block.** There is
 *   no page-level auto-flow left to scatter anything into.
 * - **One label column.** Every key/value table on the page is `KeyValueRow`,
 *   whose label track is fixed, so the eye has one left edge.
 * - **A block states its subject once.** If a number belongs to a block, no
 *   other block repeats it. The header is exempt — it is identity.
 */

import { useT } from "@/i18n/useT";
import type { ReactNode } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { KeyValueList } from "./detail-kv";
import { governanceRows } from "./governance";
import { cn } from "@/lib/utils";
import type { Finding } from "@/lib/governance";
import type { KeyValue } from "./key-values";
import type { ConnectionsQuery } from "@/hooks/useConnections";

const FINDING_TONE: Record<Finding["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  // The honest one. `disruptionsAllowed: 0` on a budget that is exactly met
  // is a fact the reader wants and is not a fault, so it reads in the same
  // foreground every other stated fact on the page reads in.
  neutral: "text-fg-mut",
};

/** A state worth a sentence, under the rows that could not carry it. */
function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1.5">
      <p className={cn("text-xs font-medium", FINDING_TONE[finding.tone])}>
        {finding.title}
      </p>
      <p className="text-[11px] text-fg-fnt">{finding.detail}</p>
    </div>
  );
}

export interface WorkloadOverviewProps {
  /**
   * How many, who decides, what stops it.
   *
   * A Pod's version of this is not a count — it is one pod, and the question
   * it answers instead is *where the one is*, so it passes its placement
   * facts here and has no separate declaration block.
   */
  count?: ReactNode;
  /** What it uses. */
  usage?: ReactNode;
  /** How it is reached. */
  traffic?: ReactNode;
  /** How it is declared. */
  declared?: ReactNode;
  /** What the page owns past the four questions: owners, dialogs. */
  children?: ReactNode;
}

/**
 * `contents` rather than a column of its own: the detail frame already stacks
 * its children at the page's rhythm, and a wrapper with its own gap would put
 * the overview on a second one.
 */
export function WorkloadOverview({
  count,
  usage,
  traffic,
  declared,
  children,
}: WorkloadOverviewProps) {
  return (
    <div className="contents">
      {count}
      {usage}
      {traffic}
      {declared}
      {children}
    </div>
  );
}

export interface CountBlockProps {
  /** The noun this kind counts: "Replicas", "Rollout", "Run", "Runs". */
  title: string;
  /**
   * What this kind's own count is, where the title does not already say it —
   * a DaemonSet's "one pod per eligible node". The clauses about who sets the
   * number and what waits on it are not passed: they are earned by the rows.
   */
  subject?: ReactNode;
  /** The bar — or, where a kind genuinely counts two things, both bars. */
  children: ReactNode;
  /**
   * The neighbourhood, where anything in it sets or guards this count. What
   * it contributes is rows; a kind nothing governs passes nothing and gets
   * no empty rows for the absence.
   */
  governance?: ConnectionsQuery;
}

/**
 * The number, who sets it, and what a drain must respect — one block.
 *
 * This replaced three: a bar, an "Autoscaling" section and a "Disruption
 * budget" section, which between them stated the replica count twice more
 * than the header already had. The bar owns the count and the autoscaler and
 * the budget are reduced to what they contribute to *this* number.
 *
 * Two columns, declared here: the bar wants a bar's width and not the page's,
 * and the rows read as a caption beside it. When nothing governs the workload
 * the right column is simply not there — which is most workloads, and is why
 * the common case is a bar and one line under it.
 */
export function CountBlock({
  title,
  subject,
  children,
  governance,
}: CountBlockProps) {
  const t = useT();
  const { rows, findings, sets, guards } = governanceRows(governance?.data, t);

  return (
    <Section>
      <SectionHeader title={title} count={caption(subject, sets, guards)} />
      <div className="grid gap-x-8 md:grid-cols-2">
        <div>{children}</div>
        {rows.length > 0 && (
          <KeyValueList items={rows} className="self-start" />
        )}
      </div>
      {findings.map((finding) => (
        <FindingLine key={finding.title} finding={finding} />
      ))}
    </Section>
  );
}

/**
 * The caption, which promises exactly the rows that are there.
 *
 * "what a drain must respect" over a workload no budget covers is the same
 * mistake as an empty `A drain waits` row: it is a heading for something the
 * block does not go on to say.
 */
function caption(own: ReactNode, sets: boolean, guards: boolean): ReactNode {
  const earned = [
    sets ? "who sets it" : null,
    guards ? "what a drain must respect" : null,
  ].filter((clause): clause is string => clause !== null);

  if (earned.length === 0) return own;
  const said =
    earned.length === 2 ? `${earned[0]}, and ${earned[1]}` : earned[0];
  return own ? (
    <>
      {own}, {said}
    </>
  ) : (
    said
  );
}

/**
 * Past this many rows a fact table is taller than it is wide, and splitting it
 * costs the reader nothing: the rows are independent and the label column is
 * the same width in both halves, so the two columns line up with each other.
 * Below it a split leaves an orphan.
 */
const SPLIT_AT = 4;

export interface FactBlockProps {
  title: string;
  count?: ReactNode;
  items: KeyValue[];
}

/**
 * The flat facts, at the bottom, under a name that says what they are for.
 *
 * The name matters more than it looks. This block used to be titled with the
 * kind — `"StatefulSet"` — and the caption rule correctly drops a heading that
 * only repeats what the breadcrumb already said, so the block rendered
 * anonymous. Right rule, wrong outcome: "How it is declared" is what it is
 * for, and it is not suppressed because it is not a repetition.
 */
export function FactBlock({ title, count, items }: FactBlockProps) {
  const split = items.length >= SPLIT_AT ? Math.ceil(items.length / 2) : 0;

  return (
    <Section>
      <SectionHeader title={title} count={count} />
      {split === 0 ? (
        <KeyValueList items={items} />
      ) : (
        <div className="grid gap-x-8 md:grid-cols-2">
          <KeyValueList items={items.slice(0, split)} />
          <KeyValueList items={items.slice(split)} className="self-start" />
        </div>
      )}
    </Section>
  );
}
