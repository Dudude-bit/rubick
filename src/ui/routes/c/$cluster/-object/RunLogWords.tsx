import type { ContainerInfo } from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import { useT } from "@/i18n/useT";
import { useRunLog, type RunLog } from "./useRunLog";

type RunLogSaying = Record<RunLog, keyof typeof en.readings>;

const FAILED: RunLogSaying = {
  kept: "failedRunInLogs",
  asking: "failedRunLogAsking",
  empty: "failedRunLogEmpty",
  gone: "failedRunLogGone",
  unread: "failedRunLogUnread",
};

const SAID: Record<"failed" | "exited" | "shell" | "finished", RunLogSaying> = {
  failed: FAILED,
  exited: { ...FAILED, kept: "logsPrintedBeforeExit" },
  shell: { ...FAILED, kept: "shellAnswerInFailedRun" },
  finished: {
    kept: "finishedLogComplete",
    asking: "finishedLogAsking",
    empty: "finishedLogEmpty",
    gone: "finishedLogGone",
    unread: "finishedLogUnread",
  },
};

/** What the Logs tab will find of a container's last run, asked of the node rather than promised. */
export function RunLogWords({
  pod,
  namespace,
  container,
  run,
}: {
  pod: string;
  namespace: string;
  container: ContainerInfo;
  run: keyof typeof SAID;
}) {
  const t = useT();
  return t("readings", SAID[run][useRunLog(pod, namespace, container)]);
}
