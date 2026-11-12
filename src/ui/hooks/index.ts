/**
 * Hooks - Unified exports
 */

// Resource hooks
export {
  useResource,
  useResourceList,
  useResourceMutation,
  type UseResourceOptions,
  type MutationToastConfig,
  type UseResourceMutationOptions,
} from "./useResource";

// Detail page hook
export {
  useResourceDetail,
  isResourceNotFoundError,
} from "./useResourceDetail";

// Specialized hooks
export { useResourceYaml } from "./useResourceYaml";
export { useCopyToClipboard } from "./useCopyToClipboard";
export { usePodsWithMetrics, type PodWithMetrics } from "./usePodsWithMetrics";
export { useMetrics } from "./useMetrics";

// Real-time updates
export { useRealtimeAge, useRealtimeCountdown } from "./useRealtimeAge";
export type { CountdownResult } from "./useRealtimeAge";

// Cluster info
export { useClusterInfo } from "./useClusterInfo";

// Debug operations
export {
  useDebugOperation,
  type DebugOperationState,
} from "./useDebugOperation";
