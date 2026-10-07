import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Inbox,
  Loader2,
  Trash2,
  Unlink,
  XCircle,
} from "lucide-react";

import type { Cascade, Holds, KindCount, NotRead } from "@/generated/types";
import { KindIcon } from "@/components/object/KindIcon";
import { RouteLink } from "@/components/ui/route-link";
import { useT } from "@/i18n/useT";
import { useConnections } from "@/hooks/useConnections";
import { dependentsOf } from "@/lib/connections";
import { errorToShow } from "@/lib/error-utils";
import { crdInstancesLink } from "@/lib/links";
import { CONNECTED_KINDS } from "@/lib/report-parts";
import {
  holdsContents,
  listing,
  mightHold,
  readAll,
  servedOfKind,
  useCascade,
  useLineage,
} from "./ownership";
import { ReadingChips, ReadingProgress } from "./ReadingChips";
import type { ServedResource } from "./served";

type Defined = Extract<Holds, { says: "objects" }>;

const sameKind = (
  a: { group: string; plural: string },
  b: { group: string; plural: string } | null
) => !!b && a.group === b.group && a.plural === b.plural;

/**
 * What deleting this object takes with it, counted from the ownership index
 * as the garbage collector decides, and what it holds besides: a CRD every
 * object of its kind, a namespace everything inside. Never silent: a count
 * it could not work out is said, and kinds nobody could read are named.
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
  const subject = served ?? servedOfKind(kind);
  const lineage = useLineage(subject, name, namespace);
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
        <Working />
      ) : listing(cascade.data.notRead) > 0 ? (
        <ReadingProgress notRead={cascade.data.notRead} />
      ) : (
        <Answer
          cascade={cascade.data}
          holder={holdsContents(subject) ? subject : null}
        />
      )}
      {!served && CONNECTED_KINDS.has(kind) && (
        <Dependents kind={kind} name={name} namespace={namespace ?? null} />
      )}
    </div>
  );
}

/** What stays after the delete and still names the object, so breaks. */
function Dependents({
  kind,
  name,
  namespace,
}: {
  kind: string;
  name: string;
  namespace: string | null;
}) {
  const t = useT();
  const conns = useConnections(kind, name, namespace);
  if (conns.error)
    return (
      <p className="flex items-start gap-2 text-warn">
        <AlertTriangle
          className="mt-px h-3.5 w-3.5 flex-none"
          aria-hidden="true"
        />
        {t("cascade", "dependentsFailed", { error: errorToShow(conns.error) })}
      </p>
    );
  if (!conns.data)
    return (
      <p className="flex items-center gap-2 text-fg-mut">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("cascade", "dependentsWorking")}
      </p>
    );
  const dependents = dependentsOf(conns.data, t);
  const unread = conns.data.notLookedAt.map((entry) => entry.kind);
  return (
    <>
      {dependents.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="dependents">
          <p className="flex items-center gap-2 font-medium text-warn">
            <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
            {t("cascade", "dependents", { n: dependents.length })}
          </p>
          <ul className="flex flex-col gap-1">
            {dependents.map(({ object, ways }) => (
              <li
                key={`${object.kind}/${object.namespace ?? ""}/${object.name}`}
                className="flex min-w-0 items-baseline gap-1.5"
              >
                <KindIcon
                  kind={object.kind}
                  className="h-3 w-3 flex-none self-center"
                />
                <span className="flex-none font-mono text-fg">
                  {object.kind}
                </span>
                <span className="truncate font-mono text-fg">
                  {object.name}
                </span>
                {ways.length > 0 && (
                  <span className="truncate text-fg-mut">
                    {ways.join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {unread.length > 0 && (
        <p className="flex items-start gap-2 text-warn">
          <AlertTriangle
            className="mt-px h-3.5 w-3.5 flex-none"
            aria-hidden="true"
          />
          {t("cascade", "dependentsUnread", { kinds: unread.join(", ") })}
        </p>
      )}
    </>
  );
}

function Working() {
  const t = useT();
  return (
    <p className="flex items-center gap-2 text-fg-mut">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {t("cascade", "working")}
    </p>
  );
}

function Answer({
  cascade: { takes, notRead, holds },
  holder,
}: {
  cascade: Cascade;
  holder: ServedResource | null;
}) {
  const t = useT();
  const defined = holds?.says === "objects" ? holds : null;
  const rest = takes.filter((count) => !sameKind(count, defined));
  const unread = notRead.kinds
    .filter(mightHold)
    .filter((reading) => !sameKind(reading, defined));
  const holderReading = holder
    ? notRead.kinds.find((reading) => sameKind(reading, holder))
    : undefined;

  return (
    <>
      {holder && !holds && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t("cascade", "holdsUnread")}
          </p>
          {holderReading && <ReadingChips kinds={[holderReading]} />}
        </div>
      )}
      {defined && <DefinedObjects holds={defined} />}
      {rest.length > 0 ? (
        <Counts
          title={
            holds?.says === "namespace"
              ? t("cascade", "inside")
              : t("cascade", "takes")
          }
          counts={rest}
        />
      ) : defined || (holder && !holds) ? null : (
        <Nothing
          notRead={notRead}
          words={
            holds?.says === "namespace"
              ? t("cascade", "insideNothing")
              : t("cascade", "nothing")
          }
        />
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

/** Green only when every kind was read; otherwise it is a hedge, said plainly. */
function Nothing({ notRead, words }: { notRead: NotRead; words: string }) {
  return readAll(notRead) ? (
    <p className="flex items-center gap-2 text-ok">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      {words}
    </p>
  ) : (
    <p className="flex items-center gap-2 text-fg-mut">
      <Inbox className="h-3.5 w-3.5 text-fg-fnt" aria-hidden="true" />
      {words}
    </p>
  );
}

function Counts({ title, counts }: { title: string; counts: KindCount[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-medium text-err">
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {counts.map((count) => (
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
  );
}

/** Every object of the kind a CRD defines: they go, counted or not. */
function DefinedObjects({ holds }: { holds: Defined }) {
  const t = useT();
  const crd = `${holds.plural}.${holds.group}`;
  const kind = holds.kind ?? crd;
  if (!holds.reading && holds.count === 0)
    return (
      <p className="flex items-center gap-2 text-ok">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("cascade", "objectsNone", { kind })}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-medium text-err">
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("cascade", "objectsGo", { kind })}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {!holds.reading ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-hair bg-canvas px-2 py-1">
            <KindIcon kind={kind} className="h-3 w-3" />
            <span className="font-mono text-fg">{kind}</span>
            <span className="font-semibold tabular-nums text-err">
              {holds.count}
            </span>
          </span>
        ) : (
          <>
            <ReadingChips
              kinds={[
                {
                  kind,
                  group: holds.group,
                  plural: holds.plural,
                  reading: holds.reading,
                },
              ]}
            />
            {holds.count > 0 && (
              <span className="text-fg-mut">
                {t("count", "readSoFar", { n: holds.count })}
              </span>
            )}
          </>
        )}
        <RouteLink
          {...crdInstancesLink(crd)}
          className="inline-flex items-center gap-0.5 text-info hover:underline"
        >
          {t("cascade", "openList")}
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </RouteLink>
      </div>
    </div>
  );
}
