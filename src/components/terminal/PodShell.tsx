import { useMemo, type ReactNode } from "react";

import { containerColors } from "@/components/logs/container-colors";
import {
  PHASE_LABEL,
  containerSucceeded,
  podContainers,
  shellTargets,
  whyNoShell,
} from "@/lib/container-sequence";
import { lastTermination, terminationWhen } from "@/lib/pod-status";
import type { PodInfo } from "@/generated/types";

import { PodTerminal } from "./PodTerminal";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import type { T } from "@/i18n/useT";

/**
 * The Shell tab: a chooser, and the session it chose.
 *
 * A shell is not an action like Restart, done once and reported on. It is
 * somewhere a person sits, with a live process on the other end, and it wants
 * the window — which is why it is a surface tab rather than a 500px box grown
 * out of the bottom of a page that scrolls. Everything here is wiring:
 * `PodTerminal` still owns the session and every way one can end.
 */

/** `whitespace-nowrap` because a container name broken across two lines
 *  with a hyphen reads as two names. */
function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap font-mono text-fg-mid">{children}</span>
  );
}

/** "a", "a and b", "a, b and c" — in the pod's own names, in the pod's font. */
function names(list: readonly string[], t: T): ReactNode {
  return list.map((name, index) => (
    <span key={name}>
      {index > 0 &&
        (index === list.length - 1
          ? t("action", "listAnd")
          : t("action", "listComma"))}
      <Mono>{name}</Mono>
    </span>
  ));
}

interface NoShell {
  headline: string;
  body: ReactNode;
  /** The second paragraph, where there is one worth saying. */
  hint: string | null;
  /** The container whose log holds what the shell would have told you. */
  logs: { container: string; label: string } | null;
}

/**
 * Why there is nothing to attach to, in the pod's own words and numbers.
 *
 * This is the state a person actually meets here, because the reason to want
 * a shell is usually that something is broken, and when it is broken enough
 * there is no shell to give. So it says why, and hands over the two things
 * that do work: the log of the run that failed, and Debug.
 */
function noShell(pod: PodInfo, t: T): NoShell {
  const headline = t("empty", "noContainerToAttach");
  const all = podContainers(pod);
  const init = all.filter((c) => c.phase === "init");
  const app = all.filter((c) => c.phase !== "init");

  // The first init container that has not succeeded is what the whole pod is
  // waiting on — every container after it is either queued or has never run.
  const blocker = init.find((c) => !containerSucceeded(c));
  if (blocker) {
    const death = lastTermination(blocker);
    const failure =
      blocker.restartCount > 0
        ? t("empty", "whichFailedTimes", { n: blocker.restartCount })
        : death && death.exitCode !== 0
          ? t("empty", "whichExited", { code: death.exitCode })
          : t("empty", "whichHasNotFinished");
    const unstarted = app.filter((c) => c.state.type !== "terminated");
    const ran = init.filter(
      (c) => c.name !== blocker.name && c.state.type === "terminated"
    );
    return {
      headline,
      hint: death ? t("empty", "shellAnswerIsInTheLog") : null,
      logs: death
        ? {
            container: blocker.name,
            label: t("action", "readLastRunOf", { name: blocker.name }),
          }
        : null,
      body: (
        <>
          {parts(t("empty", "podStoppedInInit", { failure }), {
            container: <Mono>{blocker.name}</Mono>,
          })}{" "}
          {unstarted.length > 0 && (
            <>
              {parts(t("empty", "haveNotStarted", { n: unstarted.length }), {
                names: names(
                  unstarted.map((c) => c.name),
                  t
                ),
              })}{" "}
            </>
          )}
          {ran.length > 0 && (
            <>
              {parts(
                t("empty", "initContainersAlreadyExited", { n: ran.length }),
                {
                  names: names(
                    ran.map((c) => c.name),
                    t
                  ),
                }
              )}{" "}
            </>
          )}
          {t("empty", "shellNeedsLiveProcess")}
        </>
      ),
    };
  }

  const dead = all.filter((c) => c.state.type === "terminated");
  if (dead.length === all.length && all.length > 0) {
    const last = dead[dead.length - 1];
    const death = lastTermination(last);
    const when = death ? terminationWhen(death) : null;
    return {
      headline,
      hint: null,
      logs: {
        container: last.name,
        label: t("action", "readLogOf", { name: last.name }),
      },
      body: (
        <>
          {parts(
            t("empty", "everyContainerExited", {
              when: when ? `, ${when}` : "",
            }),
            { container: <Mono>{last.name}</Mono> }
          )}{" "}
          {t("empty", "shellNeedsLiveProcessNoneLeft")}
        </>
      ),
    };
  }

  const waiting = all.find((c) => c.state.type === "waiting");
  const reason =
    waiting?.state.type === "waiting" ? (waiting.state.reason ?? null) : null;
  const crashed = all.find((c) => lastTermination(c) !== null);
  return {
    headline,
    hint: null,
    logs: crashed
      ? {
          container: crashed.name,
          label: t("action", "readLastRunOf", { name: crashed.name }),
        }
      : null,
    body: (
      <>
        {waiting ? (
          <>
            {reason
              ? parts(t("empty", "containerHeldAt"), {
                  container: <Mono>{waiting.name}</Mono>,
                  reason: <Mono>{reason}</Mono>,
                })
              : parts(t("empty", "containerHasNotStarted"), {
                  container: <Mono>{waiting.name}</Mono>,
                })}{" "}
          </>
        ) : (
          <>
            {parts(t("empty", "podIsStatusNoneRunning"), {
              status: <Mono>{pod.status.display}</Mono>,
            })}{" "}
          </>
        )}
        {t("empty", "shellNeedsLiveProcess")}
      </>
    ),
  };
}

