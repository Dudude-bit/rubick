import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";

import type { Cascade } from "@/generated/types";
import { KindIcon } from "@/components/object/KindIcon";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { mightHold, servedOfKind, useCascade, useLineage } from "./ownership";
import { ReadingChips } from "./ReadingChips";
import type { ServedResource } from "./served";

/**
 * What deleting this object takes with it, counted from the ownership index
 * as the garbage collector decides. Never silent: a count it could not work
 * out is said, and kinds nobody could read are named as "possibly".
 */
export function CascadePreview({
  kind,
  name,
  namespace,
  served,
}: {
  kind: string;
  name: string;
  namespace?: string | null;
  served?: ServedResource | null;
}) {
  const t = useT();
  const lineage = useLineage(served ?? servedOfKind(kind), name, namespace);
  const uid = lineage.data?.uid ?? null;
  const cascade = useCascade(uid, true);
  const failure = lineage.error ?? (cascade.data ? null : cascade.error);

  return (
    <div
      className="mt-3 flex flex-col gap-2.5 rounded-md border border-hair bg-raise p-3 text-xs"
      aria-live="polite"
    >
      {failure ? (
        <p className="flex items-start gap-2 text-err">
          <XCircle className="mt-px h-3.5 w-3.5 flex-none" aria-hidden="true" />
          {t("cascade", "failed", { error: errorToShow(failure) })}
        </p>
      ) : !cascade.data ? (
        <p className="flex items-center gap-2 text-fg-mut">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t("cascade", "working")}
        </p>
      ) : (
        <Answer cascade={cascade.data} />
      )}
    </div>
  );
}

function Answer({ cascade: { takes, notRead } }: { cascade: Cascade }) {
  const t = useT();
  const unread = notRead.kinds.filter(mightHold);
  return (
    <>
      {takes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 font-medium text-err">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t("cascade", "takes")}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {takes.map((count) => (
              <li
                key={`${count.group}/${count.plural}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-hair bg-canvas px-2 py-1"
              >
                <KindIcon kind={count.kind} className="h-3 w-3" />
                <span className="font-mono text-fg">{count.kind}</span>
                <span className="font-semibold tabular-nums text-err">
                  {count.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-ok">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("cascade", "nothing")}
        </p>
      )}
      {(unread.length > 0 || notRead.groups.length > 0) && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t("cascade", "possibly")}
          </p>
          <ReadingChips kinds={unread} groups={notRead.groups} />
        </div>
      )}
    </>
  );
}
