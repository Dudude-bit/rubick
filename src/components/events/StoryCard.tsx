import { useState } from "react";
import { useQueries } from "@tanstack/react-query";

import { ResourceRef } from "@/components/resources/ResourceRef";
import { commands } from "@/lib/commands";
import {
  densityOf,
  timelineOf,
  withStatusMarks,
  type DensityBucket,
  type StatusMark,
  type Story,
  type StoryOptions,
  type StoryState,
  type TimelineEntry,
} from "@/lib/event-stories";
import { cn } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { sayWords, spanWords } from "@/i18n/say";
import { useT } from "@/i18n/useT";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import type { en } from "@/i18n/catalogue";

const STATE_LABEL: Record<StoryState, keyof typeof en.readings> = {
  stillHappening: "storyStillHappening",
  settled: "storySettled",
  done: "storyDone",
  unknown: "storyStateUnknown",
};

// `unknown` is drawn neutral, never green: the reassuring colour is the one
// the reader stops looking at, and nothing here established it.
const STATE_TONE: Record<StoryState, string> = {
  stillHappening: "bg-err/15 text-err",
  settled: "bg-warn/15 text-warn",
  done: "bg-ok/15 text-ok",
  unknown: "bg-fg-fnt/15 text-fg-mut",
};

const STATE_EDGE: Record<StoryState, string> = {
  stillHappening: "border-err/50",
  settled: "border-warn/50",
  done: "border-hair",
  unknown: "border-hair",
};

const STATE_LINE: Record<StoryState, string> = {
  stillHappening: "text-err",
  settled: "text-warn",
  done: "text-fg",
  unknown: "text-fg-mut",
};

/** How many of a story's pods the timeline asks about; the rest is said in words. */
const STATUS_PODS = 5;

/**
 * A timeline row's own clock, with the date whenever it is not today.
 *
 * Time of day alone reads as today: a container that last exited at 14:03
 * three days ago — which the pod still remembers and `withStatusMarks` puts
 * on the strip — is indistinguishable from one that exited an hour ago, and a
 * repeat whose first sighting crossed midnight prints an arrow that appears
 * to run backwards. `toLocaleTimeString` also appends AM/PM on an en-US
 * locale, which is why the log viewer built its own 24-hour clock; this is
 * that clock, with a date in front of it where one is needed.
 */
function clockOf(ms: number, now: number): string {
  const at = new Date(ms);
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return time;
  const day = `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")}`;
  return `${day} ${time}`;
}

