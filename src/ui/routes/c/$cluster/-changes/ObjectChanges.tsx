import { useMemo, useState, type ReactNode } from "react";

import { ChangesTimeline } from "./ChangesTimeline";
import { ShowFilter } from "./ShowFilter";
import { keepingWords } from "./changes-share";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import type { HelmRevision, Show } from "@/generated/types";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { normalizeTauriError, errorToShow } from "@/lib/error-utils";
import { formatWhen } from "@/lib/utils";
import {
  changesCount,
  coverageOf,
  helmReleaseOf,
  revisionOfController,
  revisionOfReplicaSet,
  REVISED_KINDS,
  spansFor,
  timelineOf,
  windowEnd,
  type Revision,
} from "@/lib/changes";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveries, useDeliveryIntercept } from "../-delivery/useDelivery";
import { useRollback } from "../-object/useRollback";
import { useHeldRead } from "@/hooks/useHeldRead";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";
import { useNow } from "@/hooks/useNow";
import { useAppSearch } from "@/hooks/useSearchParam";
import { useTimeline, useTimelineHold } from "@/hooks/useTimeline";
import {
  useCapabilities,
  type DeliveryOwner,
  type DeliveryRevision,
} from "@/integrations";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

const WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The object a Changes tab is about. */
export interface ObjectChangesSubject {
  kind: string;
  /** Where a kind's name alone does not say which kind it is. */
  group?: string | null;
  name: string;
  namespace: string | null;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  createdAt: string | null;
}

type RevisedKind = (typeof REVISED_KINDS)[number];

const isRevised = (kind: string): kind is RevisedKind =>
  (REVISED_KINDS as readonly string[]).includes(kind);

/**
 * One object's Changes tab: what the timeline recorded of it and the
 * cluster's events about it, and for a workload its controller's revisions,
 * its delivery owner's history and Helm's beside them, on one clock.
 */
export function ObjectChanges({ subject }: { subject: ObjectChangesSubject }) {
  const revised = subject.kind;
  return isRevised(revised) ? (
    <RevisedChanges subject={{ ...subject, kind: revised }} />
  ) : (
    <ChangesPanel subject={subject} />
  );
}

/**
 * The owners whose history is this object's history.
 *
 * A `claimed` delivery is the object carrying a label the owner does not
 * answer for — drawing that owner's commits here would say this object was
 * delivered by something that does not list it. The owner is still worth
 * naming, so it comes back marked rather than dropped.
 */
interface Claim {
  owner: DeliveryOwner;
  /** The owner lists this object back. */
  listed: boolean;
}