function Hollow({
  headline,
  children,
}: {
  headline: string;
  children: ReactNode;
}) {
  return (
    <div className="max-w-[62ch] px-3 pb-12 pt-11" data-testid="shell-hollow">
      <h3 className="mb-1.5 text-[13px] font-medium text-fg">{headline}</h3>
      {children}
    </div>
  );
}

function HollowLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-xs text-info hover:underline"
    >
      {children}
    </button>
  );
}

/** A pod that has run its course: an ephemeral container has nowhere to land. */
const FINISHED = new Set(["succeeded", "failed"]);

function NoShellState({
  state,
  finished,
  onOpenLogs,
  onDebug,
}: {
  state: NoShell;
  finished: boolean;
  onOpenLogs: (container: string) => void;
  onDebug: () => void;
}) {
  const t = useT();
  const logs = state.logs;
  return (
    <Hollow headline={state.headline}>
      <p className="mb-3.5 text-xs text-fg-mut">{state.body}</p>
      {state.hint && <p className="mb-3.5 text-xs text-fg-mut">{state.hint}</p>}
      <div className="flex flex-wrap items-center gap-4">
        {logs && (
          <HollowLink onClick={() => onOpenLogs(logs.container)}>
            {logs.label}
          </HollowLink>
        )}
        {/* An ephemeral container is added to a pod that still exists; on one
            that has finished, the dialog's other half — a copy of the pod with
            the failing piece taken out — is the thing that works. */}
        <HollowLink onClick={onDebug}>
          {finished
            ? t("action", "debugWithCopy")
            : t("action", "debugWithEphemeral")}
        </HollowLink>
      </div>
    </Hollow>
  );
}

export interface PodShellProps {
  pod: PodInfo;
  /**
   * The container the reader chose, `null` for "whichever can take one" and
   * for a session the reader has ended — the two are told apart by `ended`,
   * because re-attaching to a shell somebody just closed is not a tab, it is
   * a loop.
   */
  container: string | null;
  ended: boolean;
  onChoose: (container: string) => void;
  /** Opens the Logs tab on this container, on the run that failed. */
  onOpenLogs: (container: string) => void;
  onDebug: () => void;
  onEnd: () => void;
}

export function PodShell({
  pod,
  container,
  ended,
  onChoose,
  onOpenLogs,
  onDebug,
  onEnd,
}: PodShellProps) {
  const t = useT();
  const containers = useMemo(() => podContainers(pod), [pod]);
  const colors = useMemo(
    () => containerColors(containers.map((c) => c.name)),
    [containers]
  );

  // Phase order, so the shell that opens by itself is the reader's own
  // container and a sidecar is only picked when nothing else can take one.
  // The chooser above stays in run order — there, position is what explains
  // a container that never got a turn.
  const attachable = useMemo(() => shellTargets(pod), [pod]);
  // A chosen container is kept even once it dies: the terminal's own banner
  // says what happened to it, where quietly re-pointing at a sibling would
  // hand the reader another container's prompt under the name they picked.
  const chosen = container
    ? (containers.find((c) => c.name === container) ?? null)
    : null;
  const target = chosen ?? (ended ? null : (attachable[0] ?? null));

  const hollow = attachable.length === 0 ? noShell(pod, t) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {attachable.length > 0 && (
        <div
          role="radiogroup"
          aria-label={t("action", "containerToAttach")}
          data-testid="shell-chooser"
          className="flex flex-none flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-2 py-1 text-[11px]"
        >
          {containers.map((c) => {
            const why = whyNoShell(c, t);
            const selected = target?.name === c.name;
            const phase = PHASE_LABEL[c.phase];
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!!why && !selected}
                title={
                  why
                    ? `${c.name} — ${why}`
                    : t("action", "attachShellTo", { name: c.name })
                }
                onClick={() => onChoose(c.name)}
                className={`inline-flex items-center gap-1.5 rounded py-0.5 pl-1 pr-1.5 ${
                  selected
                    ? "bg-sel text-fg"
                    : why
                      ? "cursor-default text-fg-fnt"
                      : "text-fg-mut hover:bg-hover"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-3 w-[3px] rounded-sm ${why ? "opacity-25" : ""}`}
                  style={{ background: colors.get(c.name) }}
                />
                <span className={why ? "line-through" : undefined}>
                  {c.name}
                </span>
                {phase && (
                  <span className="text-[9px] uppercase tracking-[0.04em] text-fg-fnt">
                    {phase}
                  </span>
                )}
                {why && <span className="text-fg-fnt">· {why}</span>}
              </button>
            );
          })}
        </div>
      )}

      {target ? (
        // Keyed by the container, because opening a session is the one thing
        // `PodTerminal` does on mount: switching the chooser has to close the
        // old shell and open a new one, not re-label the old one.
        <div className="min-h-0 flex-1">
          <PodTerminal
            key={`${pod.namespace}/${pod.name}/${target.name}`}
            podName={pod.name}
            namespace={pod.namespace}
            containerName={target.name}
            onClose={onEnd}
          />
        </div>
      ) : hollow ? (
        <NoShellState
          state={hollow}
          finished={FINISHED.has(pod.status.phase.toLowerCase())}
          onOpenLogs={onOpenLogs}
          onDebug={onDebug}
        />
      ) : (
        <Hollow headline={t("empty", "noShellAttached")}>
          <p className="text-xs text-fg-mut">
            {t("empty", "shellSessionEnded")}
          </p>
        </Hollow>
      )}
    </div>
  );
}