export function StoryCard({
  story,
  options,
  showNamespace,
}: {
  story: Story;
  options: StoryOptions;
  showNamespace: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lastSeen = useRealtimeAge(
    story.lastAt === null ? null : new Date(story.lastAt).toISOString()
  );
  const span =
    story.firstAt !== null && story.lastAt !== null
      ? spanWords(story.lastAt - story.firstAt, t)
      : null;
  const { subject } = story;

  return (
    <article
      className={cn(
        "rounded border bg-canvas px-3 py-2",
        STATE_EDGE[story.state]
      )}
      // The same sentence the header draws. A hard-coded "Pods" here read
      // English beside a translated label, to the one reader who cannot see
      // the label.
      aria-label={
        subject.kind
          ? `${subject.kind} ${subject.name}`
          : t("readings", "podsOf", { name: subject.name })
      }
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        {subject.kind ? (
          <ResourceRef
            kind={subject.kind}
            name={subject.name}
            namespace={subject.namespace ?? undefined}
            showNamespace={showNamespace}
          />
        ) : (
          <span className="font-mono text-fg">
            {t("readings", "podsOf", { name: subject.name })}
            {showNamespace && subject.namespace ? (
              <span className="ml-1 text-fg-fnt">{subject.namespace}</span>
            ) : null}
          </span>
        )}
        <span
          className={cn(
            "rounded px-1.5 py-px text-[10px] font-medium",
            STATE_TONE[story.state]
          )}
        >
          {t("readings", STATE_LABEL[story.state])}
        </span>
        <span className="ml-auto text-[11px] text-fg-fnt">
          {[
            t("count", "eventsSeen", { n: story.occurrences }),
            span,
            story.lastAt !== null
              ? t("readings", "lastSeen", { ago: lastSeen })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </header>

      <p className={cn("mt-1 text-xs leading-snug", STATE_LINE[story.state])}>
        {sayWords(story.says, t)}
      </p>

      <Strip
        buckets={densityOf(story, options)}
        title={t("readings", "lastSeenStrip")}
      />

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {story.reasons.map((reason) => (
          <span
            key={`${reason.warning}:${reason.reason}`}
            className={cn(
              "font-mono",
              reason.warning ? "text-warn" : "text-fg-mut"
            )}
          >
            {reason.reason}
            <span className="ml-1 text-fg-fnt">×{reason.count}</span>
          </span>
        ))}
        {story.members.length > 1 ? (
          <span className="text-fg-fnt">
            {t("readings", "membersFolded", { n: story.members.length })}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-fg-mut hover:bg-hover hover:text-fg"
        >
          {t("action", open ? "hideTimeline" : "showTimeline")}
        </button>
      </div>

      {subject.byName ? (
        <p className="mt-1 text-[11px] text-fg-fnt">
          {t("readings", "groupedByName")}
        </p>
      ) : null}

      {open ? <Timeline story={story} now={options.now} /> : null}
    </article>
  );
}

function Strip({
  buckets,
  title,
}: {
  buckets: DensityBucket[];
  title: string;
}) {
  const peak = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div
      className="mt-1.5 flex h-4 items-end gap-px"
      role="img"
      aria-label={title}
      title={title}
    >
      {buckets.map((bucket, index) => (
        <span
          key={index}
          className={cn(
            "flex-1 rounded-[1px]",
            // An unread slice is not an empty one. Drawn hollow rather than
            // as the flat hairline a quiet slice gets, so the eye can tell
            // "nothing happened" from "nobody looked".
            !bucket.read
              ? "border border-dashed border-hair bg-transparent"
              : bucket.count === 0
                ? "bg-hair"
                : bucket.worst === "warn"
                  ? "bg-warn"
                  : "bg-fg-fnt"
          )}
          style={{
            height: !bucket.read
              ? "100%"
              : bucket.count === 0
                ? 2
                : `${Math.max(25, (bucket.count / peak) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

function podsOf(story: Story): {
  asked: Array<{ name: string; namespace: string | null }>;
  /** How many of the story's pods were never asked about. */
  skipped: number;
} {
  const all = story.members.filter((member) => member.startsWith("Pod/"));
  return {
    asked: all.slice(0, STATUS_PODS).map((member) => ({
      name: member.slice("Pod/".length),
      namespace: story.subject.namespace,
    })),
    skipped: Math.max(0, all.length - STATUS_PODS),
  };
}

/** The events on one clock, with the pods' remembered exits placed among them. */
function Timeline({ story, now }: { story: Story; now: number }) {
  const t = useT();
  const { asked: pods, skipped } = podsOf(story);
  const statuses = useQueries({
    queries: pods.map((pod) => ({
      // The one key every other reader of a pod uses, so an action that
      // invalidates a pod reaches this clock too.
      queryKey: queryKeys.resourceDetail(
        ResourceType.Pod,
        pod.namespace ?? "",
        pod.name
      ),
      queryFn: () => commands.getPod(pod.name, pod.namespace),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const marks: StatusMark[] = statuses.flatMap((status, index) => {
    const pod = status.data;
    if (!pod) return [];
    return pod.containers.flatMap((container) => {
      const exit = container.lastTerminated;
      if (!exit?.finishedAt) return [];
      return [
        {
          at: Date.parse(exit.finishedAt),
          container: container.name,
          exitCode: exit.exitCode,
          reason: exit.reason,
          pod: pods[index].name,
        },
      ];
    });
  });
  const unread = statuses.filter((s) => s.isError).length;
  const entries = withStatusMarks(timelineOf(story), marks);
  const several = story.members.length > 1;

  return (
    <div className="mt-2 border-t border-hair pt-1.5">
      <ol className="flex flex-col gap-0.5 text-[11px]">
        {entries.map((entry, index) => (
          <TimelineRow
            key={index}
            entry={entry}
            showAbout={several}
            now={now}
          />
        ))}
      </ol>
      {unread > 0 ? (
        <p className="mt-1 text-[11px] text-fg-fnt">
          {t("readings", "podStatusUnread", { n: unread })}
        </p>
      ) : null}
      {/* The clock asks at most `STATUS_PODS` pods. A story of forty pods
          drew five exits and looked complete; the ones nobody asked about
          are said in the same breath as the ones that refused. */}
      {skipped > 0 ? (
        <p className="mt-1 text-[11px] text-fg-fnt">
          {t("readings", "podStatusNotAsked", { n: skipped })}
        </p>
      ) : null}
    </div>
  );
}

function TimelineRow({
  entry,
  showAbout,
  now,
}: {
  entry: TimelineEntry;
  showAbout: boolean;
  now: number;
}) {
  const t = useT();
  const tone = entry.fromStatus
    ? entry.warning
      ? "text-err"
      : "text-fg-mut"
    : entry.warning
      ? "text-warn"
      : "text-fg-fnt";
  return (
    <li className="grid grid-cols-[64px_8px_minmax(0,1fr)] items-baseline gap-2">
      <span className="font-mono text-fg-fnt">
        {entry.at === null ? "?" : clockOf(entry.at, now)}
      </span>
      <span className={cn("text-[9px]", tone)} aria-hidden="true">
        {entry.fromStatus ? "◆" : entry.warning ? "▲" : "●"}
      </span>
      <span className="min-w-0">
        <span className={cn("font-mono font-medium", tone)}>
          {entry.reason}
        </span>
        {/* Worded here, where the reader's language is: the container and
            the code are this app's words, the reason beside them is the
            cluster's and stays as written. */}
        {entry.exit ? (
          <span className={cn(entry.reason ? "ml-1" : "", "text-fg-mut")}>
            {t("readings", "containerExited", {
              container: entry.exit.container,
              code: entry.exit.code,
            })}
          </span>
        ) : null}
        {entry.fromStatus ? (
          <span className="ml-1 text-fg-fnt">
            {t("readings", "fromPodStatus")}
          </span>
        ) : null}
        {entry.message ? (
          <span className="ml-1 text-fg-mut">{entry.message}</span>
        ) : null}
        {showAbout ? (
          <span className="ml-1 font-mono text-fg-fnt">{entry.about.name}</span>
        ) : null}
        {entry.count > 1 ? (
          <span className="ml-1 text-fg-fnt">
            ×{entry.count}
            {entry.until !== null
              ? `, ${clockOf(entry.at ?? entry.until, now)} → ${clockOf(entry.until, now)}`
              : ""}
          </span>
        ) : null}
      </span>
    </li>
  );
}
