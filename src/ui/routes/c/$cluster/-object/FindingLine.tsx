import { Fragment } from "react";
import { ResourceMessage } from "@/components/object/ResourceMessage";
import type { PodInfo, ProbeFailure } from "@/generated/types";
import type { Finding } from "@/lib/governance";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { podContainers } from "@/lib/container-sequence";
import { lastTermination } from "@/lib/pod-status";
import { cn } from "@/lib/utils";
import { ExitWords } from "./ExitAgo";
import { closedSentence } from "./problem";

const FINDING_TONE: Record<Finding["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  // The honest one. `disruptionsAllowed: 0` on a budget that is exactly met
  // is a fact the reader wants and is not a fault, so it reads in the same
  // foreground every other stated fact on the page reads in.
  neutral: "text-fg-mut",
};

/** The readings that caused a finding, in its tone, so the number is not a plain word in another column. */
export function FindingEvidence({ finding }: { finding: Finding }) {
  const t = useT();
  if (!finding.evidence?.length) return null;
  return (
    <>
      {finding.evidence.map(({ key, label, current, target }, i) => (
        <Fragment key={key}>
          {i > 0 && <span className="text-fg-fnt"> · </span>}
          <span
            data-testid="finding-evidence"
            className={cn("font-mono font-medium", FINDING_TONE[finding.tone])}
          >
            {t("readings", "hpaMetricOverTarget", {
              metric: label,
              current: current ?? "",
              target,
            })}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** A state worth a sentence, under the rows that could not carry it. */
export function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1.5">
      <p className={cn("text-xs font-medium", FINDING_TONE[finding.tone])}>
        {finding.title}
      </p>
      <p className="text-caption text-fg-fnt">
        <FindingDetail finding={finding} />
      </p>
    </div>
  );
}

/** A finding's sentence and then its readings, the sentence closed before them. */
export function FindingDetail({ finding }: { finding: Finding }) {
  if (!finding.evidence?.length) return <>{finding.detail}</>;
  return (
    <>
      {closedSentence(finding.detail)} <FindingEvidence finding={finding} />
    </>
  );
}

/**
 * A container restarted while its probe fails, as the pod's page and its
 * peek say it: how the last run ended, the kubelet's words closed as a
 * sentence, and the link between them named as the guess it is.
 */
export function ProbeFailureDetail({
  pod,
  failure,
}: {
  pod: PodInfo;
  failure: ProbeFailure;
}) {
  const t = useT();
  const container = podContainers(pod).find(
    ({ name }) => name === failure.container
  );
  const n = container?.restartCount ?? failure.restarts;
  const last = container ? lastTermination(container) : null;
  return (
    <>
      {last
        ? parts(t("empty", "crashRestartsWithLastRun", { n }), {
            how: <ExitWords termination={last} between=", " />,
          })
        : t("empty", "crashRestartsNoLastRun", { n })}{" "}
      <ResourceMessage
        message={closedSentence(failure.said)}
        subject={{ kind: "Pod", name: pod.name, namespace: pod.namespace }}
      />
      {failure.probe === "liveness" && (
        <> {t("empty", "probeLikelyRestartCause")}</>
      )}
    </>
  );
}
