/**
 * The frame every resource detail page sits in: the header, what is wrong with
 * the object, and the tab strip.
 *
 * The order is the whole point. Identity, then the one or two lines that say
 * the object is in trouble, then the strip — which carries the page's actions
 * on its row. Nothing of the page's own grows above that strip, so Scale,
 * Restart and Delete are above the fold by construction rather than by luck:
 * this frame used to render the page's blocks between the header and the
 * strip, and the day the Overview stopped being two short columns the controls
 * left the screen.
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
import type { Freshness } from "@/hooks/useLiveQuery";
import type { DeliveryQuery } from "@/integrations";
import { useT } from "@/i18n/useT";

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
  const t = useT();
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
        <DetailAction
          label={t("action", "goBack")}
          icon={ArrowLeft}
          onClick={onBack}
        />
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

  /**
   * What is wrong with the object, in the two or three lines that say it.
   *
   * The only thing a page still puts above the strip, and the bar is high:
   * it is about the *object* rather than about the Overview, so it is worth
   * seeing while reading Conditions or a log, and it is worth the height it
   * takes from a full-height tab. A pod's problem summary qualifies; a
   * rollout in flight qualifies. A block does not — blocks are what the
   * Overview tab is, and there is no slot here for them any more.
   */
  summary?: ReactNode;

  /**
   * What the object's own query is worth right now, from `useResourceDetail`.
   *
   * Every detail page passes it and the header draws the same reading from it,
   * for the reason `delivery` is a prop on this frame too: a badge that is on
   * eleven pages and missing on the twelfth teaches the reader that the twelfth
   * is live, which is the one thing it must never be able to say by accident.
   */
  freshness?: Freshness;

  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
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
  summary,
  freshness,
  tabs,
  activeTab,
  onTabChange,
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

  // Which of the two the page's height belongs to: the flow, or the pane the
  // open tab is. Nothing above the strip is hidden for it — a banner earned by
  // this object is worth its two lines on a log as much as on the Overview,
  // and it is the tab's own content that grows into what is left.
  const surface = surfaceIsOpen(tabs, activeTab);

  return (
    <CaptionScope kind={resourceKind}>
      <div
        className={cn(
          // 12px rather than the page's 22px: what is left in this column is
          // chrome — identity, then the strip — and the mock's whole gain is
          // that the two read as one band. The 22px rhythm still belongs to
          // the blocks, which the open tab's panel now owns.
          "flex flex-col animate-in fade-in duration-200",
          surface ? "h-full min-h-0 gap-2" : "gap-3"
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
          dataUpdatedAt={freshness?.dataUpdatedAt}
          slowed={freshness?.slowed}
        />

        {/* Above the strip, and so on every tab: both say something about the
            object rather than about a view of it. Usually neither is there at
            all — the delivery line is earned per object, never per managed
            object, and a summary is what a healthy object does not have. */}
        <DeliveryBanner deliveries={deliveries} />
        {summary}

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
