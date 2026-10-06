import { Fragment } from "react";
import { ShieldAlert } from "lucide-react";

import type { WordCell, WordTable as Table } from "../-peek/peek-sources-kit";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

/** Rows of words under field-name headers: an RBAC rule, read across. */
export function WordTable({
  table,
  emptyMessage,
}: {
  table: Table;
  emptyMessage: string;
}) {
  const t = useT();
  if (table.rows.length === 0)
    return <p className="py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  const escalates = table.rows.some((row) =>
    row.some((cell) => cell.escalating?.length)
  );
  return (
    <div className="flex flex-col gap-1.5">
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
      {escalates && (
        <p className="flex items-start gap-1.5 text-[11px] text-fg-mut">
          <ShieldAlert
            className="mt-px h-3 w-3 flex-none text-err"
            aria-hidden
          />
          {t("rbac", "escalationNote")}
        </p>
      )}
    </div>
  );
}

function Words({ cell }: { cell: WordCell }) {
  const t = useT();
  if (cell.words.length === 0)
    return cell.none ? <span className="text-fg-fnt">{cell.none}</span> : null;
  return (
    <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
      {cell.words.map((word) => {
        const escalating = cell.escalating?.includes(word);
        const said = escalating
          ? t("rbac", "escalates")
          : word === "*"
            ? t("rbac", "wildcard")
            : undefined;
        return (
          <span
            key={word}
            title={said}
            className={cn(
              "inline-flex items-center gap-0.5 font-mono",
              escalating
                ? "font-semibold text-err"
                : word === "*"
                  ? "font-semibold text-warn"
                  : "text-fg"
            )}
          >
            {escalating && (
              <ShieldAlert className="h-3 w-3 flex-none" aria-hidden />
            )}
            <Breakable word={word} />
            {said && <span className="sr-only">{`, ${said}`}</span>}
          </span>
        );
      })}
    </span>
  );
}

/**
 * `rbac.authorization.k8s.io` may wrap after a dot or a slash. Unbroken, it
 * pushed the verbs column past the peek's edge and cut "escalate".
 */
function Breakable({ word }: { word: string }) {
  return word.split(/(?<=[./])/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}