function ownersOf(
  deliveries: ReturnType<typeof useDeliveries>,
  subject: ObjectChangesSubject
): Claim[] {
  const query = deliveryOfKind(subject.kind, subject);
  if (!query) return [];
  const seen = new Set<string>();
  return deliveries
    .of({
      group: query.group,
      kind: subject.kind,
      namespace: subject.namespace ?? "",
      name: subject.name,
    })
    .flatMap((delivery) => {
      const listed = delivery.state === "delivered";
      const owner = listed ? delivery.source.owner : delivery.owner;
      if (!owner) return [];
      const key = `${owner.kind}/${owner.namespace}/${owner.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ owner, listed }];
    });
}

function RevisedChanges({
  subject,
}: {
  subject: ObjectChangesSubject & { kind: RevisedKind };
}) {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const namespace = subject.namespace ?? "";
  const revisionsKey = [
    context,
    "changes",
    "revisions",
    subject.kind,
    namespace,
    subject.name,
  ];
  const revisionsRead = useLiveQuery({
    // The rate the page's header and Revisions read the same fact at: which
    // revision is current decides what Roll back offers and compares with.
    refresh: "resourceList",
    queryKey: revisionsKey,
    queryFn: async (): Promise<Revision[]> => {
      try {
        if (subject.kind === "Deployment") {
          const list = await commands.getDeploymentReplicasets(
            subject.name,
            namespace
          );
          return list.map(revisionOfReplicaSet);
        }
        const list = await commands.getControllerRevisions(
          subject.kind,
          subject.name,
          namespace
        );
        return list.map(revisionOfController);
      } catch (error) {
        throw new Error(normalizeTauriError(error), { cause: error });
      }
    },
  });
  const revisions = useHeldRead(
    subject.kind,
    namespace,
    subject.name,
    revisionsRead,
    revisionsKey
  );

  const delivered = useMemo(
    () => ({
      kind: subject.kind,
      name: subject.name,
      namespace,
      labels: subject.labels ?? {},
      annotations: subject.annotations ?? {},
    }),
    [subject.kind, subject.name, namespace, subject.labels, subject.annotations]
  );
  const deliveryQuery = useMemo(
    () => deliveryOfKind(subject.kind, delivered),
    [subject.kind, delivered]
  );
  const deliveries = useDeliveries(deliveryQuery ? [deliveryQuery] : []);
  const intercept = useDeliveryIntercept(deliveryQuery);
  const rollback = useRollback({
    subject: { kind: subject.kind, name: subject.name, namespace },
    revisions: revisions.data ?? [],
    intercept: intercept(t("action", "rollBack")),
  });
  const claims = ownersOf(deliveries, subject);
  const listed = claims.filter((claim) => claim.listed);
  const historians = useCapabilities("delivery.history");
  const histories = useLiveQueries<DeliveryRevision[]>({
    refresh: "steady",
    queries: listed.map(({ owner }) => ({
      queryKey: [
        context,
        "changes",
        "history",
        owner.kind,
        owner.namespace,
        owner.name,
      ],
      queryFn: async (): Promise<DeliveryRevision[]> => {
        const answers = await Promise.all(historians.map((ask) => ask(owner)));
        return answers.flatMap((answer) => answer ?? []);
      },
      enabled: historians.length > 0,
    })),
  });

  const release = helmReleaseOf(subject.annotations ?? {}, namespace);
  // Under the prefix every Helm mutation invalidates. A second key for the
  // same fact is a copy that invalidation cannot reach.
  const helm = useLiveQuery({
    refresh: "steady",
    queryKey: queryKeys.helm.history(release?.namespace, release?.name),
    queryFn: () => commands.getHelmHistory(release!.name, release!.namespace),
    enabled: release !== null,
  });

  const unread: string[] = [];
  if (revisions.error)
    unread.push(
      t("changes", "revisionsUnread", {
        reason: errorToShow(revisions.error),
      })
    );
  if (deliveries.error)
    unread.push(
      t("changes", "deliveriesUnread", {
        reason: errorToShow(deliveries.error),
      })
    );
  if (histories.error)
    unread.push(
      t("changes", "historyUnread", {
        owner: listed
          .map(({ owner }) => `${owner.kind} ${owner.name}`)
          .join(", "),
        reason: errorToShow(histories.error),
      })
    );
  for (const { owner } of claims.filter((claim) => !claim.listed))
    unread.push(
      t("changes", "claimedOwner", { owner: `${owner.kind} ${owner.name}` })
    );
  if (helm.error && release)
    unread.push(
      t("changes", "helmUnread", {
        release: release.name,
        reason: errorToShow(helm.error),
      })
    );

  return (
    <ChangesPanel
      subject={subject}
      revisions={revisions.data}
      deliveries={histories.data}
      helm={helm.data}
      unread={unread}
      onRollback={rollback.offer}
      rollbackDenied={rollback.denied}
      dialog={rollback.dialog}
    />
  );
}

const NO_REVISIONS: Revision[] = [];
const NO_HELM: HelmRevision[] = [];
const NO_LINES: string[] = [];

/** One object's timeline, with whatever records the kind adds beside it. */
function ChangesPanel({
  subject,
  revisions = NO_REVISIONS,
  deliveries,
  helm = NO_HELM,
  unread = NO_LINES,
  onRollback,
  rollbackDenied,
  dialog,
}: {
  subject: ObjectChangesSubject;
  revisions?: Revision[];
  deliveries?: (DeliveryRevision[] | undefined)[];
  helm?: HelmRevision[];
  unread?: string[];
  onRollback?: (revision: Revision) => void;
  rollbackDenied?: string;
  dialog?: ReactNode;
}) {
  const t = useT();
  const { since } = useAppSearch();
  const sinceMs = since ? Date.parse(since) : NaN;
  const now = useNow();
  const [show, setShow] = useState<Show>("all");
  useTimelineHold();
  const read = useTimeline({
    subject: {
      kind: subject.kind,
      group: subject.group ?? null,
      namespace: subject.namespace,
      name: subject.name,
    },
    windowMs: WINDOW_MS,
    show,
  });
  const spans = spansFor(read.spans, subject.kind);
  const scope = useMemo(
    () => (subject.namespace ? [subject.namespace] : []),
    [subject.namespace]
  );
  const coverage = useMemo(
    () => coverageOf(read.spans, [subject.kind], scope, show),
    [read.spans, subject.kind, scope, show]
  );
  const items = useMemo(
    () =>
      timelineOf({
        revisions,
        deliveries: (deliveries ?? []).flatMap((history) => history ?? []),
        helm,
        journal: read.rows,
        spans: coverage.covering,
        watching: coverage.watching,
        scope,
        window: { from: now - WINDOW_MS, to: windowEnd(spans, now) },
        createdAt: subject.createdAt,
        show,
        letGo: read.letGo,
        readFrom: read.readFrom,
      }),
    [
      revisions,
      deliveries,
      helm,
      read.rows,
      read.letGo,
      read.readFrom,
      coverage,
      spans,
      subject.createdAt,
      scope,
      now,
      show,
    ]
  );
  const watching = spans.find((span) => span.to === null);
  const lines = [...keepingWords(read, t), ...unread];

  return (
    <Section>
      <SectionHeader
        title={t("changes", "title")}
        count={changesCount(items, t) || undefined}
        actions={
          <ShowFilter show={show} onShow={setShow} watching={watching} />
        }
      />
      <SectionBody>
        {lines.map((line) => (
          <p key={line} className="px-1.5 py-1 text-xs text-warn">
            {line}
          </p>
        ))}
        {Number.isFinite(sinceMs) ? (
          <p className="px-1.5 pb-1 text-[11px] text-fg-fnt">
            {items.some((i) => i.at !== null && i.at >= sinceMs)
              ? t("changes", "sinceMarker")
              : t("changes", "sinceNothing", {
                  when: formatWhen(sinceMs, "moment"),
                })}
          </p>
        ) : null}
        {read.isPending ? (
          <p className="px-1.5 py-1 text-xs text-fg-fnt">
            {t("changes", "readingKept")}
          </p>
        ) : (
          <ChangesTimeline
            items={items}
            since={Number.isFinite(sinceMs) ? sinceMs : null}
            onRollback={onRollback}
            rollbackDenied={rollbackDenied}
            revisions={revisions}
            onEnd={read.readFrom === null ? undefined : read.loadOlder}
            empty={
              show === "warnings"
                ? t("changes", "noWarningsInWindow")
                : undefined
            }
          />
        )}
        {dialog}
        <p className="px-1.5 pt-2 text-[11px] text-fg-fnt">
          {t("changes", "explained")}
        </p>
      </SectionBody>
    </Section>
  );
}
