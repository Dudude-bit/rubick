/**
 * Who calls a workload and whom it calls, from the same reading the Traffic
 * page draws. Not drawn where no supplier is connected or none of its
 * sources has series: one line of advice per page would be a nag.
 */
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";

import { useShareSection } from "@/components/share/screen-share";
import { Section, SectionHeader } from "@/components/ui/section";
import type { WorkloadKey } from "@/generated/types";
import { useTraffic, type TrafficState } from "@/hooks/useTraffic";
import { useT } from "@/i18n/useT";
import { crdInGroup, objectLink } from "@/lib/links";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { isEnd, shareTone, type FlowRow } from "@/lib/traffic";
import { cn } from "@/lib/utils";
import { AskAgain } from "../-supplier/AskAgain";
import { WINDOW_WORD } from "./traffic-words";
import { TONE_TEXT } from "../-map/tone-classes";
import {
  cronJobOf,
  type Owned,
  rateUnread,
  rowWords,
  subjectNotes,
  subjectOf,
  trafficSection,
} from "./workload-traffic-words";

/** Where `rowWords` puts the rate and the share of errors, after the name. */
const RATE_PART = 0;
const ERRORS_PART = 1;

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
          crd: crdInGroup(end.key, crdFor),
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
        {rest
          .map((part, at) => ({ part, at }))
          .filter(({ part }) => part)
          .map(({ part, at }, shown) => (
            <Fragment key={at}>
              {shown > 0 && " · "}
              {at === ERRORS_PART ? (
                <span className={TONE_TEXT[shareTone(row.errorShare)]}>
                  {part}
                </span>
              ) : at === RATE_PART && rateUnread(row) ? (
                <span className="text-warn">{part}</span>
              ) : (
                part
              )}
            </Fragment>
          ))}
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
  owners?: readonly Owned[];
  frame?: Frame;
}) {
  if (props.kind === "Job" && !props.owners) return null;
  const cron = props.kind === "Job" ? cronJobOf(props.owners ?? []) : null;
  const subject = cron
    ? subjectOf("CronJob", props.namespace, cron)
    : subjectOf(props.kind, props.namespace, props.name);
  return subject ? (
    <WorkloadTraffic
      subject={subject}
      viaCronJob={cron !== null}
      frame={props.frame}
    />
  ) : null;
}

export function WorkloadTraffic({
  subject,
  viaCronJob = false,
  frame,
}: {
  subject: WorkloadKey;
  viaCronJob?: boolean;
  frame?: Frame;
}) {
  const state = useTraffic({
    scope: [subject.namespace],
    window: "5m",
    subject,
    refresh: "steady",
  });
  return (
    <Block
      state={state}
      subject={subject}
      viaCronJob={viaCronJob}
      frame={frame}
    />
  );
}

/** How the block is set: a section of a page, or a group of the peek. */
export type Frame = (
  title: string,
  caption: string | undefined,
  body: ReactNode
) => ReactNode;

const SECTION: Frame = (title, caption, body) => (
  <Section>
    <SectionHeader title={title} count={caption} />
    {body}
  </Section>
);

export function Block({
  state,
  subject,
  viaCronJob = false,
  frame = SECTION,
}: {
  state: TrafficState;
  subject: WorkloadKey;
  /** The subject is the CronJob that made the page's Job. */
  viaCronJob?: boolean;
  frame?: Frame;
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
      return frame(
        t("traffic", "title"),
        undefined,
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
      );
    case "reading":
      return frame(
        t("traffic", "title"),
        t("traffic", "reading", { endpoint: state.endpoint }),
        null
      );
    case "read":
      return frame(
        t("traffic", "title"),
        t("traffic", "blockCaption", {
          sources: state.reading.sources
            .map((source) => source.name)
            .join(", "),
          endpoint: state.endpoint,
          window,
        }),
        <>
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
        </>
      );
  }
}
