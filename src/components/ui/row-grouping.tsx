import type { ReactNode } from "react";

/**
 * What turns a flat list into captioned runs of it.
 *
 * Namespaces were the first grouping and were wired straight into the table as
 * a boolean; node pools are the second and want a caption carrying machine
 * type, zones and a spot mark rather than a count. Two callers is where the
 * boolean stops paying and a descriptor starts.
 */
export interface RowGrouping<TData> {
  /**
   * The group this row belongs in, or null when the data does not say — a
   * self-managed node beside a managed pool, say. Ungrouped rows are drawn
   * first and without a caption, because "we know nothing about these" is not
   * a group and heading them "ungrouped" would be a claim.
   */
  keyOf: (row: TData) => string | null;
  caption: (key: string, rows: TData[]) => ReactNode;
  /** Column ids the caption has made redundant. */
  hides?: string[];
  /**
   * Below this many groups the captions say nothing the reader did not
   * already know. Namespaces need two — a caption repeating the scope the
   * reader just picked is noise — while one node pool still earns its caption,
   * because the machine type and the zones in it are stated nowhere else.
   */
  minGroups?: number;
}

/** Namespaces are the one grouping key every namespaced resource shares. */
export function byNamespace<TData>(rowLabel: string): RowGrouping<TData> {
  return {
    keyOf: (row) => {
      const ns = (row as { namespace?: string | null } | null)?.namespace;
      return typeof ns === "string" && ns.length > 0 ? ns : null;
    },
    caption: (ns, rows) => (
      <>
        {ns}{" "}
        <span className="font-mono text-fg-mut">
          ·{" "}
          {`${rows.length} ${rows.length === 1 ? rowLabel.replace(/s$/, "") : rowLabel}`}
        </span>
      </>
    ),
    // The caption carries the namespace, so the column beneath it would say
    // the same word on every row.
    hides: ["namespace"],
    minGroups: 2,
  };
}
