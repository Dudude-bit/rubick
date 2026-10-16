/**
 * Table Utilities
 *
 * Utility functions for working with TanStack Table.
 *
 * @module lib/table-utils
 */

/**
 * Generates a stable row ID for a Kubernetes resource.
 * Uses uid if available, otherwise falls back to namespace + name.
 *
 * @param row - Resource object with name and optionally namespace/uid
 * @returns Stable unique identifier for the row
 *
 * @example
 * ```tsx
 * <ResourceList
 *   getRowId={getResourceRowId}
 *   // ...
 * />
 * ```
 */
export function getResourceRowId<
  T extends { name: string; namespace?: string | null; uid?: string },
>(row: T): string {
  // Prefer uid if available (unique within cluster)
  if ("uid" in row && row.uid) {
    return row.uid;
  }
  // Fallback: namespace + name (unique for namespaced resources)
  return `${row.namespace ?? ""}-${row.name}`;
}
