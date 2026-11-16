/**
 * Who calls a workload and whom it calls, from the same reading the Traffic
 * page draws. Not drawn where no supplier is connected or none of its
 * sources has series: one line of advice per page would be a nag.
 */
import { Link } from "@tanstack/react-router";

import { useShareSection } from "@/components/share/screen-share";
import { Section, SectionHeader } from "@/components/ui/section";
import type { OwnerReference, WorkloadKey } from "@/generated/types";
import { useTraffic, type TrafficState } from "@/hooks/useTraffic";
import { useT } from "@/i18n/useT";
import { crdInGroup, objectLink } from "@/lib/links";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { isEnd, type FlowRow } from "@/lib/traffic";
import { cn } from "@/lib/utils";
import { AskAgain } from "../../-supplier/AskAgain";
import { WINDOW_WORD } from "../../-traffic/traffic-words";
import {
  cronJobOf,
  rowWords,
  subjectNotes,
  subjectOf,
  trafficSection,
} from "./workload-traffic-words";

function Peer({ row, peer }: { row: FlowRow; peer: "from" | "to" }) {
  const t = useT();
  const { crdFor } = useCrdIndex();
  const end = row[peer];
  const link =
    end.is === "workload"
      ? objectLink({
          kind: end.key.kind,
          name: end.key.name,
          namespace: end.key.namespace,
          crd: crdInGroup(end.key, crdFor) ?? undefined,
        })
      : null;
  const [name, ...rest] = rowWords(row, peer, t);
  return (
    <li className="flex items-baseline gap-3 text-[12px]">
      {link ? (
        <Link
          {...link}
          className="min-w-0 truncate font-mono text-info hover:underline"
        >
          {name}
        </Link>
      ) : (
        <span className="min-w-0 truncate font-mono">{name}</span>
      )}
      <span className="ml-auto shrink-0 font-mono tabular-nums text-fg-mut">
        {rest.filter(Boolean).join(" · ")}
      </span>
    </li>
  );
}

/**
 * The block for a workload page, nothing until the page knows which
 * workload: a Job's, until it knows whether a CronJob made it.
 */
export function WorkloadFlows(props: {
  kind: string;
  namespace: string | null | undefined;
  name: string | null | undefined;
  owners?: readonly OwnerReference[];
}) {
  if (props.kind === "Job" && !props.owners) return null;
  const cron = props.kind === "Job" ? cronJobOf(props.owners ?? []) : null;
  const subject = cron
    ? subjectOf("CronJob", props.namespace, cron)
    : subjectOf(props.kind, props.namespace, props.name);
  return subject ? (
    <WorkloadTraffic subject={subject} viaCronJob={cron !== null} />
  ) : null;
}

export function WorkloadTraffic({
  subject,
  viaCronJob = false,
}: {
  subject: WorkloadKey;
  viaCronJob?: boolean;
}) {
  const state = useTraffic({
    scope: [subject.namespace],
    window: "5m",
    subject,
    refresh: "steady",
  });
  return <Block state={state} subject={subject} viaCronJob={viaCronJob} />;
}

export function Block({
  state,
  subject,
  viaCronJob = false,
}: {
  state: TrafficState;
  subject: WorkloadKey;
  /** The subject is the CronJob that made the page's Job. */
  viaCronJob?: boolean;
}) {
  const t = useT();
  const window = t("traffic", WINDOW_WORD["5m"]);
  const read = state.says === "read" ? state : null;
  const callers = read ? read.rows.filter((row) => isEnd(row.to, subject)) : [];
  const callees = read
    ? read.rows.filter((row) => isEnd(row.from, subject))
    : [];
  const notes = read
    ? [
        ...(viaCronJob
          ? [
              {
                text: t("traffic", "ofCronJob", { name: subject.name }),
                tone: "mute" as const,
              },
            ]
          : []),
        ...subjectNotes(read.reading, subject, window, t),
      ]
    : [];
  useShareSection(read ? "traffic" : null, () =>
    trafficSection(callers, callees, notes, t)
  );

  switch (state.says) {
    case "absent":
    case "checking":
    case "looking":
    case "noSource":
      return null;
    case "unreachable":
    case "failed":
      return (
        <Section>
          <SectionHeader title={t("traffic", "title")} />
          <p className="px-1.5 text-[11.5px] text-err">
            {state.says === "unreachable" ? (
              <>
                {t("traffic", "unreachable", {
                  endpoint: state.power.endpoint,
                  reason: state.power.reason,
                })}{" "}
                <AskAgain power={state.power} />
              </>
            ) : (
              t("traffic", "failed", {
                endpoint: state.endpoint,
                said: state.said,
              })
            )}
          </p>
        </Section>
      );
    case "reading":
      return (
        <Section>
          <SectionHeader
            title={t("traffic", "title")}
            count={t("traffic", "reading", { endpoint: state.endpoint })}
          />
        </Section>
      );
    case "read":
      return (
        <Section>
          <SectionHeader
            title={t("traffic", "title")}
            count={t("traffic", "blockCaption", {
              sources: state.reading.sources
                .map((source) => source.name)
                .join(", "),
              endpoint: state.endpoint,
              window,
            })}
          />
          {state.lastFailed !== null && (
            <p className="px-1.5 text-[11.5px] text-err">
              {t("traffic", "lastFailed", { said: state.lastFailed })}
            </p>
          )}
          {notes.map((note) => (
            <p
              key={note.text}
              className={cn(
                "px-1.5 text-[11.5px]",
                note.tone === "warn" ? "text-warn" : "text-fg-mut"
              )}
            >
              {note.text}
            </p>
          ))}
          {callers.length > 0 && (
            <div className="px-1.5 pt-1">
              <p className="text-[11px] font-medium text-fg-fnt">
                {t("traffic", "callers")}
              </p>
              <ul className="flex flex-col gap-0.5">
                {callers.map((row) => (
                  <Peer key={row.id} row={row} peer="from" />
                ))}
              </ul>
            </div>
          )}
          {callees.length > 0 && (
            <div className="px-1.5 pt-1">
              <p className="text-[11px] font-medium text-fg-fnt">
                {t("traffic", "callees")}
              </p>
              <ul className="flex flex-col gap-0.5">
                {callees.map((row) => (
                  <Peer key={row.id} row={row} peer="to" />
                ))}
              </ul>
            </div>
          )}
        </Section>
      );
  }
}
