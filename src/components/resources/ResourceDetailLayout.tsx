/**
 * ResourceDetailLayout - Unified layout for resource detail pages
 *
 * Provides common structure for detail pages including:
 * - Loading state with skeleton
 * - Error state with navigation
 * - Consistent layout structure
 */

import type { ReactNode } from "react";
import type { ConditionInfo } from "@/generated/types";
import { Button } from "@/components/ui/button";
import { DetailSkeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { LabelsDisplay } from "./LabelsDisplay";
import { ConditionsDisplay } from "./ConditionsDisplay";
import { ArrowLeft, AlertCircle, RefreshCw } from "lucide-react";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";

/**
 * Error state for detail pages
 */
interface DetailErrorProps {
  /** Error object or message */
  error: Error | string | null;
  /** Resource kind for display */
  resourceKind: string;
  /** Go back callback */
  onBack: () => void;
  /** Optional: Action to find replacement */
  onFindReplacement?: () => void;
  /** Is searching for replacement */
  isSearching?: boolean;
  /** Additional message */
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

  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <AlertCircle className="h-12 w-12 text-err" />
      <p className="text-err text-lg font-medium">
        {isNotFound
          ? `${resourceKind} not found`
          : `Failed to load ${resourceKind.toLowerCase()} details`}
      </p>
      {isNotFound && (
        <p className="text-fg-mut text-sm">
          The {resourceKind.toLowerCase()} may have been deleted or recreated
        </p>
      )}
      {additionalMessage && (
        <p className="text-fg-mut text-sm">{additionalMessage}</p>
      )}
      {isSearching && (
        <div className="flex items-center gap-2 text-fg-mut">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Looking for replacement...</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Go Back
        </Button>
        {isNotFound && onFindReplacement && (
          <Button onClick={onFindReplacement} disabled={isSearching}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${isSearching ? "animate-spin" : ""}`}
            />
            {isSearching ? "Searching..." : "Find Replacement"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Info row component for displaying key-value pairs
 */
interface InfoRowProps {
  label: string;
  value: ReactNode;
  className?: string;
}

export function InfoRow({ label, value, className }: InfoRowProps) {
  return (
    <div
      className={`flex justify-between items-center py-1 ${className ?? ""}`}
    >
      <span className="text-sm text-fg-mut">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

/**
 * Titled group of related info on the flat canvas.
 */
interface InfoCardProps {
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

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

/**
 * Tab definition for resource detail tabs
 */
export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Props for ResourceDetailLayout
 */
interface ResourceDetailLayoutProps {
  /** Resource data */
  resource: unknown;
  /** Is loading */
  isLoading: boolean;
  /** Error state */
  error: Error | string | null;
  /** Resource kind for display */
  resourceKind: string;

  /** Header title */
  title: string;
  /** Namespace */
  namespace?: string;
  /** Status badge */
  statusBadge?: ReactNode;
  /** Additional badges */
  badges?: ReactNode;
  /** Action buttons */
  actions?: ReactNode;
  /** Header icon */
  icon?: ReactNode;

  /** Go back callback */
  onBack: () => void;
  /** Find replacement callback (for pods) */
  onFindReplacement?: () => void;
  /** Is searching for replacement */
  isSearchingReplacement?: boolean;

  /** Tab definitions */
  tabs: DetailTab[];
  /** Active tab */
  activeTab: string;
  /** Set active tab */
  onTabChange: (tab: string) => void;

  /** Labels for LabelsDisplay */
  labels?: Record<string, string>;
  /** Annotations for display */
  annotations?: Record<string, string>;
  /** Conditions for ConditionsDisplay */
  conditions?: ConditionInfo[];

  /** Additional content below tabs */
  children?: ReactNode;
}

/**
 * Unified layout component for resource detail pages
 */
export function ResourceDetailLayout({
  resource,
  isLoading,
  error,
  resourceKind,
  title,
  namespace,
  statusBadge,
  badges,
  actions,
  icon,
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
  // Loading state
  if (isLoading) {
    return <DetailSkeleton />;
  }

  // Error state
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

  // Build combined badges
  const allBadges = (
    <>
      {statusBadge}
      {badges}
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <ResourceDetailHeader
        title={title}
        namespace={namespace}
        badges={allBadges}
        actions={actions}
        onBack={onBack}
        icon={icon}
      />

      {/* Additional children (Info Cards, etc.) */}
      {children}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Tab contents */}
        {tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="space-y-6">
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>

      {/* Labels section (if on overview tab and labels exist) */}
      {activeTab === "overview" && labels && Object.keys(labels).length > 0 && (
        <LabelsDisplay labels={labels} title="Labels" />
      )}

      {/* Annotations section */}
      {activeTab === "overview" &&
        annotations &&
        Object.keys(annotations).length > 0 && (
          <LabelsDisplay labels={annotations} title="Annotations" />
        )}

      {/* Conditions section */}
      {activeTab === "overview" && conditions && conditions.length > 0 && (
        <ConditionsDisplay conditions={conditions} />
      )}
    </div>
  );
}

export default ResourceDetailLayout;
