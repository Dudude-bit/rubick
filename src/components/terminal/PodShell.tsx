import { useMemo, type ReactNode } from "react";

import { containerColors } from "@/components/logs/container-colors";
import {
  PHASE_LABEL,
  containerSucceeded,
  podContainers,
} from "@/lib/container-sequence";
import { lastTermination, terminationWhen } from "@/lib/pod-status";
import type { ContainerInfo, PodInfo } from "@/generated/types";

import { PodTerminal } from "./PodTerminal";

/**
 * The Shell tab: a chooser, and the session it chose.
 *
 * A shell is not an action like Restart, done once and reported on. It is
 * somewhere a person sits, with a live process on the other end, and it wants
 * the window — which is why it is a surface tab rather than a 500px box grown
 * out of the bottom of a page that scrolls. Everything here is wiring:
 * `PodTerminal` still owns the session and every way one can end.
 */

/** Waiting reasons that mean "not yet", rather than "no". */
const NOT_STARTED = new Set([
  "podinitializing",
  "containercreating",
  "creating",
]);

/**
 * Why a shell cannot attach to this container, or nothing if it can.
 *
 * The container stays on the chooser either way, struck out and carrying the
 * reason: a container that silently is not on the list makes the reader
 * wonder whether they misremembered its name, and the answer to "why can I
 * not shell into `prepare`" is a fact about `prepare`, not an absence.
 */
function whyNoShell(container: ContainerInfo): string | null {
  const { state } = container;
  if (state.type === "running") return null;
  if (state.type === "terminated") {
    return state.termination.exitCode === 0
      ? "finished, nothing to attach to"
      : `exited ${state.termination.exitCode}, nothing to attach to`;
  }
  if (state.type === "waiting") {
    const reason = state.reason ?? "";
    if (NOT_STARTED.has(reason.toLowerCase())) return "has not started";
    if (container.lastTerminated) return "not running between restarts";
    return reason ? `not running · ${reason}` : "not running";
  }
  return "state unknown, nothing to attach to";
}

/** `whitespace-nowrap` because a container name broken across two lines
 *  with a hyphen reads as two names. */
function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap font-mono text-fg-mid">{children}</span>
  );
}

/** "a", "a and b", "a, b and c" — in the pod's own names, in the pod's font. */
function names(list: readonly string[]): ReactNode {
  return list.map((name, index) => (
    <span key={name}>
      {index > 0 && (index === list.length - 1 ? " and " : ", ")}
      <Mono>{name}</Mono>
    </span>
  ));
}

const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six"];

function count(n: number): string {
  return COUNT_WORD[n] ?? String(n);
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
function noShell(pod: PodInfo): NoShell {
  const headline = "No container is running to attach to";
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
        ? `which has failed ${blocker.restartCount} times`
        : death && death.exitCode !== 0
          ? `which exited ${death.exitCode}`
          : "which has not finished";
    const unstarted = app.filter((c) => c.state.type !== "terminated");
    const ran = init.filter(
      (c) => c.name !== blocker.name && c.state.type === "terminated"
    );
    return {
      headline,
      hint: death
        ? "What the shell would have told you is in the log of the run that failed."
        : null,
      logs: death
        ? { container: blocker.name, label: `Read ${blocker.name}'s last run` }
        : null,
      body: (
        <>
          The pod is still in init and stopped on <Mono>{blocker.name}</Mono>,{" "}
          {failure}.{" "}
          {unstarted.length > 0 && (
            <>
              {names(unstarted.map((c) => c.name))}{" "}
              {unstarted.length === 1 ? "has" : "have"} not started
              {ran.length > 0 ? ", and " : " — "}
            </>
          )}
          {ran.length > 0 && (
            <>
              {names(ran.map((c) => c.name))},{" "}
              {ran.length === 1
                ? "the init container that did run,"
                : `the ${count(ran.length)} init containers that did run,`}{" "}
              {ran.length === 1 ? "has" : "have"} already exited —{" "}
            </>
          )}
          a shell needs a live process on the other end.
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
      logs: { container: last.name, label: `Read ${last.name}'s log` },
      body: (
        <>
          Every container in this pod has exited; <Mono>{last.name}</Mono> was
          the last{when ? `, ${when}` : ""}. A shell needs a live process on the
          other end, and this pod has none left — what they printed is all that
          is still here.
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
      ? { container: crashed.name, label: `Read ${crashed.name}'s last run` }
      : null,
    body: (
      <>
        {waiting ? (
          <>
            <Mono>{waiting.name}</Mono> has not started
            {reason ? (
              <>
                {" — the kubelet is holding it at "}
                <Mono>{reason}</Mono>
              </>
            ) : null}
            .{" "}
          </>
        ) : (
          <>
            This pod is <Mono>{pod.status.display}</Mono>, and none of its
            containers is running.{" "}
          </>
        )}
        A shell needs a live process on the other end.
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
            ? "Debug with a copy of this pod"
            : "Debug with an ephemeral container"}
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
  const containers = useMemo(() => podContainers(pod), [pod]);
  const colors = useMemo(
    () => containerColors(containers.map((c) => c.name)),
    [containers]
  );

  const attachable = containers.filter((c) => whyNoShell(c) === null);
  // A chosen container is kept even once it dies: the terminal's own banner
  // says what happened to it, where quietly re-pointing at a sibling would
  // hand the reader another container's prompt under the name they picked.
  const chosen = container
    ? (containers.find((c) => c.name === container) ?? null)
    : null;
  const target =
    chosen ??
    (ended
      ? null
      : (attachable.find((c) => c.phase === "app") ?? attachable[0] ?? null));

  const hollow = attachable.length === 0 ? noShell(pod) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {attachable.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Container to attach a shell to"
          data-testid="shell-chooser"
          className="flex flex-none flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-2 py-1 text-[11px]"
        >
          {containers.map((c) => {
            const why = whyNoShell(c);
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
                    : `Attach a shell to ${c.name}, and end the one that is open`
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
        <Hollow headline="No shell is attached">
          <p className="text-xs text-fg-mut">
            The session was ended. Choosing a container above opens a new one —
            nothing is running here in the meantime.
          </p>
        </Hollow>
      )}
    </div>
  );
}
