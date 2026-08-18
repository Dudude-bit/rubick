/**
 * Unified Resource Hooks
 *
 * Consolidates common patterns for resource data fetching, mutations, and deletions.
 * Replaces useResourceQuery, useResourceListQuery, useResourceMutation, useResourceListDelete
 * with a unified API.
 */

import {
  useMutation,
  useQueryClient,
  keepPreviousData,
  UseMutationOptions,
} from "@tanstack/react-query";
import { useClusterStore } from "@/stores/clusterStore";
import { useToast } from "@/components/ui/use-toast";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery, type LiveQueryOptions } from "@/hooks/useLiveQuery";

// ============================================================================
// Query Hooks
// ============================================================================

export interface UseResourceOptions<
  TData = unknown,
  TError = Error,
> extends Partial<LiveQueryOptions<TData, TError, TData, string[]>> {
  /** Override the isConnected check */
  ignoreConnection?: boolean;
}

/**
 * Base hook for resource queries with standardized defaults
 *
 * @example
 * const { data, isLoading } = useResource(
 *   ['pod', namespace, name],
 *   () => invoke<PodInfo>('get_pod', { name, namespace })
 * );
 */
export function useResource<TData = unknown, TError = Error>(
  queryKey: string[],
  queryFn: () => Promise<TData>,
  options?: UseResourceOptions<TData, TError>
) {
  const isConnected = useClusterStore((state) => state.isConnected);
  const { ignoreConnection, ...queryOptions } = options ?? {};

  return useLiveQuery<TData, TError, TData, string[]>({
    queryKey,
    queryFn,
    enabled:
      (ignoreConnection || isConnected) && queryOptions?.enabled !== false,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "resourceList",
    ...queryOptions,
  });
}

/**
 * Hook for resource list queries with longer stale time
 *
 * @example
 * const { data: pods } = useResourceList(
 *   ['pods', namespace],
 *   () => invoke<PodInfo[]>('list_pods', { filters: { namespace } })
 * );
 */
export function useResourceList<TData = unknown, TError = Error>(
  queryKey: string[],
  queryFn: () => Promise<TData>,
  options?: UseResourceOptions<TData, TError>
) {
  return useResource(queryKey, queryFn, {
    staleTime: STALE_TIMES.resourceList,
    ...options,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

export interface MutationToastConfig<TData, TVariables> {
  /** Success toast title */
  successTitle: string;
  /** Success toast description (can be function) */
  successDescription?:
    string | ((data: TData, variables: TVariables) => string);
  /** Error message prefix */
  errorPrefix: string;
}

export interface UseResourceMutationOptions<TData, TVariables, TError = Error> {
  /** Toast notification config */
  toast: MutationToastConfig<TData, TVariables>;
  /** Query keys to invalidate on success */
  invalidateQueryKeys?: string[][];
  /** Additional onSuccess callback */
  onSuccess?: (data: TData, variables: TVariables) => void;
  /** Additional onError callback */
  onError?: (error: TError, variables: TVariables) => void;
}

/**
 * Hook for resource mutations with standardized toast notifications and query invalidation
 *
 * @example
 * const deletePod = useResourceMutation(
 *   (name: string) => invoke('delete_pod', { name, namespace }),
 *   {
 *     toast: {
 *       successTitle: 'Pod deleted',
 *       successDescription: 'Pod has been deleted successfully',
 *       errorPrefix: 'Failed to delete pod',
 *     },
 *     invalidateQueryKeys: [['pods']],
 *   }
 * );
 */
export function useResourceMutation<
  TData = unknown,
  TVariables = void,
  TError = Error,
>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseResourceMutationOptions<TData, TVariables, TError>
) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation<TData, TError, TVariables>({
    mutationFn,
    onSuccess: (data, variables) => {
      // Invalidate queries
      if (options.invalidateQueryKeys) {
        options.invalidateQueryKeys.forEach((key) => {
          queryClient.invalidateQueries({ queryKey: key });
        });
      }

      // Show success toast
      const description =
        typeof options.toast.successDescription === "function"
          ? options.toast.successDescription(data, variables)
          : options.toast.successDescription;

      toast({
        title: options.toast.successTitle,
        description,
      });

      // Call additional callback
      options.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      const errorMessage = normalizeTauriError(error);
      toast({
        title: "Error",
        description: `${options.toast.errorPrefix}: ${errorMessage}`,
        variant: "destructive",
      });
      options.onError?.(error, variables);
    },
  } as UseMutationOptions<TData, TError, TVariables>);
}
