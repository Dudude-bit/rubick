import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { ChangesTimeline } from "@/components/changes/ChangesTimeline";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  helmReleaseOf,
  revisionOfController,
  revisionOfReplicaSet,
  timelineOf,
  type Revision,
} from "@/lib/changes";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveries } from "@/hooks/useDelivery";
import { useNow } from "@/hooks/useNow";
import {
  useCapabilities,
  type DeliveryOwner,
  type DeliveryRevision,
} from "@/integrations";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

const WINDOW_MS = 7 * 24 * 60 * 60_000;
const STALE = 30_000;

export interface ChangesSubject {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  namespace: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

function ownersOf(
  deliveries: ReturnType<typeof useDeliveries>,
  subject: ChangesSubject
): DeliveryOwner[] {
  const query = deliveryOfKind(subject.kind, subject);
  if (!query) return [];
  const seen = new Set<string>();
  return deliveries
    .of({
      group: query.group,
      kind: subject.kind,
      namespace: subject.namespace,
      name: subject.name,
    })
    .flatMap((delivery) => {
      const owner =
        delivery.state === "delivered" ? delivery.source.owner : delivery.owner;
      if (!owner) return [];
      const key = `${owner.kind}/${owner.namespace}/${owner.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [owner];
    });
}

export function ChangesTab({ subject }: { subject: ChangesSubject }) {
  const t = useT();
  const [params] = useSearchParams();
  const since = params.get("since");
  const sinceMs = since ? Date.parse(since) : NaN;
  const now = useNow();
  const context = useClusterStore((s) => s.currentContext);

  const revisions = useQuery({
    queryKey: [
      context,
      "changes",
      "revisions",
      subject.kind,
      subject.namespace,
      subject.name,
    ],
    queryFn: async (): Promise<Revision[]> => {
      try {
        if (subject.kind === "Deployment") {
          const list = await commands.getDeploymentReplicasets(
            subject.name,
            subject.namespace
          );
          return list.map(revisionOfReplicaSet);
        }
        const list = await commands.getControllerRevisions(
          subject.kind,
          subject.name,
          subject.namespace
        );
        return list.map(revisionOfController);
      } catch (error) {
        throw normalizeTauriError(error);
      }
    },
    staleTime: STALE,
  });

  const deliveryQuery = useMemo(
    () => deliveryOfKind(subject.kind, subject),
    [subject]
  );
  const deliveries = useDeliveries(deliveryQuery ? [deliveryQuery] : []);
  const owners = ownersOf(deliveries, subject);
  const historians = useCapabilities("delivery.history");
  const histories = useQueries({
    queries: owners.map((owner) => ({
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
      staleTime: STALE,
      enabled: historians.length > 0,
    })),
  });

  const release = helmReleaseOf(subject.annotations, subject.namespace);
  const helm = useQuery({
    queryKey: [context, "changes", "helm", release?.namespace, release?.name],
    queryFn: () => commands.getHelmHistory(release!.name, release!.namespace),
    enabled: release !== null,
    staleTime: STALE,
  });

  const journal = useChangeJournalStore((s) => s.entries);
  const spans = useChangeJournalStore((s) => s.spans);

  const items = useMemo(
    () =>
      timelineOf({
        revisions: revisions.data ?? [],
        deliveries: histories.flatMap((h) => h.data ?? []),
        helm: helm.data ?? [],
        journal: journal.filter(
          (entry) =>
            entry.context === context &&
            entry.kind === subject.kind &&
            entry.namespace === subject.namespace &&
            entry.name === subject.name
        ),
        spans: context ? (spans[context] ?? []) : [],
        window: { from: now - WINDOW_MS, to: now },
      }),
    [
      revisions.data,
      histories,
      helm.data,
      journal,
      spans,
      context,
      subject,
      now,
    ]
  );

  const unread: string[] = [];
  if (revisions.error)
    unread.push(
      t("changes", "revisionsUnread", {
        reason: normalizeTauriError(revisions.error),
      })
    );
  histories.forEach((h, index) => {
    if (h.error)
      unread.push(
        t("changes", "historyUnread", {
          owner: `${owners[index].kind} ${owners[index].name}`,
          reason: normalizeTauriError(h.error),
        })
      );
  });
  if (helm.error && release)
    unread.push(
      t("changes", "helmUnread", {
        release: release.name,
        reason: normalizeTauriError(helm.error),
      })
    );

  return (
    <Section>
      <SectionHeader
        title={t("changes", "title")}
        count={items.filter((i) => i.kind !== "gap").length}
      />
      <SectionBody>
        {unread.map((line) => (
          <p key={line} className="px-1.5 py-1 text-xs text-warn">
            {line}
          </p>
        ))}
        {Number.isFinite(sinceMs) ? (
          <p className="px-1.5 pb-1 text-[11px] text-fg-fnt">
            {items.some((i) => i.at !== null && i.at >= sinceMs)
              ? t("changes", "sinceMarker")
              : t("changes", "sinceNothing", {
                  when: new Date(sinceMs).toLocaleString(),
                })}
          </p>
        ) : null}
        <ChangesTimeline
          items={items}
          since={Number.isFinite(sinceMs) ? sinceMs : null}
        />
        <p className="px-1.5 pt-2 text-[11px] text-fg-fnt">
          {t("changes", "explained")}
        </p>
      </SectionBody>
    </Section>
  );
}
