/**
 * Unified hook for resource detail pages
 *
 * Provides common functionality for all detail pages including:
 * - Resource data fetching with loading/error states
 * - YAML fetching for YAML tab
 * - Tab management
 * - Navigation helpers
 * - Copy to clipboard
 */

import { useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useLiveQuery, type Freshness } from "@/hooks/useLiveQuery";
import { useResourceYaml } from "./useResourceYaml";
import { STALE_TIMES, type RefreshRate } from "@/lib/refresh";
import { useT } from "@/i18n/useT";

export interface UseResourceDetailOptions<T> {
  /** Resource kind for YAML command (e.g., "Pod", "Deployment") */
  resourceKind: string;
  /** Whether this is a cluster-scoped resource (no namespace) */
  isClusterScoped?: boolean;
  /** Function for fetching resource */
  fetchResource: (name: string, namespace: string | null) => Promise<T>;
  /** Function for deleting resource */
  deleteResource?: (name: string, namespace: string | null) => Promise<void>;
  /** Optional callback when resource is fetched */
  onResourceFetched?: (resource: T) => void;
  /** Optional callback after successful deletion */
  onDeleted?: () => void;
  /** Enable placeholder data for smoother transitions */
  placeholderData?: boolean;
  /** Default tab to show */
  defaultTab?: string;
  /** Which rate this re-reads at, or `false` for a watch-fed page. */
  refresh?: RefreshRate | false;
  /** Override stale time */
  staleTime?: number;
}

export interface UseResourceDetailResult<T> {
  // Route params
  name: string | undefined;
  namespace: string | undefined;

  // Resource data
  resource: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  /** What the header's freshness reading is drawn from. */
  freshness: Freshness;

  // YAML data
  yaml: string | undefined;
  isLoadingYaml: boolean;
  copyYaml: () => void;
  refetchYaml: () => Promise<unknown>;

  // Tab management
  activeTab: string;
  setActiveTab: (tab: string) => void;

  // Navigation
  goBack: () => void;
  navigate: ReturnType<typeof useNavigate>;

  deleteMutation: ReturnType<typeof useMutation<void, Error, void>> | null;

  // Toast
  toast: ReturnType<typeof useToast>["toast"];

  // Clipboard
  copyToClipboard: ReturnType<typeof useCopyToClipboard>;
}

/**
 * Hook for resource detail pages with common functionality
 */
export function useResourceDetail<T>(
  options: UseResourceDetailOptions<T>
): UseResourceDetailResult<T> {
  const t = useT();
  const {
    resourceKind,
    isClusterScoped = false,
    fetchResource,
    deleteResource,
    onResourceFetched,
    onDeleted,
    placeholderData = true,
    defaultTab = "overview",
    refresh = "resourceDetail",
    staleTime = STALE_TIMES.resourceDetail,
  } = options;

  // For cluster-scoped resources, namespace won't be in the URL
  const { namespace: nsParam, name } = useParams<{
    namespace?: string;
    name: string;
  }>();
  const namespace = isClusterScoped ? undefined : nsParam;
  const navigate = useNavigate();
  const { toast } = useToast();
  const copyToClipboard = useCopyToClipboard();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState(defaultTab);

  // Fetch resource data
  const {
    data: resource,
    isLoading,
    isPlaceholderData,
    error: readError,
    refetch,
    freshness,
  } = useLiveQuery<T, Error, T, string[]>({
    queryKey: [resourceKind.toLowerCase(), namespace, name] as string[],
    queryFn: async () => {
      if (!name) throw new Error("Name is required");
      const result = await fetchResource(name, namespace || null);
      onResourceFetched?.(result);
      return result;
    },
    enabled: !!name,
    placeholderData: placeholderData ? keepPreviousData : undefined,
    staleTime,
    refresh,
  });

  // A failed re-read of the object already on screen is not a page.
  //
  // `ResourceDetailLayout` replaces the whole page with "Could not read this
  // pod" for any error, so one dropped poll — an expiring token, a blip
  // between the app and the API server — threw away a page the reader was
  // working in, and the next poll two seconds later brought it back. The rule
  // is the list's: an error only speaks when there is nothing left to show,
  // and the header's freshness reading is what says the page is going stale.
  //
  // `isPlaceholderData` is the whole distinction. It marks data belonging to
  // the *previous* name — the reader has navigated, and holding a pod's fields
  // under another pod's URL because the new one 404'd is the one thing this
  // must never do. Then the error is the page.
  const holdsThisObject = resource !== undefined && !isPlaceholderData;
  const error = holdsThisObject ? null : readError;

  // Always use useResourceYaml for YAML fetching
  const {
    data: yaml,
    isLoading: isLoadingYaml,
    refetch: refetchYaml,
  } = useResourceYaml(resourceKind, name, namespace, activeTab);

  const copyYaml = useCallback(() => {
    if (yaml) {
      copyToClipboard(yaml, t("action", "yamlCopied"));
    }
  }, [yaml, copyToClipboard, t]);

  const goBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!name || !deleteResource) return;
      await deleteResource(name, namespace || null);
    },
    onSuccess: () => {
      toast({
        title: t("action", "kindDeleted", { kind: resourceKind }),
        description: t("action", "kindDeletedDetail", {
          kind: resourceKind,
          name: name ?? "",
        }),
      });
      queryClient.invalidateQueries({
        queryKey: [resourceKind.toLowerCase()],
      });
      if (onDeleted) {
        onDeleted();
      } else {
        goBack();
      }
    },
    onError: (err) => {
      toast({
        title: t("action", "error"),
        description: t("action", "deleteFailed", {
          kind: resourceKind.toLowerCase(),
          name: name ?? "",
          error: String(err),
        }),
        variant: "destructive",
      });
    },
  });

  return {
    name,
    namespace,
    resource,
    isLoading,
    error,
    refetch,
    freshness,
    yaml,
    isLoadingYaml,
    copyYaml,
    refetchYaml,
    activeTab,
    setActiveTab,
    goBack,
    navigate,
    deleteMutation,
    toast,
    copyToClipboard,
  };
}

/**
 * Check if error indicates resource not found
 */
export function isResourceNotFoundError(error: Error | null | string): boolean {
  if (!error) return false;
  const errorStr = String(error);
  return errorStr.includes("not found") || errorStr.includes("NotFound");
}
