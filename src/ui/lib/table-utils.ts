/**
 * Table Utilities
 *
 * Utility functions for working with TanStack Table.
 *
 * @module lib/table-utils
 */

/**
 * One row's id: its uid, or its namespace and name where the row carries
 * none, joined by the one character neither can hold. A hyphen is in both,
 * so `data-sync`/`nightly` and `data`/`sync-nightly` were one row.
 */
export function getResourceRowId<
  T extends { name: string; namespace?: string | null; uid?: string },
>(row: T): string {
  if ("uid" in row && row.uid) {
    return row.uid;
  }
  return `${row.namespace ?? ""}/${row.name}`;
}
