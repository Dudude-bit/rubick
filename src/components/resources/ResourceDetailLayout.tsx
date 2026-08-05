/**
 * The frame every resource detail page sits in: the header, the page's own
 * blocks, the tab strip, and the metadata trailer.
 *
 * Nothing here draws a surface. Sections are separated by 22px of canvas and
 * the occasional hairline, which is the same rhythm the overview uses.
 */

import type { ReactNode } from "react";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";

import type { ConditionInfo } from "@/generated/types";
import { DetailSkeleton } from "@/components/ui/skeleton";
import { Section, SectionHeader } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { cn } from "@/lib/utils";
import { ConditionRows, DetailAction } from "./detail-blocks";
import { KeyValueRow, KeyValueSection } from "./detail-kv";
import { recordToKeyValues } from "./key-values";

interface DetailErrorProps {
  error: Error | string | null;
  resourceKind: string;
  onBack: () => void;
  /** Pods are replaced rather than restarted, so a 404 offers to follow. */
  onFindReplacement?: () => void;
  isSearching?: boolean;
  additionalMessage?: string;
}

export function DetailError({
  error,
  resourceKind,
  onBack,
  onFindReplacement,
  isSearching,
  additionalMessage,
}: DetailErrorProps) {
  const isNotFound = isResourceNotFoundError(error);
  const kind = resourceKind.toLowerCase();

  return (
    <Section className="max-w-lg">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-err" aria-hidden="true" />
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {isNotFound
            ? `${resourceKind} not found`
            : `Could not read this ${kind}`}
        </h2>
      </div>
      <p className="text-xs text-fg-mut">
        {isNotFound
          ? `The ${kind} may have been deleted or recreated under a new name.`
          : typeof error === "string"
            ? error
            : (error?.message ?? "The cluster did not answer.")}
      </p>
      {additionalMessage && (
        <p className="text-xs text-fg-mut">{additionalMessage}</p>
      )}
      <div className="flex items-center gap-1 pt-1">
        <DetailAction label="Go back" icon={ArrowLeft} onClick={onBack} />
        {isNotFound && onFindReplacement && (
          <DetailAction
            label={isSearching ? "Searching…" : "Find replacement"}
            icon={RefreshCw}
            onClick={onFindReplacement}
            busy={isSearching}
          />
        )}
      </div>
    </Section>
  );
}

interface InfoRowProps {
  label: string;
  value: ReactNode;
  className?: string;
}

/**
 * A single metadata row outside a list. Shares the key/value primitive, but
 * carries its own hairline: standalone rows are stacked as siblings, so the
 * list's "no rule under the last row" would leave every one of them bare.
 */
export function InfoRow({ label, value, className }: InfoRowProps) {
  return (
    <dl className={cn("border-b border-hair last:border-b-0", className)}>
      <KeyValueRow label={label} className="border-b-0">
        {value}
      </KeyValueRow>
    </dl>
  );
}

interface InfoCardProps {
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/** Titled group of related info on the flat canvas. */
export function InfoCard({
  title,
  children,
  className,
  contentClassName,
}: InfoCardProps) {
  return (
    <Section className={className}>
      <SectionHeader title={title} />
      <div className={contentClassName}>{children}</div>
    </Section>
  );
}

export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface ResourceDetailLayoutProps {
  resource: unknown;
  isLoading: boolean;
  error: Error | string | null;
  /** Kind, used for the breadcrumb and every "not found" message. */
  resourceKind: string;

  /** The object's name. */
  title: string;
  namespace?: string;
  createdAt?: string | null;
  statusBadge?: ReactNode;
  /** Qualifiers shown beside the name. */
  badges?: ReactNode;
  actions?: ReactNode;
  /**
   * Accepted and ignored. The flat header has no room for a 32px glyph, but
   * twelve detail pages still pass one; the prop goes when they convert.
   */
  icon?: ReactNode;

  onBack: () => void;
  onFindReplacement?: () => void;
  isSearchingReplacement?: boolean;

  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;

  /** Rendered under the tabs when the default tab is showing. */
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  conditions?: ConditionInfo[];

  children?: ReactNode;
}

export function ResourceDetailLayout({
  resource,
  isLoading,
  error,
  resourceKind,
  title,
  namespace,
  createdAt,
  statusBadge,
  badges,
  actions,
  onBack,
  onFindReplacement,
  isSearchingReplacement,
  tabs,
  activeTab,
  onTabChange,
  labels,
  annotations,
  conditions,
  children,
}: ResourceDetailLayoutProps) {
  if (isLoading) {
    return <DetailSkeleton />;
  }

  if (error || !resource) {
    return (
      <DetailError
        error={error}
        resourceKind={resourceKind}
        onBack={onBack}
        onFindReplacement={onFindReplacement}
        isSearching={isSearchingReplacement}
      />
    );
  }

  const showTrailer = activeTab === "overview";

  return (
    <div className="flex flex-col gap-[22px] animate-in fade-in duration-200">
      <ResourceDetailHeader
        name={title}
        kind={resourceKind}
        namespace={namespace}
        createdAt={createdAt}
        status={statusBadge}
        meta={badges}
        actions={actions}
        onBack={onBack}
      />

      {children}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        {/* The strip is an underline, not a pill row: the window already has
            a pill tab strip for scopes, and two of them on one screen read as
            the same control at two levels. */}
        <TabsList className="h-auto w-full justify-start gap-3 rounded-none border-b border-hair bg-transparent p-0 text-fg-mut">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              className="-mb-px h-7 rounded-none border-b border-transparent px-0.5 pb-1.5 pt-0 text-xs font-normal text-fg-mut shadow-none transition-colors hover:text-fg data-[state=active]:border-fg data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            className="mt-[18px] flex flex-col gap-[22px]"
          >
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>

      {showTrailer && labels && Object.keys(labels).length > 0 && (
        <KeyValueSection
          title="Labels"
          count={Object.keys(labels).length}
          items={recordToKeyValues(labels)}
        />
      )}

      {showTrailer && annotations && Object.keys(annotations).length > 0 && (
        <KeyValueSection
          title="Annotations"
          count={Object.keys(annotations).length}
          items={recordToKeyValues(annotations)}
        />
      )}

      {showTrailer && conditions && conditions.length > 0 && (
        <Section>
          <SectionHeader title="Conditions" count={conditions.length} />
          <ConditionRows conditions={conditions} />
        </Section>
      )}
    </div>
  );
}

export default ResourceDetailLayout;
