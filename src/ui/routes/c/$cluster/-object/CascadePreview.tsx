import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import {
  mightHold,
  readingOf,
  servedOfKind,
  useCascade,
  useLineage,
} from "./ownership";

/**
 * What deleting this object takes with it, counted from the ownership index
 * as the garbage collector decides. Never silent: a count it could not work
 * out is said, and kinds nobody could read are named as "possibly".
 */
export function CascadePreview({
  kind,
  name,
  namespace,
}: {
  kind: string;
  name: string;
  namespace?: string | null;
}) {
  const t = useT();
  const lineage = useLineage(servedOfKind(kind), name, namespace);
  const uid = lineage.data?.uid ?? null;
  const cascade = useCascade(uid, true);

  const failure = lineage.error ?? (cascade.data ? null : cascade.error);
  if (failure)
    return (
      <p className="text-xs text-err">
        {t("cascade", "failed", { error: errorToShow(failure) })}
      </p>
    );
  if (!cascade.data)
    return <p className="text-xs text-fg-mut">{t("cascade", "working")}</p>;

  const { takes, notRead } = cascade.data;
  const unread = notRead.kinds.filter(mightHold);
  return (
    <div className="flex flex-col gap-1 text-xs" aria-live="polite">
      {takes.length > 0 ? (
        <p className="text-fg">
          {t("cascade", "takes")}{" "}
          {takes.map((count) => (
            <span
              key={`${count.group}/${count.plural}`}
              className="mr-2 font-mono"
            >
              {count.kind} ×{count.count}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-fg-mut">{t("cascade", "nothing")}</p>
      )}
      {(unread.length > 0 || notRead.groups.length > 0) && (
        <p className="text-warn">
          {t("cascade", "possibly", {
            kinds: [
              ...unread.map((reading) => readingOf(reading, t)),
              ...notRead.groups.map((group) => group.group),
            ].join(", "),
          })}
        </p>
      )}
    </div>
  );
}
