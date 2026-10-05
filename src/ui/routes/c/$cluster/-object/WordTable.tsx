import type { WordCell, WordTable as Table } from "../-peek/peek-sources-kit";
import { cn } from "@/lib/utils";

/** Rows of words under field-name headers: an RBAC rule, read across. */
export function WordTable({
  table,
  emptyMessage,
}: {
  table: Table;
  emptyMessage: string;
}) {
  if (table.rows.length === 0)
    return <p className="py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-hair py-1 pr-3 text-left font-mono text-[11px] font-normal text-fg-fnt"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index} className="border-b border-hair last:border-b-0">
              {row.map((cell, column) => (
                <td key={column} className="py-1 pr-3 align-top">
                  <Words cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Words({ cell }: { cell: WordCell }) {
  if (cell.words.length === 0)
    return cell.none ? <span className="text-fg-fnt">{cell.none}</span> : null;
  return (
    <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
      {cell.words.map((word) => (
        <span
          key={word}
          className={cn(
            "font-mono",
            word === "*" ? "font-semibold text-warn" : "text-fg"
          )}
        >
          {word}
        </span>
      ))}
    </span>
  );
}
