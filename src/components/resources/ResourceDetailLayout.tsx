/**
 * The frame every resource detail page sits in: the header, the page's own
 * blocks and the tab strip.
 *
 * Nothing here draws a surface. Sections are separated by 22px of canvas and
 * the occasional hairline, which is the same rhythm the overview uses.
 */

import { type ReactNode } from "react";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";

import { DetailSkeleton } from "@/components/ui/skeleton";
import { CaptionScope, Section } from "@/components/ui/section";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { cn } from "@/lib/utils";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { DetailTabs } from "./DetailTabs";
import { DetailAction } from "./detail-blocks";
import { DeliveryBanner, DeliveryMarks } from "./delivery";
import { surfaceIsOpen, type DetailTab } from "./detail-tab";
import { useDelivery } from "@/hooks/useDelivery";
import type { DeliveryQuery } from "@/integrations";

/** Kept reachable from here: the pages that hold a `DetailTab[]` import both. */
export type { DetailTab } from "./detail-tab";

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

interface ResourceDetailLayoutProps {
  resource: unknown;
  isLoading: boolean;
  error: Error | string | null;
  /** Kind, used for the breadcrumb and every "not found" message. */
  resourceKind: string;
  /**
   * Breadcrumb overrides for kinds the resource registry does not own, and
   * `null` for a kind with no list page to send the reader to.
   */
  listUrl?: string | null;
  listLabel?: string;

  /** The object's name. */
  title: string;
  namespace?: string;
  /** `null` where narrowing to the namespace has no list to open under it. */
  namespaceUrl?: string | null;
  createdAt?: string | null;
  statusBadge?: ReactNode;
  /** Qualifiers shown beside the name. */
  badges?: ReactNode;
  /**
   * The object, for the one question every detail page in the app is asked:
   * *where do I change this, and will my change stick.*
   *
   * Answered here rather than page by page, and that is the whole reason it is
   * a prop on the frame: provenance is not a property of workloads. A ConfigMap
   * is delivered from git exactly as much as a Deployment is, and a fact that
   * appeared on eleven detail pages and was missing on the twelfth would teach
   * the reader that its absence means "not delivered" — which on the twelfth
   * page would be a lie. A page passes the object and gets the mark, the earned
   * line and nothing else to think about.
   *
   * Omitted only where the page's subject is not an applied manifest at all.
   */
  delivery?: DeliveryQuery | null;
  /**
   * What this page lets you do to the object, as `DetailAction`s.
   *
   * Rendered at the right end of the tab strip rather than in the header.
   * How many fit: the peek panel folds its overflow into a More menu past
   * five controls in a row, and that budget is not re-derived here because
   * nothing reaches it — a Pod's four is the widest set in the app and a
   * Deployment's Scale, Restart and Delete is three. What is scarce on this
   * row is width rather than count, since the tab strip is on it too, so the
   * rule is which of the two gives way: the actions are pinned to the right
   * at their natural width and the tab labels truncate, because an action
   * that wrapped onto a second line would undo the whole point of the row.
   */
  actions?: ReactNode;

  onBack: () => void;
  onFindReplacement?: () => void;
  isSearchingReplacement?: boolean;

  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;

  children?: ReactNode;
}

export function ResourceDetailLayout({
  resource,
  isLoading,
  error,
  resourceKind,
  listUrl,
  listLabel,
  title,
  namespace,
  namespaceUrl,
  createdAt,
  statusBadge,
  badges,
  delivery,
  actions,
  onBack,
  onFindReplacement,
  isSearchingReplacement,
  tabs,
  activeTab,
  onTabChange,
  children,
}: ResourceDetailLayoutProps) {
  const { deliveries } = useDelivery(delivery ?? null);

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

  // Collapsing the page's own blocks is not a control the reader operates:
  // clicking "Logs" already said what they came for, and a toggle would spend
  // a slot in the very row it exists to shrink. Reversing it is the Overview
  // tab, one click away.
  const surface = surfaceIsOpen(tabs, activeTab);

  return (
    <CaptionScope kind={resourceKind}>
      <div
        className={cn(
          "flex flex-col animate-in fade-in duration-200",
          surface ? "h-full min-h-0 gap-2" : "gap-[22px]"
        )}
      >
        <ResourceDetailHeader
          name={title}
          kind={resourceKind}
          listUrl={listUrl}
          listLabel={listLabel}
          namespace={namespace}
          namespaceUrl={namespaceUrl}
          createdAt={createdAt}
          status={statusBadge}
          meta={
            <>
              {badges}
              <DeliveryMarks deliveries={deliveries} />
            </>
          }
          onBack={onBack}
        />

        {/* Above the page's own blocks, and usually not there at all: the line
            is earned per object, never per managed object. */}
        {!surface && <DeliveryBanner deliveries={deliveries} />}

        {/* `contents` so the page's own blocks keep sitting in this column at
            its own rhythm; `hidden` takes all of them off a surface tab at
            once. Kept mounted either way — the dialogs a page hangs here
            portal to the body and have to survive the tab that opened them. */}
        {children && (
          <div className={surface ? "hidden" : "contents"}>{children}</div>
        )}

        <DetailTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
          actions={actions}
        />
      </div>
    </CaptionScope>
  );
}

export default ResourceDetailLayout;
