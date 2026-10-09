import type { ForwardNote, PodInfo } from "@/generated/types";
import { sayWords, type Saying } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { podPorts, PHASE_LABEL } from "./container-sequence";
import { ERROR_CODES, errorCode } from "./error-utils";

/** A note as the cluster's own words, kept whole, or as a sentence of ours. */
export function forwardNoteSaying(note: ForwardNote): string | Saying {
  switch (note.says) {
    case "said":
      return note.text;
    case "retrying":
      return {
        key: "forwardRetrying",
        values: { text: note.text, n: note.after_secs },
      };
    case "gaveUp":
      return {
        key: "forwardGaveUp",
        values: { text: note.text, n: note.attempts },
      };
    case "podGone":
      return { key: "forwardPodGone", values: { pod: note.pod } };
    case "waiting":
      return {
        key: "forwardWaiting",
        values: { pod: note.pod, kind: note.kind, name: note.name },
      };
    case "noReplacement":
      return {
        key: "forwardNoReplacement",
        values: { pod: note.pod, kind: note.kind, name: note.name },
      };
    case "searchFailed":
      return {
        key: "forwardSearchFailed",
        values: { pod: note.pod, text: note.text },
      };
    case "moved":
      return { key: "forwardMoved", values: { from: note.from } };
    case "noStream":
      return { key: "forwardNoStream" };
    case "listenerFailed":
      return { key: "forwardListenerFailed", values: { text: note.text } };
  }
}

export function forwardNoteWords(
  note: ForwardNote | null | undefined,
  t: T
): string | null {
  if (!note) return null;
  const said = forwardNoteSaying(note);
  return typeof said === "string" ? said : sayWords(said, t);
}

/** Below this, listening needs administrator rights on Linux and macOS. */
export const PRIVILEGED_BELOW = 1024;

/** 80 becomes 8080 and 443 becomes 8443, the numbers people already type. */
const LIFT = 8000;

/**
 * The local port a forward to `remote` offers by default: the same number
 * where a normal user may listen on it, lifted where not, and moved past
 * ports this app is already forwarding.
 */
export function suggestedLocalPort(
  remote: number,
  taken: ReadonlySet<number>
): number {
  let port = remote < PRIVILEGED_BELOW ? remote + LIFT : remote;
  while (taken.has(port) && port < 65535) port += 1;
  return port;
}

/** Why a start failed on this machine rather than in the cluster, with the fix. */
export interface LocalPortProblem {
  port: number;
  suggestion: number;
  says: string;
}

export function localPortProblem(
  error: unknown,
  port: number,
  taken: ReadonlySet<number>,
  t: T
): LocalPortProblem | null {
  const code = errorCode(error);
  if (code === ERROR_CODES.LOCAL_PORT_PRIVILEGED) {
    const suggestion = suggestedLocalPort(port, taken);
    return {
      port,
      suggestion,
      says: t("activity", "localPortPrivileged", { port, suggestion }),
    };
  }
  if (code === ERROR_CODES.LOCAL_PORT_IN_USE) {
    const suggestion = suggestedLocalPort(port + 1, new Set([...taken, port]));
    return {
      port,
      suggestion,
      says: t("activity", "localPortInUse", { port, suggestion }),
    };
  }
  return null;
}

/** One port a forward could be aimed at. */
export interface ForwardPort {
  port: number;
  name: string | null;
  protocol: string;
  /** Which container offers it, where more than one does. */
  owner?: string;
}

/** The pod's ports, app containers first, owners named only where they differ. */
export function podForwardPorts(pod: PodInfo): ForwardPort[] {
  const all = podPorts(pod);
  const several = new Set(all.map((entry) => entry.container.name)).size > 1;
  return all.map(({ container, port }) => ({
    port: port.containerPort,
    name: port.name,
    protocol: port.protocol,
    owner: several
      ? [container.name, PHASE_LABEL[container.phase]].filter(Boolean).join(" ")
      : undefined,
  }));
}
