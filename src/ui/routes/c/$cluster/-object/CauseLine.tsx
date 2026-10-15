import {
  CircleDashed,
  PackageX,
  RotateCcw,
  ServerOff,
  Unplug,
} from "lucide-react";

import { useMemo } from "react";

import type { PodCause, PodInfo, SharedCause } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { useLastPassed } from "@/hooks/useNow";
import {
  causeWords,
  currentCause,
  kubeletWarned,
  podsShare,
  type CauseWords,
} from "@/lib/pod-cause";
import { causeDeadlines, workloadCause } from "@/lib/share/pod-status";
import type { StopCause } from "@/lib/service-health";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { useCauseEvidence, useCauseWarnings } from "./useCauseEvidence";

/** The mark a cause leads with, by what it is. */
function CauseMark({
  cause,
  className,
}: {
  cause: PodCause;
  className: string;
}) {
  switch (cause.says) {
    case "exits":
      return <RotateCcw className={className} aria-hidden="true" />;
    case "unplaced":
      return <ServerOff className={className} aria-hidden="true" />;
    case "blocked":
      return <PackageX className={className} aria-hidden="true" />;
    case "notReady":
      return <CircleDashed className={className} aria-hidden="true" />;
    case "creating":
      return <Unplug className={className} aria-hidden="true" />;
  }
}

/** The evidence after a cause's sentence: the words quoted, and what was not read. */
export function CauseEvidence({
  words,
  inline = false,
}: {
  words: CauseWords;
  inline?: boolean;
}) {
  const Line = inline ? "span" : "p";
  return (
    <>
      {words.quote && (
        <Line className={inline ? undefined : "mt-0.5 min-w-0"}>
          {inline && " "}
          <span className="text-fg-mut">{words.quote.label}</span>{" "}
          <span className="font-mono wrap-break-word text-fg">
            {words.quote.text}
          </span>
        </Line>
      )}
      {words.note && (
        <Line className={cn("text-fg-fnt", !inline && "mt-0.5")}>
          {inline && " "}
          {words.note}
        </Line>
      )}
    </>
  );
}

/**
 * A pod's cause: the mark and colour of what happened, the sentence, then
 * the evidence. Every surface that leads with a pod's trouble draws it
 * through this, or through {@link causeWords} where it has only a string.
 */
export function CauseLine({
  cause,
  compact = false,
  className,
}: {
  cause: PodCause;
  /** One run of text, for a row that clamps it. */
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const words = causeWords(cause, t);
  const tone = TONE_TEXT[words.tone];
  if (compact)
    return (
      <span className={className} data-testid="cause-line">
        <CauseMark
          cause={cause}
          className={cn("mr-1 inline h-2.5 w-2.5 align-[-1px]", tone)}
        />
        <span className={tone}>{words.sentence}.</span>
        <CauseEvidence words={words} inline />
      </span>
    );
  return (
    <div
      className={cn("flex items-start gap-2 text-xs", className)}
      data-testid="cause-line"
    >
      <CauseMark
        cause={cause}
        className={cn("mt-0.5 h-3 w-3 flex-none", tone)}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", tone)}>{words.sentence}.</p>
        <CauseEvidence words={words} />
      </div>
    </div>
  );
}

/** Where a Service's traffic stops, then the cause its pods share, drawn as theirs. */
export function StopCauseLine({ cause }: { cause: StopCause }) {
  const t = useT();
  return (
    <>
      <span className="text-fg-mut">
        {cause.lead}: {podsShare(cause.shared.pods, cause.shared.of, t)}{" "}
      </span>
      <CauseLine cause={cause.shared.cause} compact />
    </>
  );
}

/** A pod's cause with the last words of the run it names, for a page or peek that shows one pod. */
export function PodCauseLine({
  pod,
  cause,
  warnedOnly = false,
  className,
}: {
  pod: { name: string; namespace: string };
  cause: PodCause;
  /** Told only if its kubelet's warnings say it is trouble. */
  warnedOnly?: boolean;
  className?: string;
}) {
  const read = useCauseEvidence(pod, cause) ?? cause;
  const told = warnedOnly ? kubeletWarned(read) : read;
  return told && <CauseLine cause={told} className={className} />;
}

/** A workload's cause as its pods tell it: how many share it, then the cause. */
export function PodsCauseLine({
  shared,
  namespace,
  warnedOnly = false,
  className,
}: {
  shared: SharedCause;
  namespace: string;
  /** Told only if its kubelet's warnings say it is trouble. */
  warnedOnly?: boolean;
  className?: string;
}) {
  const t = useT();
  const read = useCauseWarnings(namespace, currentCause(shared.cause));
  const cause = warnedOnly ? kubeletWarned(read) : read;
  if (!cause) return null;
  return (
    <p className={cn("text-xs", className)} data-testid="pods-cause">
      <span className="text-fg-mut">
        {podsShare(shared.pods, shared.of, t)}{" "}
      </span>
      <CauseLine cause={cause} compact />
    </p>
  );
}

/**
 * The cause a workload's own pods share, read from the pods it holds, or
 * nothing where it is settled or they are unread: the page and the peek of
 * every workload kind tell it this way.
 */
export function WorkloadPodsCause({
  pods,
  settled,
  namespace,
  className,
}: {
  pods: readonly PodInfo[] | null | undefined;
  settled: boolean;
  namespace: string;
  className?: string;
}) {
  const passed = useLastPassed(
    pods && !settled ? pods.flatMap(causeDeadlines) : []
  );
  const told = useMemo(
    () => (pods ? workloadCause(pods, passed) : null),
    [pods, passed]
  );
  if (!told || settled) return null;
  return (
    <PodsCauseLine
      shared={told.shared}
      namespace={namespace}
      warnedOnly={told.warnedOnly}
      className={className}
    />
  );
}
